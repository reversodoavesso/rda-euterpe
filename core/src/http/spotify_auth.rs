//! Pareamento por código: a UI recebe somente URL/código/estado da autorização.
use crate::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

async fn forward(state: AppState, action: &str) -> Response {
    if !state.bridge.is_headless() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"headless_not_configured"})),
        )
            .into_response();
    }
    match state.bridge.headless_auth(action).await {
        Ok((status, body)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(body),
        )
            .into_response(),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"headless_auth_unavailable"})),
        )
            .into_response(),
    }
}
pub async fn status(State(state): State<AppState>) -> Response {
    forward(state, "status").await
}
pub async fn start(State(state): State<AppState>) -> Response {
    forward(state, "start").await
}
pub async fn cancel(State(state): State<AppState>) -> Response {
    forward(state, "cancel").await
}
