//! Camada canônica de LLM (`PLAN-REFACTOR.md` §F4): o coração da portabilidade
//! entre providers. Todo adapter converte `Msg` ↔ wire do provider.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Chamada de tool pedida pelo modelo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Argumentos **crus** (string JSON), como vêm do wire: o loop precisa
    /// preservar exatamente o que o provider mandou para reenviar no histórico.
    pub arguments: String,
    /// Assinatura criptográfica de pensamento (exigida por Gemini 2.5 / 3+ em multi-turn)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

impl ToolCall {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
            thought_signature: None,
        }
    }

    pub fn with_thought_signature(mut self, sig: Option<String>) -> Self {
        self.thought_signature = sig;
        self
    }

    pub fn parsed_args(&self) -> serde_json::Value {
        serde_json::from_str(&self.arguments).unwrap_or_else(|_| serde_json::json!({}))
    }
}

/// Mensagem canônica.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Msg {
    System(String),
    User(String),
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCall>,
    },
    Tool {
        id: String,
        content: String,
    },
}

impl Msg {
    pub fn user(text: impl Into<String>) -> Self {
        Self::User(text.into())
    }

    pub fn system(text: impl Into<String>) -> Self {
        Self::System(text.into())
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self::Assistant {
            text: Some(text.into()),
            tool_calls: Vec::new(),
        }
    }

    pub fn tool(id: impl Into<String>, content: impl Into<String>) -> Self {
        Self::Tool {
            id: id.into(),
            content: content.into(),
        }
    }
}

/// Eventos emitidos por um adapter durante o streaming.
#[derive(Debug, Clone, PartialEq)]
pub enum LlmEvent {
    Delta(String),
    Reasoning(String),
    ToolCall(ToolCall),
    Usage { input: u32, output: u32 },
    Done,
}

/// Resposta não-streaming (o loop agentic usa este caminho, como o Node).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Completion {
    pub text: Option<String>,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<(u32, u32)>,
}

/// Pedido de completion.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<serde_json::Value>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub json_mode: bool,
    pub timeout_ms: u64,
}

impl ChatRequest {
    pub fn new(model: impl Into<String>, messages: Vec<Msg>) -> Self {
        Self {
            model: model.into(),
            messages,
            tools: Vec::new(),
            temperature: None,
            max_tokens: None,
            json_mode: false,
            timeout_ms: 120_000,
        }
    }
}

/// Capacidades declaradas por um adapter — permite degradar sem `if provider ==`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub streaming: bool,
    pub tools: bool,
    pub json_mode: bool,
    /// Campo de "raciocínio" (ex.: `reasoning_content` no DeepSeek). Nunca é
    /// reenviado no histórico — só logado.
    pub reasoning_field: Option<&'static str>,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            streaming: true,
            tools: true,
            json_mode: true,
            reasoning_field: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub owned_by: Option<String>,
}

impl ModelInfo {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            name: id.clone(),
            id,
            owned_by: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestReport {
    pub ok: bool,
    #[serde(default, rename = "latencyMs")]
    pub latency_ms: u64,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub sample: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Adaptador de provider. `Send + Sync` para viver dentro do `AppState`.
#[async_trait]
pub trait LlmAdapter: Send + Sync {
    fn wire(&self) -> crate::config::Wire;
    fn capabilities(&self) -> Caps;
    fn model(&self) -> &str;

    async fn stream(
        &self,
        req: ChatRequest,
        tx: tokio::sync::mpsc::Sender<LlmEvent>,
    ) -> anyhow::Result<()>;

    /// Implementação default: consome o stream e agrega (usado por quem não tem
    /// caminho não-streaming, como o Gemini com `alt=sse`).
    async fn complete(&self, req: ChatRequest) -> anyhow::Result<Completion> {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let stream_fut = self.stream(req, tx);
        let collect = async {
            let mut out = Completion::default();
            let mut text = String::new();
            let mut reasoning = String::new();
            while let Some(ev) = rx.recv().await {
                match ev {
                    LlmEvent::Delta(d) => text.push_str(&d),
                    LlmEvent::Reasoning(r) => reasoning.push_str(&r),
                    LlmEvent::ToolCall(tc) => out.tool_calls.push(tc),
                    LlmEvent::Usage { input, output } => out.usage = Some((input, output)),
                    LlmEvent::Done => {}
                }
            }
            if !text.is_empty() {
                out.text = Some(text);
            }
            if !reasoning.is_empty() {
                out.reasoning = Some(reasoning);
            }
            out
        };
        let (res, completion) = tokio::join!(stream_fut, collect);
        res?;
        Ok(completion)
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>>;

    /// 1 chamada barata; devolve latência (usado por `POST /providers/test`).
    async fn test(&self) -> anyhow::Result<TestReport>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_call_arguments_are_preserved_raw() {
        let tc = ToolCall::new("a", "add_tracks", r#"{"playlist_id":"p","uris":["x"]}"#);
        assert_eq!(tc.parsed_args()["playlist_id"], "p");
    }

    #[test]
    fn broken_arguments_degrade_to_empty_object() {
        let tc = ToolCall::new("a", "n", "{oops");
        assert_eq!(tc.parsed_args(), serde_json::json!({}));
        let tc = ToolCall::new("a", "n", "");
        assert_eq!(tc.parsed_args(), serde_json::json!({}));
    }
}
