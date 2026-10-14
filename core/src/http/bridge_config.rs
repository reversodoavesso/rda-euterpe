//! `/config` (C5) — segredo do handshake + versão.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::AppState;

pub async fn config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "secret": state.cfg.ws_secret,
        "version": crate::VERSION,
        // Aditivo: a UI nova usa para saber se há extensão viva.
        "clients": state.bridge.client_count(),
        "app": "euterpe",
    }))
}
