//! `/probe` (C5) — roda o inventário read-only **dentro** do Spotify e grava em
//! `data/probes/`. A resposta HTTP é minúscula por design (o payload é grande e
//! é para ler do disco, não colar no DevTools).

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::sync::Arc;

use crate::protocol::ToolResult;
use crate::AppState;

pub async fn probe(State(state): State<AppState>) -> Response {
    if !state.bridge.has_client() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no_client_connected" })),
        )
            .into_response();
    }
    let call_id = format!("probe_{}", uuid::Uuid::new_v4());
    let result: ToolResult = state
        .bridge
        .raw_call(&state.cfg, &call_id, "probe", json!({}), None)
        .await;
    if !result.ok {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": result.code.unwrap_or_else(|| "probe_failed".to_string()) })),
        )
            .into_response();
    }
    let data = result.data.unwrap_or(serde_json::Value::Null);
    let body = serde_json::to_string_pretty(&data).unwrap_or_default();
    let bytes = body.len();
    let dir = state.cfg.probes_dir.clone();
    let write = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        crate::paths::ensure_dir(&dir)?;
        let file = dir.join(format!(
            "probe-{}.json",
            chrono::Utc::now().timestamp_millis()
        ));
        std::fs::write(&file, body)?;
        Ok(file.display().to_string())
    })
    .await;
    match write {
        Ok(Ok(file)) => Json(json!({ "ok": true, "file": file, "bytes": bytes })).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "falha ao escrever o probe");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "probe_write_failed" })),
            )
                .into_response()
        }
        Err(err) => {
            tracing::error!(error = %err, "task do probe falhou");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "probe_write_failed" })),
            )
                .into_response()
        }
    }
}

/// Mantido para reuso interno (a UI pode pedir o probe em memória).
pub async fn probe_payload(state: &Arc<AppState>) -> ToolResult {
    let call_id = format!("probe_{}", uuid::Uuid::new_v4());
    state
        .bridge
        .raw_call(&state.cfg, &call_id, "probe", json!({}), None)
        .await
}
