//! Execução do chat a partir de `chat.send` / `event.songchange` no bridge WS.
//!
//! Dois modos, escolhidos por `CHAT_UPSTREAM` (D6):
//!  - **vazio** → loop LLM nativo do Rust (Fase 4);
//!  - **definido** → espelho para o agente Node, que passa a ser o backend do
//!    chat (Fase 2). A extensão e a UI não percebem: contrato idêntico.

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::bridge::Sink;
use crate::protocol::ServerMsg;
use crate::AppState;

/// Roda o chat (nativo ou espelhado) para uma sessão.
pub async fn handle_chat_send(
    state: AppState,
    sink: UnboundedSender<ServerMsg>,
    upstream: crate::upstream::UpstreamChat,
    session_id: String,
    text: String,
    locale: String,
) {
    if upstream.is_enabled() {
        upstream.chat(&session_id, &text, Some(&locale)).await;
        return;
    }
    let eff = state.effective_for_session(Some(&session_id));
    let adapter = crate::providers::registry::active(&state.cfg, &eff).ok();
    let deps = crate::llm::ChatDeps {
        cfg: &state.cfg,
        eff: &eff,
        store: &state.store,
        bridge: Arc::clone(&state.bridge),
        sink: Sink::clone(&sink),
        session_id,
        locale,
        adapter,
        // Caminho WS: paridade total com o Node (chunks de 40 chars no fim).
        stream_deltas: false,
        cancel_token: None,
    };
    crate::llm::handle_chat(&deps, &text).await;
}

/// Roteamento automático da faixa atual.
pub async fn handle_song_change(
    state: AppState,
    sink: UnboundedSender<ServerMsg>,
    uri: String,
    locale: String,
) {
    crate::logging::log_session(
        &state.cfg.sessions_dir,
        "routing",
        "songchange.event",
        Some(serde_json::json!({ "uri": uri })),
    );
    // A sessão de roteamento é fixa ("routing"), mas passar por
    // `effective_for_session` mantém uma porta só para override de perfil.
    let eff = state.effective_for_session(Some("routing"));
    let adapter = crate::providers::registry::active(&state.cfg, &eff).ok();
    let deps = crate::llm::ChatDeps {
        cfg: &state.cfg,
        eff: &eff,
        store: &state.store,
        bridge: Arc::clone(&state.bridge),
        sink,
        session_id: "routing".to_string(),
        locale,
        adapter,
        stream_deltas: false,
        cancel_token: None,
    };
    crate::llm::handle_song_change(&deps, &uri).await;
}
