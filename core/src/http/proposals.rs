//! Confirmação para a futura UI web, usando o segredo do daemon como bearer.

use crate::{protocol::Decision, AppState};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if !state.cfg.ws_secret.is_empty()
        && headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {}", state.cfg.ws_secret).as_str())
    {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// No modo headless, todas as rotas de controle exigem o segredo local.
/// `/health` revela somente o estado do processo e continua sendo uma probe.
pub async fn headless_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if state.bridge.is_headless() && request.uri().path() != "/health" {
        if let Err(status) = authorize(&state, request.headers()) {
            return (status, Json(json!({"error":"authentication_required"}))).into_response();
        }
    }
    next.run(request).await
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    Ok(Json(json!({"proposals": state.bridge.pending_proposals()})))
}

#[derive(Deserialize)]
pub struct Reply {
    decision: Decision,
}

pub async fn decide(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(reply): Json<Reply>,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    if !state.bridge.resolve_proposal(&id, reply.decision) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(json!({"ok": true})))
}
