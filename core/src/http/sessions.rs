//! `/sessions` e `/sessions/:id` (C5) — lê os mesmos `data/sessions/*.log` do
//! agente Node, então o painel de debug não muda de forma nenhuma.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::AppState;

pub async fn history(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, axum::http::StatusCode> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    let rows = state
        .store
        .with(|c| Ok(crate::store::history::get_history(c, &id, 2000)))
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({"messages":rows})))
}

pub async fn erase(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, axum::http::StatusCode> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    state
        .store
        .with(|c| {
            c.execute("DELETE FROM conversations WHERE session_id = ?", [&id])?;
            Ok(())
        })
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let file = state.cfg.sessions_dir.join(format!("{id}.log"));
    match std::fs::remove_file(file) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
    }
    Ok(Json(serde_json::json!({"ok":true})))
}

pub async fn list(State(state): State<AppState>) -> Json<Vec<crate::logging::SessionSummary>> {
    Json(crate::logging::list_sessions(&state.cfg.sessions_dir))
}

pub async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Json<Vec<Value>> {
    Json(crate::logging::read_session(&state.cfg.sessions_dir, &id))
}
