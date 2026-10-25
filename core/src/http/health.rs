//! `/health` (C5) — `{ok:true}` no Node; aqui acrescentamos `app` (aditivo, §71)
//! para que `euterpe --ensure` distinga o daemon de qualquer outro processo na
//! porta 8337.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::AppState;

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "app": "euterpe",
        "version": crate::VERSION,
        "pid": std::process::id(),
        "executable": std::env::current_exe().ok().map(|p| p.display().to_string()),
        "clients": state.bridge.client_count(),
        "spotify_backend": if state.bridge.is_headless() { "headless" } else { "desktop" },
        "upstream": state.upstream.enabled(),
    }))
}
