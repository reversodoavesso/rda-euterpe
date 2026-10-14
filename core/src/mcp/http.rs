//! Transporte Streamable HTTP do MCP: `POST /mcp` (JSON ou SSE), `GET` e
//! `DELETE` (encerramento de sessão).
//!
//! Negociação de `Accept`:
//!  - `application/json` (ou ausente) → resposta JSON única;
//!  - `text/event-stream` → a **mesma** resposta JSON-RPC embrulhada num evento
//!    `message` do SSE (é o que clientes MCP modernos pedem por padrão).
//!
//! Sessões: `initialize` cria e devolve `Mcp-Session-Id`. Por tolerância, métodos
//! seguintes sem o header continuam funcionando (modo stateless) — isso mantém o
//! smoke test de 1 linha do PLAN-REFACTOR válido.

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use super::jsonrpc::{Error, Request, Response as RpcResponse, INVALID_REQUEST, PARSE_ERROR};
use super::server;
use crate::AppState;

pub const SESSION_HEADER: &str = "mcp-session-id";

fn sessions() -> &'static Mutex<HashSet<String>> {
    static SESSIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn session_count() -> usize {
    sessions().lock().len()
}

fn wants_sse(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false)
}

/// `POST /mcp`
pub async fn post(State(state): State<AppState>, headers: HeaderMap, body: String) -> Response {
    let state = Arc::new(state);
    let parsed = match serde_json::from_str::<Value>(&body) {
        Ok(v) => v,
        Err(err) => {
            return json_or_sse(
                wants_sse(&headers),
                &RpcResponse::fail(
                    Value::Null,
                    Error::new(PARSE_ERROR, format!("Parse error: {err}")),
                ),
                None,
            )
        }
    };

    let request: Request = match serde_json::from_value(parsed) {
        Ok(r) => r,
        Err(err) => {
            return json_or_sse(
                wants_sse(&headers),
                &RpcResponse::fail(
                    Value::Null,
                    Error::new(INVALID_REQUEST, format!("Invalid Request: {err}")),
                ),
                None,
            )
        }
    };

    let is_initialize = request.method == "initialize";
    if request.is_notification() {
        // Notification: sem resposta (200 vazio), como manda o JSON-RPC.
        let _ = server::dispatch(&state, &request.method, &request.params).await;
        return (StatusCode::ACCEPTED, ()).into_response();
    }

    let id = request.id.clone().unwrap_or(Value::Null);
    let result = server::dispatch(&state, &request.method, &request.params).await;
    let response = match result {
        Ok(result) => RpcResponse::ok(id, result),
        Err(error) => RpcResponse::fail(id, error),
    };

    let session_id = if is_initialize {
        let sid = uuid::Uuid::new_v4().to_string();
        sessions().lock().insert(sid.clone());
        Some(sid)
    } else {
        headers
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };

    json_or_sse(wants_sse(&headers), &response, session_id.as_deref())
}

fn json_or_sse(wants_sse: bool, response: &RpcResponse, session_id: Option<&str>) -> Response {
    let payload = serde_json::to_string(response).unwrap_or_else(|_| "{}".to_string());
    let mut builder = Response::builder().status(StatusCode::OK);
    if let Some(sid) = session_id {
        builder = builder.header(SESSION_HEADER, sid);
    }
    if wants_sse {
        let body = format!("event: message\ndata: {payload}\n\n");
        builder
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(axum::body::Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    } else {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(payload))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

/// `GET /mcp` — este servidor não abre stream proativo; devolve 405 com `Allow`.
pub async fn get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
        Json(json!({ "error": "method_not_allowed", "hint": "use POST para JSON-RPC e DELETE para encerrar a sessão" })),
    )
        .into_response()
}

/// `DELETE /mcp` — encerra a sessão.
pub async fn delete(headers: HeaderMap) -> Response {
    let removed = headers
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|sid| sessions().lock().remove(sid))
        .unwrap_or(false);
    Json(json!({ "ok": true, "removed": removed, "sessions": session_count() })).into_response()
}

/// `PUT /mcp/...` — usado só para devolver 405 explícito.
pub async fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
        Json(json!({ "error": "method_not_allowed" })),
    )
        .into_response()
}

/// Executa uma chamada JSON-RPC crua (usada pelo shim stdio e pelos testes).
pub async fn call_raw(state: &Arc<AppState>, request: &Value) -> Value {
    let Ok(req) = serde_json::from_value::<Request>(request.clone()) else {
        return serde_json::to_value(RpcResponse::fail(
            Value::Null,
            Error::new(INVALID_REQUEST, "Invalid Request"),
        ))
        .unwrap_or(Value::Null);
    };
    let id = req.id.clone().unwrap_or(Value::Null);
    match server::dispatch(state, &req.method, &req.params).await {
        Ok(result) => serde_json::to_value(RpcResponse::ok(id, result)).unwrap_or(Value::Null),
        Err(error) => serde_json::to_value(RpcResponse::fail(id, error)).unwrap_or(Value::Null),
    }
}

/// `GET /mcp/info` — descobrir o endpoint sem falar JSON-RPC (a UI nova usa).
pub async fn info(State(state): State<AppState>) -> Response {
    let sid = uuid::Uuid::new_v4().to_string();
    sessions().lock().insert(sid.clone());
    Json(json!({
        "app": "euterpe",
        "protocol": super::jsonrpc::DEFAULT_PROTOCOL,
        "sessions": session_count(),
        "url": format!("http://{}:{}/mcp", state.cfg.host, state.cfg.port),
        "stdio": { "command": "euterpe", "args": ["mcp", "--stdio"] },
        "sessionId": sid,
    }))
    .into_response()
}
