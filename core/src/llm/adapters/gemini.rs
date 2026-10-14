//! Adapter Google Gemini (`generateContent` / `streamGenerateContent?alt=sse`).
//!
//! Nota de contrato: o wire do Gemini **não tem id de tool call**. Para caber no
//! canônico (que tem), sintetizamos `id = name` na ida e reconstruímos o `name`
//! pelo `id` na volta. É uma bijeção enquanto o modelo não chamar a mesma tool
//! duas vezes no mesmo turno — caso em que o sufixo `#index` desempata.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;

use super::super::canonical::*;
use super::super::sse::SseDecoder;
use super::http_client;
use super::openai_compat::classify_error;
use crate::config::Wire;

pub struct Gemini {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Gemini {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
        }
    }

    fn endpoint(&self, method: &str, stream: bool) -> String {
        let base = self.base_url.trim_end_matches('/');
        let base = if base.ends_with("/v1beta") || base.ends_with("/v1") {
            base.to_string()
        } else {
            format!("{base}/v1beta")
        };
        let mut url = format!(
            "{base}/models/{}:{method}?key={}",
            self.model,
            urlencoding::encode(&self.api_key)
        );
        if stream {
            url.push_str("&alt=sse");
        }
        url
    }

    fn body(&self, req: &ChatRequest) -> Value {
        let (system, contents) = to_wire(&req.messages);
        let mut body = json!({ "contents": contents });
        if let Some(system) = system {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
        }
        if !req.tools.is_empty() {
            let declarations: Vec<Value> = req
                .tools
                .iter()
                .filter_map(|t| t.get("function"))
                .map(|f| {
                    json!({
                        "name": f.get("name"),
                        "description": f.get("description"),
                        "parameters": f.get("parameters").cloned().unwrap_or(json!({"type":"object"})),
                    })
                })
                .collect();
            body["tools"] = json!([{ "functionDeclarations": declarations }]);
        }
        let mut cfg = serde_json::Map::new();
        if let Some(t) = req.temperature {
            cfg.insert("temperature".into(), json!(t));
        }
        if let Some(m) = req.max_tokens {
            cfg.insert("maxOutputTokens".into(), json!(m));
        }
        if req.json_mode {
            cfg.insert("responseMimeType".into(), json!("application/json"));
        }
        if !cfg.is_empty() {
            body["generationConfig"] = Value::Object(cfg);
        }
        body
    }
}

/// Canônico → `(systemInstruction, contents)`.
pub fn to_wire(messages: &[Msg]) -> (Option<String>, Vec<Value>) {
    let mut system: Option<String> = None;
    let mut contents: Vec<Value> = Vec::new();

    for msg in messages {
        match msg {
            Msg::System(text) => {
                if system.is_none() {
                    system = Some(text.clone());
                }
            }
            Msg::User(text) => {
                contents.push(json!({ "role": "user", "parts": [{ "text": text }] }))
            }
            Msg::Assistant { text, tool_calls } => {
                let mut parts: Vec<Value> = Vec::new();
                if let Some(text) = text.as_deref().filter(|t| !t.is_empty()) {
                    parts.push(json!({ "text": text }));
                }
                for call in tool_calls {
                    let args: Value =
                        serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                    let mut fc_part =
                        json!({ "functionCall": { "name": call.name, "args": args } });
                    // Gemini 2.5 / 3+ exige thoughtSignature no wire de functionCall em multi-turn
                    let sig = call
                        .thought_signature
                        .as_deref()
                        .unwrap_or("skip_thought_signature_validator");
                    fc_part["thoughtSignature"] = json!(sig);
                    parts.push(fc_part);
                }
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            Msg::Tool { id, content } => {
                let name = id.split('#').next().unwrap_or(id);
                let response: Value =
                    serde_json::from_str(content).unwrap_or_else(|_| json!({ "text": content }));
                let part = json!({ "functionResponse": { "name": name, "response": response } });
                let merged = if let Some(last) = contents.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(parts) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                            let only_func =
                                parts.iter().all(|p| p.get("functionResponse").is_some());
                            if only_func {
                                parts.push(part.clone());
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !merged {
                    contents.push(json!({
                        "role": "user",
                        "parts": [part]
                    }));
                }
            }
        }
    }
    (system, contents)
}

/// GeminicResponse → canônico.
pub fn parse_response(body: &Value) -> Completion {
    let mut out = Completion::default();
    let mut text = String::new();
    if let Some(parts) = body
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
    {
        let mut index = 0usize;
        for part in parts {
            let is_thought = part
                .get("thought")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                if is_thought {
                    if let Some(ref mut r) = out.reasoning {
                        r.push_str(t);
                    } else {
                        out.reasoning = Some(t.to_string());
                    }
                } else {
                    text.push_str(t);
                }
            }
            if let Some(call) = part.get("functionCall") {
                if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                    let args = call.get("args").cloned().unwrap_or(json!({}));
                    let id = if index == 0 {
                        name.to_string()
                    } else {
                        format!("{name}#{index}")
                    };
                    let sig = part
                        .get("thoughtSignature")
                        .or_else(|| part.get("thought_signature"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    index += 1;
                    out.tool_calls.push(ToolCall {
                        id,
                        name: name.to_string(),
                        arguments: args.to_string(),
                        thought_signature: sig,
                    });
                }
            }
        }
    }
    if out.reasoning.is_none() {
        if let Some(thought) = body
            .pointer("/candidates/0/content/parts/0/thought")
            .and_then(|v| v.as_str())
        {
            out.reasoning = Some(thought.to_string());
        }
    }
    if !text.is_empty() {
        out.text = Some(text);
    }
    if let Some(usage) = body.get("usageMetadata") {
        let input = usage
            .get("promptTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let output = usage
            .get("candidatesTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        out.usage = Some((input, output));
    }
    out
}

#[async_trait]
impl LlmAdapter for Gemini {
    fn wire(&self) -> Wire {
        Wire::Gemini
    }

    fn capabilities(&self) -> Caps {
        Caps {
            streaming: true,
            tools: true,
            json_mode: true,
            reasoning_field: None,
        }
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn stream(&self, req: ChatRequest, tx: Sender<LlmEvent>) -> anyhow::Result<()> {
        let res = http_client()
            .post(self.endpoint("streamGenerateContent", true))
            .header("content-type", "application/json")
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("gemini_request:{e}"))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "gemini_http_{}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }

        use futures_util::StreamExt;
        let mut stream = res.bytes_stream();
        let mut decoder = SseDecoder::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("gemini_stream:{e}"))?;
            for event in decoder.push(&String::from_utf8_lossy(&chunk)) {
                let Some(body) = SseDecoder::json_of(&event) else {
                    continue;
                };
                let parsed = parse_response(&body);
                if let Some(text) = parsed.text {
                    let _ = tx.send(LlmEvent::Delta(text)).await;
                }
                for call in parsed.tool_calls {
                    let _ = tx.send(LlmEvent::ToolCall(call)).await;
                }
                if let Some((input, output)) = parsed.usage {
                    let _ = tx.send(LlmEvent::Usage { input, output }).await;
                }
            }
        }
        let _ = tx.send(LlmEvent::Done).await;
        Ok(())
    }

    async fn complete(&self, req: ChatRequest) -> anyhow::Result<Completion> {
        let res = http_client()
            .post(self.endpoint("generateContent", false))
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("gemini_request:{e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("gemini_json:{e}"))?;
        if !status.is_success() {
            return Err(anyhow::anyhow!("gemini_http_{}: {}", status.as_u16(), body));
        }
        Ok(parse_response(&body))
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let base = self.base_url.trim_end_matches('/');
        let base = if base.ends_with("/v1beta") {
            base.to_string()
        } else {
            format!("{base}/v1beta")
        };
        let res = http_client()
            .get(format!(
                "{base}/models?key={}",
                urlencoding::encode(&self.api_key)
            ))
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if !res.status().is_success() {
            anyhow::bail!("models_http_{}", res.status().as_u16());
        }
        let body: Value = res.json().await?;
        let mut out: Vec<ModelInfo> = body
            .get("models")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let raw = m.get("name").and_then(|v| v.as_str())?;
                        let id = raw.rsplit('/').next().unwrap_or(raw).to_string();
                        // Só modelos que suportam generateContent.
                        let methods = m
                            .get("supportedGenerationMethods")
                            .and_then(|v| v.as_array());
                        if let Some(methods) = methods {
                            if !methods
                                .iter()
                                .any(|x| x.as_str() == Some("generateContent"))
                            {
                                return None;
                            }
                        }
                        Some(ModelInfo::new(id))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    async fn test(&self) -> anyhow::Result<TestReport> {
        let started = Instant::now();
        let mut req = ChatRequest::new(self.model.clone(), vec![Msg::user("ping")]);
        req.max_tokens = Some(16);
        req.timeout_ms = 30_000;
        match self.complete(req).await {
            Ok(c) => Ok(TestReport {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                model: self.model.clone(),
                sample: c.text.unwrap_or_default().chars().take(120).collect(),
                code: None,
                detail: None,
            }),
            Err(e) => Ok(TestReport {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                model: self.model.clone(),
                sample: String::new(),
                code: Some(classify_error(&e.to_string())),
                detail: Some(e.to_string()),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_instruction_is_extracted() {
        let (system, contents) = to_wire(&[Msg::system("sys"), Msg::user("hi")]);
        assert_eq!(system.as_deref(), Some("sys"));
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
    }

    #[test]
    fn assistant_tool_calls_become_function_call_parts() {
        let (_s, contents) = to_wire(&[Msg::Assistant {
            text: None,
            tool_calls: vec![ToolCall::new("add_tracks", "add_tracks", r#"{"a":1}"#)],
        }]);
        assert_eq!(contents[0]["role"], "model");
        assert_eq!(
            contents[0]["parts"][0]["functionCall"]["name"],
            "add_tracks"
        );
        assert_eq!(contents[0]["parts"][0]["functionCall"]["args"]["a"], 1);
        assert_eq!(
            contents[0]["parts"][0]["thoughtSignature"],
            "skip_thought_signature_validator"
        );
    }

    #[test]
    fn to_wire_preserves_explicit_thought_signature() {
        let (_s, contents) = to_wire(&[Msg::Assistant {
            text: None,
            tool_calls: vec![ToolCall::new("get_track", "get_track", "{}")
                .with_thought_signature(Some("test_sig_123".into()))],
        }]);
        assert_eq!(contents[0]["parts"][0]["thoughtSignature"], "test_sig_123");
    }

    #[test]
    fn tool_result_uses_function_response_with_the_name_from_id() {
        let (_s, contents) = to_wire(&[Msg::tool("get_playlists", r#"{"ok":true}"#)]);
        let part = &contents[0]["parts"][0]["functionResponse"];
        assert_eq!(part["name"], "get_playlists");
        assert_eq!(part["response"]["ok"], true);
    }

    #[test]
    fn consecutive_tool_results_are_merged_into_a_single_turn() {
        let (_s, contents) = to_wire(&[
            Msg::tool("get_playlists", r#"{"ok":true}"#),
            Msg::tool("get_artist#1", r#"{"name":"miles"}"#),
        ]);
        assert_eq!(
            contents.len(),
            1,
            "deve ser mesclado num único turno de usuário"
        );
        assert_eq!(contents[0]["role"], "user");
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["functionResponse"]["name"], "get_playlists");
        assert_eq!(parts[1]["functionResponse"]["name"], "get_artist");
        assert_eq!(parts[1]["functionResponse"]["response"]["name"], "miles");
    }

    #[test]
    fn parses_text_and_usage() {
        let body = json!({
            "candidates": [{"content": {"parts": [{"text": "olá"}]}}],
            "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2}
        });
        let c = parse_response(&body);
        assert_eq!(c.text.as_deref(), Some("olá"));
        assert_eq!(c.usage, Some((7, 2)));
    }

    #[test]
    fn parses_function_call_and_synthesizes_ids() {
        let body = json!({
            "candidates": [{"content": {"parts": [
                {
                    "functionCall": {"name": "search_spotify", "args": {"q": "miles"}},
                    "thoughtSignature": "sig_abc"
                },
                {"functionCall": {"name": "search_spotify", "args": {"q": "coltrane"}}}
            ]}}]
        });
        let c = parse_response(&body);
        assert_eq!(c.tool_calls.len(), 2);
        assert_eq!(c.tool_calls[0].id, "search_spotify");
        assert_eq!(
            c.tool_calls[0].thought_signature.as_deref(),
            Some("sig_abc")
        );
        assert_eq!(c.tool_calls[1].id, "search_spotify#1");
        assert_eq!(c.tool_calls[1].name, "search_spotify");
        assert_eq!(c.tool_calls[1].thought_signature, None);
    }

    #[test]
    fn endpoint_includes_alt_sse_only_when_streaming() {
        let g = Gemini::new(
            "https://generativelanguage.googleapis.com",
            "k",
            "gemini-2.0-flash",
        );
        assert!(g
            .endpoint("streamGenerateContent", true)
            .contains("alt=sse"));
        assert!(!g.endpoint("generateContent", false).contains("alt=sse"));
        assert!(g
            .endpoint("generateContent", false)
            .contains("/v1beta/models/gemini-2.0-flash:generateContent"));
    }
}
