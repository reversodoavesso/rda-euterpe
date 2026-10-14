//! Adapter OpenAI-compat (o "contrato tradicional"): OpenAI, DeepSeek, Groq,
//! Together, OpenRouter, xAI, Mistral, vLLM, LM Studio e o provider `custom`.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;

use super::super::canonical::*;
use super::super::sse::{SseDecoder, SseEvent};
use super::http_client;
use crate::config::Wire;

pub struct OpenAiCompat {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub extra_body: Value,
    pub caps: Caps,
}

impl OpenAiCompat {
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<String>,
        model: impl Into<String>,
        headers: std::collections::BTreeMap<String, String>,
        extra_body: Value,
    ) -> Self {
        let caps = Caps {
            reasoning_field: Some("reasoning_content"),
            ..Caps::default()
        };
        Self {
            base_url: base_url.into(),
            api_key,
            model: model.into(),
            headers,
            extra_body,
            caps,
        }
    }

    fn endpoint(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        // Aceita base sem `/v1` (ex.: https://api.deepseek.com) como o SDK do Node.
        if base.ends_with("/v1") || base.ends_with("/openai") || base.ends_with("/openai/v1") {
            format!("{base}{path}")
        } else {
            format!("{base}/v1{path}")
        }
    }

    fn request(&self, url: &str) -> reqwest::RequestBuilder {
        let mut rb = http_client().post(url);
        if let Some(key) = self.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            rb = rb.bearer_auth(key);
        }
        for (k, v) in &self.headers {
            rb = rb.header(k, v);
        }
        rb
    }

    fn body(&self, req: &ChatRequest, stream: bool) -> Value {
        let mut body = json!({
            "model": req.model,
            "messages": to_wire_messages(&req.messages),
            "stream": stream,
        });
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(req.tools.clone());
            body["tool_choice"] = json!("auto");
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(m) = req.max_tokens {
            body["max_tokens"] = json!(m);
        }
        if req.json_mode {
            body["response_format"] = json!({ "type": "json_object" });
        }
        if let Some(extra) = self.extra_body.as_object() {
            for (k, v) in extra {
                body[k] = v.clone();
            }
        }
        body
    }
}

/// Converte as mensagens canônicas para o wire OpenAI.
pub fn to_wire_messages(messages: &[Msg]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| match m {
            Msg::System(text) => json!({ "role": "system", "content": text }),
            Msg::User(text) => json!({ "role": "user", "content": text }),
            Msg::Assistant { text, tool_calls } => {
                let mut obj = json!({ "role": "assistant" });
                // `content` é sempre presente; `null` quando só houve tool_calls
                // (é o que a API espera e o que o Node manda).
                obj["content"] = match text {
                    Some(t) => json!(t),
                    None => Value::Null,
                };
                if !tool_calls.is_empty() {
                    obj["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|tc| {
                                json!({
                                    "id": tc.id,
                                    "type": "function",
                                    "function": { "name": tc.name, "arguments": tc.arguments },
                                })
                            })
                            .collect(),
                    );
                }
                obj
            }
            Msg::Tool { id, content } => {
                json!({ "role": "tool", "tool_call_id": id, "content": content })
            }
        })
        .collect()
}

/// Lê a resposta não-streaming (também usado nos testes com `wiremock`).
pub fn parse_completion(body: &Value) -> Completion {
    let message = body.pointer("/choices/0/message");
    let mut out = Completion::default();
    if let Some(msg) = message {
        out.text = msg
            .get("content")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        out.reasoning = msg
            .get("reasoning_content")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            out.tool_calls = calls
                .iter()
                .filter_map(|c| {
                    let name = c
                        .pointer("/function/name")
                        .and_then(|v| v.as_str())?
                        .to_string();
                    Some(ToolCall::new(
                        c.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        name,
                        c.pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                    ))
                })
                .collect();
        }
    }
    if let Some(usage) = body.get("usage") {
        let input = usage
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let output = usage
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        out.usage = Some((input, output));
    }
    out
}

/// Acumulador de deltas de `tool_calls` (o wire manda por índice, fatiado).
#[derive(Default)]
pub struct ToolCallAccumulator {
    order: Vec<i64>,
    by_index: std::collections::HashMap<i64, (String, String, String)>,
}

impl ToolCallAccumulator {
    pub fn push(&mut self, delta: &Value) {
        let index = delta.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
        if !self.order.contains(&index) {
            self.order.push(index);
        }
        let entry = self.by_index.entry(index).or_default();
        if let Some(id) = delta.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                entry.0 = id.to_string();
            }
        }
        if let Some(name) = delta.pointer("/function/name").and_then(|v| v.as_str()) {
            entry.1.push_str(name);
        }
        if let Some(args) = delta
            .pointer("/function/arguments")
            .and_then(|v| v.as_str())
        {
            entry.2.push_str(args);
        }
    }

    pub fn finish(self) -> Vec<ToolCall> {
        let mut order = self.order;
        order.sort_unstable();
        order
            .into_iter()
            .filter_map(|i| {
                self.by_index
                    .get(&i)
                    .map(|(id, name, args)| ToolCall::new(id.clone(), name.clone(), args.clone()))
            })
            .collect()
    }
}

#[async_trait]
impl LlmAdapter for OpenAiCompat {
    fn wire(&self) -> Wire {
        Wire::OpenaiCompat
    }

    fn capabilities(&self) -> Caps {
        self.caps
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn stream(&self, req: ChatRequest, tx: Sender<LlmEvent>) -> anyhow::Result<()> {
        let res = self
            .request(&self.endpoint("/chat/completions"))
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req, true))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("openai_compat_request:{e}"))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "openai_compat_http_{}: {}",
                status.as_u16(),
                truncate(&body)
            ));
        }

        let mut bytes = res.bytes_stream();
        use futures_util::StreamExt;
        let mut decoder = SseDecoder::new();
        let mut pending: Vec<SseEvent> = Vec::new();
        let mut acc = ToolCallAccumulator::default();
        while let Some(chunk) = bytes.next().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("openai_compat_stream:{e}"))?;
            pending.extend(decoder.push(&String::from_utf8_lossy(&chunk)));
            for event in pending.drain(..) {
                if event.is_done() {
                    for call in acc.finish() {
                        let _ = tx.send(LlmEvent::ToolCall(call)).await;
                    }
                    let _ = tx.send(LlmEvent::Done).await;
                    return Ok(());
                }
                let Some(body) = SseDecoder::json_of(&event) else {
                    continue;
                };
                if let Some(delta) = body.pointer("/choices/0/delta") {
                    if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            let _ = tx.send(LlmEvent::Delta(text.to_string())).await;
                        }
                    }
                    if let Some(reasoning) = delta
                        .get(self.caps.reasoning_field.unwrap_or("reasoning_content"))
                        .and_then(|v| v.as_str())
                    {
                        if !reasoning.is_empty() {
                            let _ = tx.send(LlmEvent::Reasoning(reasoning.to_string())).await;
                        }
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                        for c in calls {
                            acc.push(c);
                        }
                    }
                }
                if let Some(usage) = body.get("usage") {
                    let input = usage
                        .get("prompt_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let output = usage
                        .get("completion_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    let _ = tx.send(LlmEvent::Usage { input, output }).await;
                }
            }
        }
        for event in decoder.finish() {
            if let Some(body) = SseDecoder::json_of(&event) {
                if let Some(text) = body
                    .pointer("/choices/0/delta/content")
                    .and_then(|v| v.as_str())
                {
                    let _ = tx.send(LlmEvent::Delta(text.to_string())).await;
                }
            }
        }
        for call in acc.finish() {
            let _ = tx.send(LlmEvent::ToolCall(call)).await;
        }
        let _ = tx.send(LlmEvent::Done).await;
        Ok(())
    }

    /// O loop agentic usa `stream:false` (paridade com o Node) — caminho próprio.
    async fn complete(&self, req: ChatRequest) -> anyhow::Result<Completion> {
        let res = self
            .request(&self.endpoint("/chat/completions"))
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req, false))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("openai_compat_request:{e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("openai_compat_json:{e}"))?;
        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "openai_compat_http_{}: {}",
                status.as_u16(),
                truncate(&body.to_string())
            ));
        }
        Ok(parse_completion(&body))
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let mut rb = http_client().get(self.endpoint("/models"));
        if let Some(key) = self.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            rb = rb.bearer_auth(key);
        }
        for (k, v) in &self.headers {
            rb = rb.header(k, v);
        }
        let res = rb.timeout(Duration::from_secs(20)).send().await?;
        if !res.status().is_success() {
            anyhow::bail!("models_http_{}", res.status().as_u16());
        }
        let body: Value = res.json().await?;
        let mut out: Vec<ModelInfo> = body
            .get("data")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let id = m.get("id").and_then(|v| v.as_str())?.to_string();
                        let mut info = ModelInfo::new(id);
                        info.name = m
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&info.id)
                            .to_string();
                        info.owned_by = m
                            .get("owned_by")
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        Some(info)
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

/// Traduz o erro cru em um código estável (`/providers/test` e debug).
pub fn classify_error(raw: &str) -> String {
    if raw.contains("_http_401") || raw.contains("_http_403") {
        "unauthorized".to_string()
    } else if raw.contains("_http_404") {
        "not_found".to_string()
    } else if raw.contains("_http_429") {
        "rate_limited".to_string()
    } else if raw.contains("_http_5") {
        "provider_error".to_string()
    } else if raw.contains("timeout") || raw.contains("timed out") {
        "timeout".to_string()
    } else if raw.contains("connect") || raw.contains("dns") || raw.contains("builder") {
        "unreachable".to_string()
    } else {
        "provider_test_failed".to_string()
    }
}

fn truncate(text: &str) -> String {
    text.chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_map_to_openai_wire() {
        let msgs = vec![
            Msg::system("sys"),
            Msg::user("hi"),
            Msg::Assistant {
                text: None,
                tool_calls: vec![ToolCall::new("c1", "get_playlists", "{}")],
            },
            Msg::tool("c1", "{\"ok\":true}"),
        ];
        let wire = to_wire_messages(&msgs);
        assert_eq!(wire[0], json!({"role":"system","content":"sys"}));
        assert_eq!(wire[1], json!({"role":"user","content":"hi"}));
        assert_eq!(wire[2]["content"], Value::Null);
        assert_eq!(
            wire[2]["tool_calls"][0]["function"]["name"],
            "get_playlists"
        );
        assert_eq!(
            wire[3],
            json!({"role":"tool","tool_call_id":"c1","content":"{\"ok\":true}"})
        );
    }

    #[test]
    fn parses_completion_with_tool_calls_and_reasoning() {
        let body = json!({
            "choices": [{"message": {
                "content": null,
                "reasoning_content": "thinking…",
                "tool_calls": [{"id":"a","type":"function","function":{"name":"get_artist","arguments":"{\"artist_id\":\"x\"}"}}]
            }}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3}
        });
        let c = parse_completion(&body);
        assert_eq!(c.text, None);
        assert_eq!(c.reasoning.as_deref(), Some("thinking…"));
        assert_eq!(c.tool_calls[0].name, "get_artist");
        assert_eq!(c.tool_calls[0].parsed_args()["artist_id"], "x");
        assert_eq!(c.usage, Some((10, 3)));
    }

    #[test]
    fn tool_call_deltas_accumulate_across_chunks() {
        let mut acc = ToolCallAccumulator::default();
        acc.push(&json!({"index":0,"id":"c1","function":{"name":"add_","arguments":"{\"ur"}}));
        acc.push(&json!({"index":0,"function":{"name":"tracks","arguments":"is\":[\"x\"]}"}}));
        acc.push(&json!({"index":1,"id":"c2","function":{"name":"get_artist","arguments":"{}"}}));
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "add_tracks");
        assert_eq!(calls[0].arguments, "{\"uris\":[\"x\"]}");
        assert_eq!(calls[1].name, "get_artist");
    }

    #[test]
    fn endpoint_handles_base_with_and_without_v1() {
        let mk = |base: &str| OpenAiCompat::new(base, None, "m", Default::default(), Value::Null);
        assert_eq!(
            mk("https://api.deepseek.com").endpoint("/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            mk("https://api.openai.com/v1").endpoint("/models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            mk("https://api.groq.com/openai/v1").endpoint("/models"),
            "https://api.groq.com/openai/v1/models"
        );
    }

    #[test]
    fn error_classification_is_stable() {
        assert_eq!(
            classify_error("openai_compat_http_401: bad key"),
            "unauthorized"
        );
        assert_eq!(
            classify_error("openai_compat_http_429: slow down"),
            "rate_limited"
        );
        assert_eq!(
            classify_error("openai_compat_http_500: oops"),
            "provider_error"
        );
        assert_eq!(classify_error("openai_compat_request: timeout"), "timeout");
        assert_eq!(classify_error("weird"), "provider_test_failed");
    }

    #[test]
    fn extra_body_is_merged_into_the_payload() {
        let adapter = OpenAiCompat::new(
            "https://x/v1",
            None,
            "m",
            Default::default(),
            json!({"top_k": 5}),
        );
        let body = adapter.body(&ChatRequest::new("m", vec![Msg::user("hi")]), false);
        assert_eq!(body["top_k"], 5);
        assert_eq!(body["stream"], false);
        assert!(body.get("tools").is_none());
    }
}
