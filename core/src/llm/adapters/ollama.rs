//! Adapter Ollama (e qualquer servidor com a API de chat do Ollama). Local,
//! sem chave. Aceita o formato OpenAI de tools, como o Ollama faz.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;

use super::super::canonical::*;
use super::http_client;
use super::openai_compat::classify_error;
use crate::config::Wire;

pub struct Ollama {
    pub base_url: String,
    pub model: String,
    /// Alguns forks (LM Studio) expõem `/v1/chat/completions`; nesse caso a base
    /// já termina em `/v1` e usamos o wire OpenAI em vez do nativo.
    pub prefer_openai_wire: bool,
}

impl Ollama {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        let base_url = base_url.into();
        let prefer_openai_wire = base_url.trim_end_matches('/').ends_with("/v1");
        Self {
            base_url,
            model: model.into(),
            prefer_openai_wire,
        }
    }

    fn body(&self, req: &ChatRequest, stream: bool) -> Value {
        let messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| match m {
                Msg::System(text) => json!({ "role": "system", "content": text }),
                Msg::User(text) => json!({ "role": "user", "content": text }),
                Msg::Assistant { text, tool_calls } => {
                    let mut obj = json!({ "role": "assistant", "content": text.clone().unwrap_or_default() });
                    if !tool_calls.is_empty() {
                        obj["tool_calls"] = Value::Array(
                            tool_calls
                                .iter()
                                .map(|tc| {
                                    json!({ "function": { "name": tc.name, "arguments": serde_json::from_str::<Value>(&tc.arguments).unwrap_or(json!({})) } })
                                })
                                .collect(),
                        );
                    }
                    obj
                }
                Msg::Tool { content, .. } => json!({ "role": "tool", "content": content }),
            })
            .collect();

        let mut body = json!({ "model": req.model, "messages": messages, "stream": stream });
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(req.tools.clone());
        }
        if req.json_mode {
            body["format"] = json!("json");
        }
        let mut opts = serde_json::Map::new();
        if let Some(t) = req.temperature {
            opts.insert("temperature".into(), json!(t));
        }
        if let Some(m) = req.max_tokens {
            opts.insert("num_predict".into(), json!(m));
        }
        if !opts.is_empty() {
            body["options"] = Value::Object(opts);
        }
        body
    }
}

/// Resposta nativa do Ollama → canônico.
pub fn parse_response(body: &Value) -> Completion {
    let mut out = Completion::default();
    let msg = body.get("message").cloned().unwrap_or(Value::Null);
    if let Some(text) = msg
        .get("content")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
    {
        out.text = Some(text.to_string());
    }
    if let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
        for (i, c) in calls.iter().enumerate() {
            if let Some(name) = c.pointer("/function/name").and_then(|v| v.as_str()) {
                let args = c
                    .pointer("/function/arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                let id = if i == 0 {
                    name.to_string()
                } else {
                    format!("{name}#{i}")
                };
                out.tool_calls
                    .push(ToolCall::new(id, name, args.to_string()));
            }
        }
    }
    let input = body
        .get("prompt_eval_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output = body.get("eval_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if input > 0 || output > 0 {
        out.usage = Some((input, output));
    }
    out
}

#[async_trait]
impl LlmAdapter for Ollama {
    fn wire(&self) -> Wire {
        Wire::Ollama
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
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let res = http_client()
            .post(&url)
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req, true))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("ollama_request:{e}"))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "ollama_http_{}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }

        use futures_util::StreamExt;
        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("ollama_stream:{e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            // NDJSON: cada linha é uma resposta completa.
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();
                if line.is_empty() {
                    continue;
                }
                let Ok(body) = serde_json::from_str::<Value>(&line) else {
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
                if body.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                    let _ = tx.send(LlmEvent::Done).await;
                    return Ok(());
                }
            }
        }
        let _ = tx.send(LlmEvent::Done).await;
        Ok(())
    }

    async fn complete(&self, req: ChatRequest) -> anyhow::Result<Completion> {
        let url = format!("{}/api/chat", self.base_url.trim_end_matches('/'));
        let res = http_client()
            .post(&url)
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req, false))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("ollama_request:{e}"))?;
        let status = res.status();
        let body: Value = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("ollama_json:{e}"))?;
        if !status.is_success() {
            return Err(anyhow::anyhow!("ollama_http_{}: {}", status.as_u16(), body));
        }
        Ok(parse_response(&body))
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let res = http_client()
            .get(format!("{}/api/tags", self.base_url.trim_end_matches('/')))
            .timeout(Duration::from_secs(10))
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
                        let id = m
                            .get("model")
                            .or_else(|| m.get("name"))
                            .and_then(|v| v.as_str())?;
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
    fn parses_native_response_with_tool_calls() {
        let body = json!({
            "message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "get_playlists", "arguments": {"limit": 3}}}]
            },
            "done": true,
            "prompt_eval_count": 12,
            "eval_count": 4
        });
        let c = parse_response(&body);
        assert_eq!(c.text, None);
        assert_eq!(c.tool_calls[0].name, "get_playlists");
        assert_eq!(c.tool_calls[0].parsed_args()["limit"], 3);
        assert_eq!(c.usage, Some((12, 4)));
    }

    #[test]
    fn repeated_tool_names_get_unique_ids() {
        let body = json!({
            "message": {"tool_calls": [
                {"function": {"name": "get_artist", "arguments": {}}},
                {"function": {"name": "get_artist", "arguments": {}}}
            ]}
        });
        let c = parse_response(&body);
        assert_eq!(c.tool_calls[0].id, "get_artist");
        assert_eq!(c.tool_calls[1].id, "get_artist#1");
    }

    #[test]
    fn lmstudio_base_detects_openai_wire() {
        assert!(Ollama::new("http://127.0.0.1:1234/v1", "m").prefer_openai_wire);
        assert!(!Ollama::new("http://127.0.0.1:11434", "m").prefer_openai_wire);
    }

    #[test]
    fn json_mode_maps_to_format_json() {
        let o = Ollama::new("http://127.0.0.1:11434", "llama3.2");
        let mut req = ChatRequest::new("llama3.2", vec![Msg::user("x")]);
        req.json_mode = true;
        let body = o.body(&req, false);
        assert_eq!(body["format"], "json");
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn options_include_temperature_and_num_predict() {
        let o = Ollama::new("http://127.0.0.1:11434", "llama3.2");
        let mut req = ChatRequest::new("llama3.2", vec![Msg::user("x")]);
        req.temperature = Some(0.5);
        req.max_tokens = Some(2048);
        let body = o.body(&req, false);
        assert_eq!(body["options"]["temperature"], 0.5);
        assert_eq!(body["options"]["num_predict"], 2048);
    }
}
