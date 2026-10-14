//! Protocolo do bridge WS — contrato congelado C1/C2/C4.
//!
//! Espelha `agent/src/protocol.ts` (zod) e `agent/src/index.ts:184-303`.
//! Qualquer divergência aqui quebra a extensão (que **não** muda): por isso há
//! `parity_bridge.rs` / `parity_errors.rs` como gate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Mensagens cliente → daemon.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum ClientMsg {
    #[serde(rename = "hello")]
    Hello {
        secret: String,
        #[serde(rename = "appVersion")]
        app_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locale: Option<String>,
    },
    #[serde(rename = "tool.result")]
    ToolResult {
        id: String,
        ok: bool,
        #[serde(default)]
        data: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "chat.send")]
    ChatSend {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "sessionId")]
        session_id: Option<String>,
    },
    #[serde(rename = "chat.clear")]
    ChatClear {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "proposal.decision")]
    ProposalDecision {
        #[serde(rename = "proposalId")]
        proposal_id: String,
        decision: Decision,
    },
    #[serde(rename = "event.songchange")]
    SongChange { uri: String },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "client.debug")]
    ClientDebug {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<DebugLevel>,
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Reject,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DebugLevel {
    Log,
    Warn,
    Error,
}

/// Mensagens daemon → cliente.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum ServerMsg {
    #[serde(rename = "hello.ok")]
    HelloOk { version: String },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "chat.status")]
    ChatStatus {
        #[serde(rename = "sessionId", default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename = "chat.stream")]
    ChatStream {
        #[serde(rename = "sessionId", default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        delta: String,
    },
    #[serde(rename = "chat.done")]
    ChatDone {
        #[serde(rename = "sessionId", default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suggestions: Option<Vec<String>>,
    },
    #[serde(rename = "chat.cleared")]
    ChatCleared {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "tool.call")]
    ToolCall {
        id: String,
        name: String,
        args: Value,
    },
    #[serde(rename = "proposal.create")]
    ProposalCreate {
        #[serde(rename = "proposalId")]
        proposal_id: String,
        kind: String,
        title: String,
        name: String,
        args: Value,
    },
}

/// Pedido de execução de tool no cliente.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub args: Value,
}

/// Resultado de uma tool. `{ok, data?, code?}` — contrato C4.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl ToolResult {
    pub fn ok(data: Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            code: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            ok: true,
            data: Some(Value::Null),
            code: None,
        }
    }

    pub fn err(code: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            code: Some(code.into()),
        }
    }

    pub fn is_rate_limited(&self) -> bool {
        !self.ok && self.code.as_deref() == Some("rate_limited")
    }
}

impl ClientMsg {
    /// Parse tolerante: erro ⇒ o daemon responde `chat.status{status:"error"}`
    /// sem derrubar a conexão (C2).
    pub fn parse(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Hello { .. } => "hello",
            Self::ToolResult { .. } => "tool.result",
            Self::ChatSend { .. } => "chat.send",
            Self::ChatClear { .. } => "chat.clear",
            Self::ProposalDecision { .. } => "proposal.decision",
            Self::SongChange { .. } => "event.songchange",
            Self::Ping => "ping",
            Self::Pong => "pong",
            Self::ClientDebug { .. } => "client.debug",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_client_message() {
        let cases: &[(&str, &str)] = &[
            (
                r#"{"type":"hello","secret":"s","appVersion":"1.0.0"}"#,
                "hello",
            ),
            (
                r#"{"type":"hello","secret":"s","appVersion":"1.0.0","locale":"pt-BR"}"#,
                "hello",
            ),
            (
                r#"{"type":"tool.result","id":"a","ok":true,"data":{"x":1}}"#,
                "tool.result",
            ),
            (
                r#"{"type":"tool.result","id":"a","ok":false,"data":null,"code":"x"}"#,
                "tool.result",
            ),
            (r#"{"type":"chat.send","text":"oi"}"#, "chat.send"),
            (
                r#"{"type":"chat.send","text":"oi","sessionId":"s1"}"#,
                "chat.send",
            ),
            (r#"{"type":"chat.clear","sessionId":"s1"}"#, "chat.clear"),
            (
                r#"{"type":"proposal.decision","proposalId":"p","decision":"approve"}"#,
                "proposal.decision",
            ),
            (
                r#"{"type":"event.songchange","uri":"spotify:track:1"}"#,
                "event.songchange",
            ),
            (r#"{"type":"ping"}"#, "ping"),
            (r#"{"type":"pong"}"#, "pong"),
            (r#"{"type":"client.debug","detail":"hi"}"#, "client.debug"),
            (
                r#"{"type":"client.debug","level":"warn","detail":"hi"}"#,
                "client.debug",
            ),
        ];
        for (raw, expected) in cases {
            let msg = ClientMsg::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(msg.type_name(), *expected, "{raw}");
        }
    }

    #[test]
    fn rejects_invalid_messages_like_zod() {
        let bad = [
            "not json",
            "{}",
            r#"{"type":"nope"}"#,
            r#"{"type":"hello"}"#,
            r#"{"type":"hello","secret":"s"}"#,
            r#"{"type":"chat.send"}"#,
            r#"{"type":"chat.clear"}"#,
            r#"{"type":"proposal.decision","proposalId":"p","decision":"maybe"}"#,
            r#"{"type":"client.debug"}"#,
            r#"{"type":"tool.result","id":"a"}"#,
        ];
        for raw in bad {
            assert!(ClientMsg::parse(raw).is_err(), "deveria falhar: {raw}");
        }
    }

    #[test]
    fn tool_result_serializes_without_nulls() {
        let v = serde_json::to_value(ToolResult::err("client_timeout")).unwrap();
        assert_eq!(v, serde_json::json!({"ok":false,"code":"client_timeout"}));
        let v = serde_json::to_value(ToolResult::ok(serde_json::json!([1, 2]))).unwrap();
        assert_eq!(v, serde_json::json!({"ok":true,"data":[1,2]}));
    }

    #[test]
    fn server_messages_round_trip() {
        let msgs = vec![
            ServerMsg::HelloOk {
                version: "0.1.0".into(),
            },
            ServerMsg::Pong,
            ServerMsg::ChatStatus {
                session_id: Some("s".into()),
                status: "thinking".into(),
                detail: Some("d".into()),
            },
            ServerMsg::ChatStatus {
                session_id: None,
                status: "error".into(),
                detail: Some("d".into()),
            },
            ServerMsg::ChatStream {
                session_id: Some("s".into()),
                delta: "x".into(),
            },
            ServerMsg::ChatDone {
                session_id: Some("s".into()),
                suggestions: Some(vec!["a".into()]),
            },
            ServerMsg::ChatDone {
                session_id: Some("s".into()),
                suggestions: None,
            },
            ServerMsg::ChatCleared {
                session_id: "s".into(),
            },
            ServerMsg::ToolCall {
                id: "i".into(),
                name: "n".into(),
                args: serde_json::json!({"a":1}),
            },
            ServerMsg::ProposalCreate {
                proposal_id: "p".into(),
                kind: "tool".into(),
                title: "t".into(),
                name: "n".into(),
                args: serde_json::json!({}),
            },
        ];
        for msg in msgs {
            let raw = serde_json::to_string(&msg).unwrap();
            let back: ServerMsg = serde_json::from_str(&raw).unwrap();
            assert_eq!(msg, back, "{raw}");
        }
    }
}
