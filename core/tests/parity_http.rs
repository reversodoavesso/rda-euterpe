//! Paridade das rotas HTTP (contrato C5) + rotas aditivas.

mod common;

use common::*;
use serde_json::json;

async fn get(daemon: &TestDaemon, path: &str) -> (u16, serde_json::Value) {
    let res = daemon
        .http()
        .get(format!("{}{path}", daemon.base()))
        .send()
        .await
        .expect("get");
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

#[tokio::test]
async fn config_exposes_secret_and_version() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/config").await;
    assert_eq!(status, 200);
    assert_eq!(body["secret"], daemon.secret());
    assert_eq!(body["version"], euterpe::VERSION);
    assert_eq!(body["app"], "euterpe");

    // CORS liberado (a UI roda na origem do Spotify).
    let res = daemon
        .http()
        .get(format!("{}/config", daemon.base()))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
}

#[tokio::test]
async fn health_reports_app_euterpe() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/health").await;
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(body["app"], "euterpe", "campo aditivo que o --ensure usa");
    assert_eq!(body["version"], euterpe::VERSION);
}

#[tokio::test]
async fn sessions_list_and_read_round_trip() {
    let daemon = spawn().await;
    let (_, empty) = get(&daemon, "/sessions").await;
    assert_eq!(empty, json!([]));

    euterpe::logging::log_session(
        &daemon.state.cfg.sessions_dir,
        "sess-http",
        "session.start",
        Some(json!({ "text": "oi" })),
    );
    let (_, list) = get(&daemon, "/sessions").await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], "sess-http");
    assert_eq!(list[0]["events"], 1);
    assert!(list[0]["file"].as_str().unwrap().ends_with(".log"));

    let (_, events) = get(&daemon, "/sessions/sess-http").await;
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(events[0]["event"], "session.start");
    assert_eq!(events[0]["payload"]["text"], "oi");

    // Sessão inexistente devolve lista vazia (não erro).
    let (status, missing) = get(&daemon, "/sessions/nao-existe").await;
    assert_eq!(status, 200);
    assert_eq!(missing, json!([]));
}

#[tokio::test]
async fn probe_is_503_without_a_client() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/probe").await;
    assert_eq!(status, 503);
    assert_eq!(body["error"], "no_client_connected");
}

#[tokio::test]
async fn probe_writes_a_file_and_returns_a_tiny_body() {
    let daemon = spawn().await;
    let _ext = fake_extension(
        &daemon,
        |_name, _args| json!({ "guard": { "spicetifyVersion": "2.38" } }),
    );
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (status, body) = get(&daemon, "/probe").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], true);
    let file = body["file"].as_str().unwrap();
    assert!(file.ends_with(".json"));
    assert!(
        std::path::Path::new(file).exists(),
        "o probe precisa gravar em disco"
    );
    assert!(body["bytes"].as_u64().unwrap() > 0);
    // A resposta HTTP é minúscula de propósito.
    assert!(body.to_string().len() < 500);
}

#[tokio::test]
async fn providers_never_leak_keys() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/providers").await;
    assert_eq!(status, 200);
    assert_eq!(body["app"], "euterpe");
    let providers = body["providers"].as_array().unwrap();
    assert!(providers.iter().any(|p| p["id"] == "deepseek"));
    assert!(providers.iter().any(|p| p["id"] == "anthropic"));
    assert!(providers.iter().any(|p| p["id"] == "gemini"));
    assert!(providers.iter().any(|p| p["id"] == "ollama"));
    assert!(providers.iter().any(|p| p["id"] == "custom"));
    for p in providers {
        assert!(p.get("apiKey").is_none(), "chave vazando na API pública");
        assert!(p["hasKey"].is_boolean());
    }
    assert_eq!(body["active"]["provider"], "deepseek");
}

#[tokio::test]
async fn settings_get_and_patch_round_trip() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/settings").await;
    assert_eq!(status, 200);
    assert_eq!(
        body["settings"]["mutationPolicy"], "allow",
        "D3: allow por padrão"
    );
    assert_eq!(body["settings"]["suggestions"], true);
    assert!(body["runtime"]["port"].is_u64());
    assert!(!body["runtime"]["dataDir"].as_str().unwrap().is_empty());
    assert_eq!(body["runtime"]["upstream"], false);

    let res = daemon
        .http()
        .put(format!("{}/settings", daemon.base()))
        .json(&json!({
            "mutationPolicy": "confirm",
            "suggestions": false,
            "maxToolSteps": 5,
            "webSearch": "duckduckgo",
            "activeModel": "modelo-x"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["settings"]["mutationPolicy"], "confirm");
    assert_eq!(body["settings"]["suggestions"], false);
    assert_eq!(body["settings"]["maxToolSteps"], 5);
    assert_eq!(body["settings"]["webSearch"], "duckduckgo");
    assert_eq!(body["settings"]["activeModel"], "modelo-x");
    assert!(body["applied"].as_array().unwrap().len() >= 5);

    // Persistiu no banco.
    let (_, again) = get(&daemon, "/settings").await;
    assert_eq!(again["settings"]["mutationPolicy"], "confirm");
}

#[tokio::test]
async fn settings_ignores_invalid_enum_values() {
    let daemon = spawn().await;
    let res = daemon
        .http()
        .put(format!("{}/settings", daemon.base()))
        .json(&json!({ "mutationPolicy": "banana", "webSearch": "nope" }))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(
        body["settings"]["mutationPolicy"], "allow",
        "valor inválido não pode ser aplicado"
    );
    assert_eq!(body["settings"]["webSearch"], "auto");
}

#[tokio::test]
async fn models_rejects_unknown_provider_and_missing_key() {
    let daemon = spawn().await;
    let (status, body) = get(&daemon, "/models?provider=inexistente").await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], "unknown_provider");

    // Provider remoto sem chave: 400 explícito, sem tocar a rede.
    let (status, body) = get(&daemon, "/models?provider=openai").await;
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .starts_with("missing_api_key:"),
        "{body}"
    );
}

#[tokio::test]
async fn providers_upsert_and_delete_are_key_safe() {
    let daemon = spawn().await;
    let res = daemon
        .http()
        .post(format!("{}/providers", daemon.base()))
        .json(&json!({
            "id": "meu-vllm",
            "kind": "openai-compat",
            "baseUrl": "http://127.0.0.1:9999/v1",
            "apiKey": "sk-de-teste",
            "defaultModel": "meu-modelo"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["provider"]["id"], "meu-vllm");
    assert_eq!(body["provider"]["hasKey"], true);
    assert!(
        !body.to_string().contains("sk-de-teste"),
        "a chave não pode voltar na resposta"
    );

    let res = daemon
        .http()
        .delete(format!("{}/providers/meu-vllm", daemon.base()))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["hasKey"], false);
}

#[tokio::test]
async fn mcp_protocol_over_http() {
    let daemon = spawn().await;
    let client = daemon.http();
    let url = format!("{}/mcp", daemon.base());

    let init = client
        .post(&url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name":"smoke","version":"0"} }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(init.status().as_u16(), 200);
    assert!(
        init.headers().get("mcp-session-id").is_some(),
        "initialize cria sessão"
    );
    let body: serde_json::Value = init.json().await.unwrap();
    assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(body["result"]["serverInfo"]["name"], "euterpe");
    assert_eq!(
        body["result"]["capabilities"]["tools"]["listChanged"],
        false
    );

    let listed = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = listed.json().await.unwrap();
    assert_eq!(body["result"]["tools"].as_array().unwrap().len(), 45);

    // Método desconhecido ⇒ -32601.
    let unknown = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 3, "method": "nope", "params": {} }))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = unknown.json().await.unwrap();
    assert_eq!(body["error"]["code"], -32601);

    // Tool desconhecida ⇒ isError (nunca throw).
    let bad_tool = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "spotify_nao_existe", "arguments": {} } }))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = bad_tool.json().await.unwrap();
    assert_eq!(body["result"]["isError"], true);

    // Sem cliente ⇒ client_offline em isError.
    let offline = client
        .post(&url)
        .json(&json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "spotify_get_playlists", "arguments": {} } }))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = offline.json().await.unwrap();
    assert_eq!(body["result"]["isError"], true);
    assert!(body["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("client_offline"));

    // Accept SSE devolve o mesmo payload embrulhado em `event: message`.
    let sse = client
        .post(&url)
        .header("accept", "text/event-stream")
        .json(&json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": {} }))
        .send()
        .await
        .unwrap();
    assert!(sse.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let text = sse.text().await.unwrap();
    assert!(text.starts_with("event: message\ndata: {"), "{text}");

    // GET é 405 com Allow; DELETE encerra a sessão.
    let get_res = client.get(&url).send().await.unwrap();
    assert_eq!(get_res.status().as_u16(), 405);
    assert!(get_res.headers().get("allow").is_some());
    let del = client.delete(&url).send().await.unwrap();
    assert_eq!(del.status().as_u16(), 200);
}

#[tokio::test]
async fn chat_sse_emits_status_stream_and_done() {
    let daemon = spawn().await;
    let res = daemon
        .http()
        .post(format!("{}/chat", daemon.base()))
        .json(&json!({ "text": "oi", "sessionId": "sse-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert!(res.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let text = res.text().await.unwrap();
    // Sem provider configurado, o chat degrada com o fallback + done.
    assert!(
        text.contains("event: stream") || text.contains("event: done"),
        "{text}"
    );
    assert!(
        text.contains("event: done"),
        "chat.done é obrigatório: {text}"
    );
    assert!(text.contains("sse-1"));
}
