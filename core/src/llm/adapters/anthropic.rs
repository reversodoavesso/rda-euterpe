//! Adapter Anthropic (Messages API). A conversão canônica ↔ blocos
//! `tool_use`/`tool_result` é o ponto mais delicado do wire, então há teste de
//! ida-e-volta aqui mesmo.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::Sender;

use super::super::canonical::*;
use super::super::sse::SseDecoder;
use super::http_client;
use super::openai_compat::classify_error;
use crate::config::Wire;

const API_VERSION: &str = "2023-06-01";

pub struct Anthropic {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
}

impl Anthropic {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            model: model.into(),
            max_tokens: 4096,
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }

    fn body(&self, req: &ChatRequest, stream: bool) -> Value {
        let (system, messages) = to_wire(&req.messages);
        let mut body = json!({
            "model": req.model,
            "max_tokens": req.max_tokens.unwrap_or(self.max_tokens),
            "messages": messages,
            "stream": stream,
        });
        if let Some(system) = system {
            body["system"] = json!(system);
        }
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(
                req.tools
                    .iter()
                    .filter_map(|t| {
                        let f = t.get("function")?;
                        Some(json!({
                            "name": f.get("name")?,
                            "description": f.get("description").cloned().unwrap_or(Value::Null),
                            "input_schema": f.get("parameters").cloned().unwrap_or(json!({"type":"object"})),
                        }))
                    })
                    .collect(),
            );
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
        body
    }
}

/// Converte canônico → `(system, messages)` no formato Anthropic.
///
/// Regras:
///  - o `System` (no máximo 1, o primeiro) vai para o parâmetro `system`;
///  - `Assistant` com tool_calls vira blocos `tool_use` (e o texto, se houver,
///    vira um bloco `text` antes deles);
///  - `Tool` vira um `user` com bloco `tool_result` (a API exige que os
///    `tool_result` venham do "usuário" e que TODOS os `tool_use` tenham par);
///  - mensagens consecutivas do mesmo papel são mescladas em um único turno.
pub fn to_wire(messages: &[Msg]) -> (Option<String>, Vec<Value>) {
    let mut system: Option<String> = None;
    let mut out: Vec<Value> = Vec::new();

    let push_block = |out: &mut Vec<Value>, role: &str, block: Value| {
        if let Some(last) = out.last_mut() {
            if last.get("role").and_then(|v| v.as_str()) == Some(role) {
                if let Some(content) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                    content.push(block);
                    return;
                }
            }
        }
        out.push(json!({ "role": role, "content": [block] }));
    };

    for msg in messages {
        match msg {
            Msg::System(text) => {
                if system.is_none() {
                    system = Some(text.clone());
                }
            }
            Msg::User(text) => {
                push_block(&mut out, "user", json!({ "type": "text", "text": text }))
            }
            Msg::Assistant { text, tool_calls } => {
                if let Some(text) = text.as_deref().filter(|t| !t.is_empty()) {
                    push_block(
                        &mut out,
                        "assistant",
                        json!({ "type": "text", "text": text }),
                    );
                }
                for call in tool_calls {
                    let input: Value =
                        serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                    push_block(
                        &mut out,
                        "assistant",
                        json!({ "type": "tool_use", "id": call.id, "name": call.name, "input": input }),
                    );
                }
            }
            Msg::Tool { id, content } => {
                let parsed: Value =
                    serde_json::from_str(content).unwrap_or_else(|_| json!({ "text": content }));
                push_block(
                    &mut out,
                    "user",
                    json!({ "type": "tool_result", "tool_use_id": id, "content": parsed.to_string() }),
                );
            }
        }
    }
    (system, out)
}

/// Caminho inverso (ida-e-volta): blocos Anthropic → canônico. Usado nos testes
/// de contrato e para reconstruir histórico vindo de providers que devolvem
/// blocos.
pub fn from_wire(system: Option<&str>, messages: &[Value]) -> Vec<Msg> {
    let mut out: Vec<Msg> = Vec::new();
    if let Some(system) = system {
        out.push(Msg::system(system));
    }
    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let blocks = msg
            .get("content")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut tool_results: Vec<(String, String)> = Vec::new();
        for block in &blocks {
            match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "text" => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text_parts.push(t.to_string());
                    }
                }
                "tool_use" => {
                    if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                        tool_calls.push(ToolCall::new(
                            block.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                            name,
                            block.get("input").cloned().unwrap_or(json!({})).to_string(),
                        ));
                    }
                }
                "tool_result" => {
                    if let Some(id) = block.get("tool_use_id").and_then(|v| v.as_str()) {
                        let content = block
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        tool_results.push((id.to_string(), content));
                    }
                }
                _ => {}
            }
        }
        if role == "assistant" {
            let text = if text_parts.is_empty() {
                None
            } else {
                Some(text_parts.join("\n"))
            };
            if text.is_some() || !tool_calls.is_empty() {
                out.push(Msg::Assistant { text, tool_calls });
            }
        } else {
            if !text_parts.is_empty() {
                out.push(Msg::user(text_parts.join("\n")));
            }
            for (id, content) in tool_results {
                out.push(Msg::tool(id, content));
            }
        }
    }
    out
}

#[async_trait]
impl LlmAdapter for Anthropic {
    fn wire(&self) -> Wire {
        Wire::Anthropic
    }

    fn capabilities(&self) -> Caps {
        // Anthropic não tem `response_format: json_object`; o fallback é o parser
        // tolerante do C8.
        Caps {
            streaming: true,
            tools: true,
            json_mode: false,
            reasoning_field: Some("thinking"),
        }
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn stream(&self, req: ChatRequest, tx: Sender<LlmEvent>) -> anyhow::Result<()> {
        let res = http_client()
            .post(self.endpoint())
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .timeout(Duration::from_millis(req.timeout_ms))
            .json(&self.body(&req, true))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("anthropic_request:{e}"))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "anthropic_http_{}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }

        use futures_util::StreamExt;
        let mut stream = res.bytes_stream();
        let mut decoder = SseDecoder::new();
        let mut tool_json = String::new();
        let mut tool_id = String::new();
        let mut tool_name = String::new();
        let mut current_tools: Vec<ToolCall> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("anthropic_stream:{e}"))?;
            for event in decoder.push(&String::from_utf8_lossy(&chunk)) {
                let Some(body) = SseDecoder::json_of(&event) else {
                    continue;
                };
                match body.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "content_block_start" => {
                        if let Some(block) = body.pointer("/content_block") {
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                tool_id = block
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                tool_name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                tool_json = block
                                    .get("input")
                                    .filter(|v| {
                                        v.as_object().map(|o| !o.is_empty()).unwrap_or(false)
                                    })
                                    .map(|v| v.to_string())
                                    .unwrap_or_default();
                            }
                        }
                    }
                    "content_block_delta" => {
                        let delta = body.get("delta").cloned().unwrap_or(Value::Null);
                        match delta.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                            "text_delta" => {
                                if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                    let _ = tx.send(LlmEvent::Delta(text.to_string())).await;
                                }
                            }
                            "thinking_delta" => {
                                if let Some(text) = delta.get("thinking").and_then(|v| v.as_str()) {
                                    let _ = tx.send(LlmEvent::Reasoning(text.to_string())).await;
                                }
                            }
                            "input_json_delta" => {
                                if let Some(partial) =
                                    delta.get("partial_json").and_then(|v| v.as_str())
                                {
                                    tool_json.push_str(partial);
                                }
                            }
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        if !tool_name.is_empty() {
                            let args = if tool_json.trim().is_empty() {
                                "{}".to_string()
                            } else {
                                tool_json.clone()
                            };
                            let call = ToolCall::new(tool_id.clone(), tool_name.clone(), args);
                            current_tools.push(call.clone());
                            let _ = tx.send(LlmEvent::ToolCall(call)).await;
                        }
                        tool_json.clear();
                        tool_id.clear();
                        tool_name.clear();
                    }
                    "message_delta" => {
                        if let Some(usage) = body.get("usage") {
                            let output = usage
                                .get("output_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            let input = usage
                                .get("input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            let _ = tx.send(LlmEvent::Usage { input, output }).await;
                        }
                    }
                    "message_stop" => {
                        let _ = tx.send(LlmEvent::Done).await;
                        return Ok(());
                    }
                    "error" => {
                        let detail = body.get("error").cloned().unwrap_or(Value::Null);
                        return Err(anyhow::anyhow!("anthropic_stream_error: {detail}"));
                    }
                    _ => {}
                }
            }
        }
        for event in decoder.finish() {
            if let Some(body) = SseDecoder::json_of(&event) {
                if let Some(text) = body.pointer("/delta/text").and_then(|v| v.as_str()) {
                    let _ = tx.send(LlmEvent::Delta(text.to_string())).await;
                }
            }
        }
        let _ = tx.send(LlmEvent::Done).await;
        Ok(())
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let res = http_client()
            .get(format!("{}/v1/models", self.base_url.trim_end_matches('/')))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if !res.status().is_success() {
            anyhow::bail!("models_http_{}", res.status().as_u16());
        }
        let body: Value = res.json().await?;
        // Fallback: a Messages API não expõe catálogo público em todas as contas.
        let models: Vec<ModelInfo> = body
            .get("data")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(ModelInfo::new))
                    .collect()
            })
            .unwrap_or_else(|| {
                [
                    "claude-3-5-haiku-latest",
                    "claude-3-5-sonnet-latest",
                    "claude-3-7-sonnet-latest",
                    "claude-sonnet-4-0",
                ]
                .iter()
                .map(|m| ModelInfo::new(*m))
                .collect()
            });
        Ok(models)
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
    fn system_goes_to_the_system_parameter() {
        let (system, messages) = to_wire(&[Msg::system("sys"), Msg::user("hi")]);
        assert_eq!(system.as_deref(), Some("sys"));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["text"], "hi");
    }

    #[test]
    fn assistant_tool_calls_become_tool_use_blocks() {
        let (_s, messages) = to_wire(&[Msg::Assistant {
            text: Some("vou buscar".into()),
            tool_calls: vec![ToolCall::new("tu_1", "get_playlists", r#"{"limit":5}"#)],
        }]);
        let blocks = messages[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "tool_use");
        assert_eq!(blocks[1]["input"]["limit"], 5);
    }

    #[test]
    fn tool_result_becomes_a_user_turn() {
        let (_s, messages) = to_wire(&[Msg::tool("tu_1", r#"{"ok":true}"#)]);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][0]["type"], "tool_result");
        assert_eq!(messages[0]["content"][0]["tool_use_id"], "tu_1");
    }

    #[test]
    fn consecutive_same_role_turns_are_merged() {
        let (_s, messages) = to_wire(&[Msg::user("a"), Msg::user("b")]);
        assert_eq!(
            messages.len(),
            1,
            "turnos consecutivos precisam ser mesclados"
        );
        assert_eq!(messages[0]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn round_trip_preserves_the_conversation() {
        let original = vec![
            Msg::system("sys"),
            Msg::user("oi"),
            Msg::Assistant {
                text: Some("claro".into()),
                tool_calls: vec![ToolCall::new("tu", "search_spotify", r#"{"q":"miles"}"#)],
            },
            Msg::tool("tu", r#"{"ok":true,"data":[]}"#),
        ];
        let (system, wire) = to_wire(&original);
        let back = from_wire(system.as_deref(), &wire);
        assert_eq!(back[0], original[0]);
        assert_eq!(back[1], original[1]);
        match &back[2] {
            Msg::Assistant { text, tool_calls } => {
                assert_eq!(text.as_deref(), Some("claro"));
                assert_eq!(tool_calls[0].name, "search_spotify");
                assert_eq!(tool_calls[0].parsed_args()["q"], "miles");
            }
            other => panic!("esperava Assistant, veio {other:?}"),
        }
        match &back[3] {
            Msg::Tool { id, content } => {
                assert_eq!(id, "tu");
                assert!(content.contains("ok"));
            }
            other => panic!("esperava Tool, veio {other:?}"),
        }
    }

    #[test]
    fn tools_are_translated_to_input_schema() {
        let adapter = Anthropic::new("https://api.anthropic.com", "k", "m");
        let mut req = ChatRequest::new("m", vec![Msg::user("x")]);
        req.tools = vec![json!({
            "type": "function",
            "function": {"name":"get_playlists","description":"d","parameters":{"type":"object","properties":{}}}
        })];
        let body = adapter.body(&req, false);
        assert_eq!(body["tools"][0]["name"], "get_playlists");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert!(body["tools"][0].get("function").is_none());
    }

    #[test]
    fn json_mode_is_declared_unsupported() {
        let adapter = Anthropic::new("https://api.anthropic.com", "k", "m");
        assert!(!adapter.capabilities().json_mode);
        assert!(adapter.capabilities().tools);
    }
}
