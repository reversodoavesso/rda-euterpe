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
        "clients": state.bridge.client_count(),
        "upstream": state.upstream.enabled(),
    }))
}
