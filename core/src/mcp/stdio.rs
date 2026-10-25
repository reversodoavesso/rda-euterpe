//! `euterpe mcp --stdio` — shim de proxy.
//!
//! Clientes MCP que não falam Streamable HTTP (ou preferem subprocess) usam este
//! modo: o processo lê JSON-RPC linha a linha do `stdin`, encaminha por HTTP ao
//! daemon local e escreve a resposta no `stdout`.
//!
//! Regra dura: **`stdout` é só protocolo**. Todo log vai para `stderr` (um `print`
//! acidental no stdout corromperia o stream JSON-RPC).

use serde_json::Value;
use std::io::{BufRead, Write};
use std::sync::Arc;

use crate::AppState;

/// Roda o shim contra um `AppState` local (sem abrir socket extra).
pub async fn run_in_process(state: Arc<AppState>) -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(trimmed) {
            Ok(request) => super::http::call_raw(&state, &request).await,
            Err(err) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": super::jsonrpc::PARSE_ERROR, "message": format!("Parse error: {err}") },
            }),
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}

/// Roda o shim encaminhando para um daemon já em execução (usado pelo CLI).
pub async fn run_proxy(host: &str, port: u16, secret: Option<String>) -> anyhow::Result<()> {
    let url = format!("http://{host}:{port}/mcp");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut req = client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(trimmed.to_string());
        if let Some(secret) = secret.as_deref() {
            req = req.header("x-euterpe-secret", secret).bearer_auth(secret);
        }
        let response = match req.send().await {
            Ok(res) => res.text().await.unwrap_or_else(|e| {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32603, "message": format!("read body: {e}") },
                })
                .to_string()
            }),
            Err(err) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32603, "message": format!("daemon unreachable: {err}") },
            })
            .to_string(),
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn in_process_dispatch_answers_initialize() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Config::for_test(dir.path().to_path_buf())).unwrap());
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name":"t","version":"0"} }
        });
        let response = super::super::http::call_raw(&state, &request).await;
        assert_eq!(response["result"]["serverInfo"]["name"], "euterpe");
    }

    #[tokio::test]
    async fn in_process_dispatch_reports_method_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Config::for_test(dir.path().to_path_buf())).unwrap());
        let request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"nope","params":{}});
        let response = super::super::http::call_raw(&state, &request).await;
        assert_eq!(
            response["error"]["code"],
            super::super::jsonrpc::METHOD_NOT_FOUND
        );
    }
}
