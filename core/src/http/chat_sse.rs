//! `/chat` — SSE (rota aditiva). É o que a UI nova consome; a extensão continua
//! usando o WS (porta e contrato idênticos, D6).
//!
//! Contrato dos eventos (`event:` → `data:`):
//!  - `status`   `{status, detail}`
//!  - `stream`   `{delta}`
//!  - `tool`     `{id, name, args}`
//!  - `proposal` `{proposalId, kind, title, name, args}`
//!  - `cleared`  `{sessionId}`
//!  - `done`     `{sessionId, suggestions}`
//!  - `error`    `{code, detail}`

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;

use crate::protocol::ServerMsg;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub text: String,
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
}

/// Converte uma mensagem do protocolo no par `(evento SSE, payload)`.
pub fn to_sse(msg: &ServerMsg) -> Option<(&'static str, Value)> {
    match msg {
        ServerMsg::ChatStatus { status, detail, .. } => {
            Some(("status", json!({ "status": status, "detail": detail })))
        }
        ServerMsg::ChatStream { delta, .. } => Some(("stream", json!({ "delta": delta }))),
        ServerMsg::ChatDone {
            session_id,
            suggestions,
        } => Some((
            "done",
            json!({
                "sessionId": session_id,
                "suggestions": suggestions.clone().unwrap_or_default(),
            }),
        )),
        ServerMsg::ChatCleared { session_id } => {
            Some(("cleared", json!({ "sessionId": session_id })))
        }
        ServerMsg::ToolCall { id, name, args } => {
            Some(("tool", json!({ "id": id, "name": name, "args": args })))
        }
        ServerMsg::ProposalCreate {
            proposal_id,
            kind,
            title,
            name,
            args,
        } => Some((
            "proposal",
            json!({ "proposalId": proposal_id, "kind": kind, "title": title, "name": name, "args": args }),
        )),
        // Não fazem sentido em SSE.
        ServerMsg::HelloOk { .. } | ServerMsg::Pong => None,
    }
}

struct DropCancel(Option<tokio_util::sync::CancellationToken>);
impl Drop for DropCancel {
    fn drop(&mut self) {
        if let Some(t) = self.0.take() {
            t.cancel();
        }
    }
}

struct ActiveChat {
    state: AppState,
    id: String,
    run: uuid::Uuid,
}
impl Drop for ActiveChat {
    fn drop(&mut self) {
        let mut chats = self.state.chats.lock().unwrap_or_else(|e| e.into_inner());
        if chats.get(&self.id).is_some_and(|(run, _)| *run == self.run) {
            chats.remove(&self.id);
            self.state.bridge.unwatch_proposals(&self.id);
        }
    }
}

pub async fn cancel(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Json<Value> {
    let chats = state.chats.lock().unwrap_or_else(|e| e.into_inner());
    let found = if let Some((_, token)) = chats.get(&id) {
        token.cancel();
        true
    } else {
        false
    };
    Json(json!({"ok":true,"cancelled":found}))
}

pub async fn chat(
    State(state): State<AppState>,
    Json(req): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let session_id = req
        .session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let locale = crate::i18n::normalize_locale(req.locale.as_deref()).to_string();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ServerMsg>();

    let cancel_token = tokio_util::sync::CancellationToken::new();
    let drop_guard = DropCancel(Some(cancel_token.clone()));
    let run = uuid::Uuid::new_v4();
    {
        let mut chats = state.chats.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, old)) = chats.insert(session_id.clone(), (run, cancel_token.clone())) {
            old.cancel();
        }
        if state.bridge.is_headless() {
            state.bridge.watch_proposals(&session_id, tx.clone());
        }
    }
    let active = ActiveChat {
        state: state.clone(),
        id: session_id.clone(),
        run,
    };

    let state = Arc::new(state);
    let task_state = AppState::clone(&state);
    let text = req.text.clone();
    tokio::spawn(async move {
        let _active = active;
        let upstream = crate::upstream::UpstreamChat::new(task_state.clone(), tx.clone());
        if upstream.is_enabled() {
            tokio::select! {
                _ = cancel_token.cancelled() => {},
                _ = upstream.chat(&session_id, &text, Some(&locale)) => {},
            }
            return;
        }
        let eff = task_state.effective_for_session(Some(&session_id));
        let adapter = crate::providers::registry::active(&task_state.cfg, &eff).ok();
        let deps = crate::llm::ChatDeps {
            cfg: &task_state.cfg,
            eff: &eff,
            store: &task_state.store,
            bridge: Arc::clone(&task_state.bridge),
            sink: tx.clone(),
            session_id,
            locale,
            adapter,
            // Caminho SSE: deltas reais (a UI nova mostra o texto enquanto sai).
            stream_deltas: true,
            cancel_token: Some(cancel_token.clone()),
        };
        tokio::select! {
            _ = cancel_token.cancelled() => {},
            _ = crate::llm::handle_chat(&deps, &text) => {},
        }
        drop(tx);
    });

    let stream = stream::unfold((rx, drop_guard), |(mut rx, drop_guard)| async move {
        loop {
            match rx.recv().await {
                Some(msg) => {
                    if let Some((name, data)) = to_sse(&msg) {
                        let event = Event::default().event(name).data(data.to_string());
                        return Some((Ok::<Event, Infallible>(event), (rx, drop_guard)));
                    }
                }
                None => return None,
            }
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
