//! Contratos das rotas de perfis, armazenamento e do gate do MCP (estágio B).
//!
//! O que estes testes protegem: um perfil não é decoração — ao trocar o perfil
//! ativo, `activeProvider`/`activeModel` mudam de verdade (é isso que o loop LLM
//! consome). O resto são contratos de falha explícita: escopo inválido é 400,
//! perfil inexistente é 404, MCP desligado é 404.

mod common;

use common::*;
use serde_json::{json, Value};

async fn get_settings(client: &reqwest::Client, base: &str) -> Value {
    client
        .get(format!("{base}/settings"))
        .send()
        .await
        .expect("GET /settings")
        .json()
        .await
        .expect("json")
}

async fn put_settings(client: &reqwest::Client, base: &str, patch: Value) -> Value {
    client
        .put(format!("{base}/settings"))
        .json(&patch)
        .send()
        .await
        .expect("PUT /settings")
        .json()
        .await
        .expect("json")
}

#[tokio::test]
async fn a_profile_is_what_actually_drives_provider_and_model() {
    let daemon = spawn().await;
    let client = daemon.http();
    let base = daemon.base();

    // Sem perfis criados, a UI não fica órfã: há sempre um sintetizado.
    let before = get_settings(&client, &base).await;
    assert_eq!(before["settings"]["activeProfile"], "default");
    assert!(
        !before["settings"]["profiles"]
            .as_array()
            .unwrap()
            .is_empty(),
        "profiles nunca vazio"
    );

    let applied = put_settings(
        &client,
        &base,
        json!({
            "profiles": [
                { "id": "sol", "name": "Sol", "provider": "deepseek", "model": "deepseek-flash" },
                { "id": "barato", "name": "Barato", "provider": "groq", "model": "llama-3.3-70b" },
            ],
            "activeProfile": "barato",
        }),
    )
    .await;
    assert!(applied["applied"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "profiles"));

    let after = get_settings(&client, &base).await;
    assert_eq!(after["settings"]["activeProvider"], "groq");
    assert_eq!(after["settings"]["activeModel"], "llama-3.3-70b");
    assert_eq!(after["settings"]["activeProfile"], "barato");
    assert_eq!(after["settings"]["profiles"].as_array().unwrap().len(), 2);

    // `profiles: []` reseta e devolve o sintetizado (não deixa a UI travada).
    put_settings(&client, &base, json!({ "profiles": [] })).await;
    let reset = get_settings(&client, &base).await;
    assert_eq!(reset["settings"]["activeProfile"], "default");
}

#[tokio::test]
async fn roles_and_session_overrides_are_echoed_back() {
    let daemon = spawn().await;
    let client = daemon.http();
    let base = daemon.base();

    put_settings(
        &client,
        &base,
        json!({
            "profiles": [
                { "id": "pro", "name": "Pro", "provider": "openai", "model": "gpt-4o" },
            ],
            "roles": null,
            "roleProfiles": { "curation": "pro" },
            "sessionOverrides": { "s-42": "pro" },
        }),
    )
    .await;

    let s = get_settings(&client, &base).await;
    assert_eq!(s["settings"]["roleProfiles"]["curation"], "pro");
    assert_eq!(s["settings"]["sessionOverrides"]["s-42"], "pro");
    // Papel de curadoria com outro provider propaga para o par de curadoria.
    assert_eq!(s["settings"]["curationProvider"], "openai");
    assert_eq!(s["settings"]["curationModel"], "gpt-4o");
    // O papel de curadoria rotula o perfil para o chip da UI.
    let profiles = s["settings"]["profiles"].as_array().unwrap();
    assert_eq!(profiles[0]["role"], "curation");
}

#[tokio::test]
async fn instructions_and_the_mcp_toggle_are_persisted() {
    let daemon = spawn().await;
    let client = daemon.http();
    let base = daemon.base();

    let s = get_settings(&client, &base).await;
    assert_eq!(s["settings"]["mcpEnabled"], true);
    assert_eq!(s["settings"]["instructions"], "");

    put_settings(
        &client,
        &base,
        json!({ "instructions": "Sempre cite o BPM.", "mcpEnabled": false }),
    )
    .await;

    let after = get_settings(&client, &base).await;
    assert_eq!(after["settings"]["instructions"], "Sempre cite o BPM.");
    assert_eq!(after["settings"]["mcpEnabled"], false);

    // MCP desligado ⇒ o endpoint some (404), não aceita-e-ignora.
    let rpc = client
        .post(format!("{base}/mcp"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("POST /mcp");
    assert_eq!(rpc.status(), 404);

    put_settings(&client, &base, json!({ "mcpEnabled": true })).await;
    let on = client
        .post(format!("{base}/mcp"))
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .expect("POST /mcp");
    assert_ne!(on.status(), 404, "com o MCP ligado o endpoint responde");
}

#[tokio::test]
async fn an_unknown_profile_test_is_404_and_a_known_one_is_not_a_silent_ok() {
    let daemon = spawn().await;
    let client = daemon.http();
    let base = daemon.base();

    let missing = client
        .post(format!("{base}/profiles/fantasma/test"))
        .send()
        .await
        .expect("POST /profiles/fantasma/test");
    assert_eq!(missing.status(), 404);

    // Perfil real mas sem chave: falha explicitamente (não devolve ok).
    put_settings(
        &client,
        &base,
        json!({
            "profiles": [
                { "id": "sol", "name": "Sol", "provider": "deepseek", "model": "deepseek-flash" },
            ],
            "activeProfile": "sol",
        }),
    )
    .await;
    let real = client
        .post(format!("{base}/profiles/sol/test"))
        .send()
        .await
        .expect("POST /profiles/sol/test");
    let body: Value = real.json().await.expect("json");
    assert_eq!(body["ok"], false);
    assert!(body["error"].is_string() || body["detail"].is_string() || body["report"].is_object());
}

#[tokio::test]
async fn storage_reports_and_erases_only_with_an_explicit_scope() {
    let daemon = spawn().await;
    let client = daemon.http();
    let base = daemon.base();

    let info: Value = client
        .get(format!("{base}/storage"))
        .send()
        .await
        .expect("GET /storage")
        .json()
        .await
        .expect("json");
    assert!(info["dataDir"].is_string());
    assert!(info["db"]["rows"]["conversations"].is_number());
    assert!(info["sessions"]["files"].is_number());

    let bad = client
        .post(format!("{base}/storage/erase"))
        .json(&json!({ "scope": "tudo" }))
        .send()
        .await
        .expect("POST /storage/erase");
    assert_eq!(
        bad.status(),
        400,
        "escopo desconhecido não pode apagar nada"
    );

    let ok: Value = client
        .post(format!("{base}/storage/erase"))
        .json(&json!({ "scope": "history" }))
        .send()
        .await
        .expect("POST /storage/erase")
        .json()
        .await
        .expect("json");
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["scope"], "history");
    assert!(ok["deleted"]["conversations"].is_number());
}
