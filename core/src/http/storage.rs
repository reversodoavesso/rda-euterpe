//! `GET /storage` e `POST /storage/erase` — lastro da página "Armazenamento" da UI.
//!
//! Regra que este módulo obedece: **nada destrutivo é implícito**. `erase` exige um
//! `scope` explícito, devolve o que apagou e nunca existe um "apagar tudo" sem
//! escopo nomeado. (O registro de Risco do BRAND-VOICE.md §3 vale para a copy; aqui
//! vale para o contrato.)

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;

/// `(arquivos, bytes)` de um diretório, sem seguir links e tolerando ausência.
fn dir_stats(dir: &std::path::Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

fn db_stats(state: &AppState) -> Value {
    let counts: Vec<(&str, i64)> = vec![
        (
            "conversations",
            state
                .store
                .with(|c| c.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0)))
                .unwrap_or(0),
        ),
        (
            "snapshots",
            state
                .store
                .with(|c| c.query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0)))
                .unwrap_or(0),
        ),
    ];
    let bytes = std::fs::metadata(&state.cfg.db_path)
        .map(|m| m.len())
        .unwrap_or(0);
    json!({
        "bytes": bytes,
        "rows": counts.into_iter().collect::<std::collections::BTreeMap<&str, i64>>(),
    })
}

pub async fn get(State(state): State<AppState>) -> Json<Value> {
    let (session_files, session_bytes) = dir_stats(&state.cfg.sessions_dir);
    let (probe_files, probe_bytes) = dir_stats(&state.cfg.probes_dir);
    Json(json!({
        "dataDir": state.cfg.data_dir.display().to_string(),
        "db": db_stats(&state),
        "sessions": { "files": session_files, "bytes": session_bytes },
        "probes": { "files": probe_files, "bytes": probe_bytes },
    }))
}

#[derive(Debug, Deserialize)]
pub struct EraseRequest {
    /// `history` (mensagens) · `snapshots` (desfazer) · `sessions` (logs) · `all`.
    pub scope: String,
    /// Opcional: limita o escopo `history` a uma conversa.
    #[serde(default, rename = "sessionId")]
    pub session_id: Option<String>,
}

pub async fn erase(State(state): State<AppState>, Json(body): Json<EraseRequest>) -> Response {
    let scope = body.scope.trim().to_ascii_lowercase();
    let mut deleted = json!({});

    let del_rows = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> i64 {
        state
            .store
            .with(|c| Ok(c.execute(sql, params)? as i64))
            .unwrap_or(0)
    };

    match scope.as_str() {
        "history" => {
            let n = match body.session_id.as_deref() {
                Some(id) => del_rows("DELETE FROM conversations WHERE session_id = ?", &[&id]),
                None => del_rows("DELETE FROM conversations", &[]),
            };
            deleted["conversations"] = json!(n);
        }
        "snapshots" => {
            deleted["snapshots"] = json!(del_rows("DELETE FROM snapshots", &[]));
        }
        "sessions" => {
            let mut n = 0i64;
            if let Ok(entries) = std::fs::read_dir(&state.cfg.sessions_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
                        n += 1;
                    }
                }
            }
            deleted["sessionLogs"] = json!(n);
        }
        "all" => {
            deleted["conversations"] = json!(del_rows("DELETE FROM conversations", &[]));
            deleted["snapshots"] = json!(del_rows("DELETE FROM snapshots", &[]));
            let mut n = 0i64;
            if let Ok(entries) = std::fs::read_dir(&state.cfg.sessions_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
                        n += 1;
                    }
                }
            }
            deleted["sessionLogs"] = json!(n);
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": "unknown_scope",
                    "expected": ["history", "snapshots", "sessions", "all"],
                })),
            )
                .into_response()
        }
    }

    Json(json!({ "ok": true, "scope": scope, "deleted": deleted })).into_response()
}
