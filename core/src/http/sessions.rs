//! `/sessions` e `/sessions/:id` (C5) — lê os mesmos `data/sessions/*.log` do
//! agente Node, então o painel de debug não muda de forma nenhuma.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::AppState;

pub async fn list(State(state): State<AppState>) -> Json<Vec<crate::logging::SessionSummary>> {
    Json(crate::logging::list_sessions(&state.cfg.sessions_dir))
}

pub async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Json<Vec<Value>> {
    Json(crate::logging::read_session(&state.cfg.sessions_dir, &id))
}
