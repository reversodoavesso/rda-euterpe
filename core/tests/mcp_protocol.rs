//! Paridade do protocolo MCP (Fase 3), no nível do dispatch.

use euterpe::config::Config;
use euterpe::mcp::{jsonrpc, server};
use euterpe::AppState;
use serde_json::json;
use std::sync::Arc;

fn state() -> Arc<AppState> {
    let dir = tempfile::tempdir().unwrap();
    Arc::new(AppState::new(Config::for_test(dir.path().to_path_buf())).unwrap())
}

#[tokio::test]
async fn initialize_negotiates_the_protocol_version_with_a_whitelist() {
    let state = state();
    for supported in jsonrpc::SUPPORTED_PROTOCOLS {
        let result = server::dispatch(
            &state,
            "initialize",
            &json!({ "protocolVersion": supported, "capabilities": {}, "clientInfo": {"name":"t","version":"0"} }),
        )
        .await
        .unwrap();
        assert_eq!(result["protocolVersion"], *supported);
    }
    // Versão fora da whitelist cai no default (não quebra o cliente).
    let result = server::dispatch(
        &state,
        "initialize",
        &json!({ "protocolVersion": "1999-01-01" }),
    )
    .await
    .unwrap();
    assert_eq!(result["protocolVersion"], jsonrpc::DEFAULT_PROTOCOL);
    assert_eq!(
        result["capabilities"]["tools"]["listChanged"], false,
        "catálogo congelado (C6)"
    );
    assert_eq!(result["serverInfo"]["name"], "euterpe");
}

#[tokio::test]
async fn notifications_and_ping_are_accepted() {
    let state = state();
    for method in [
        "notifications/initialized",
        "notifications/cancelled",
        "ping",
    ] {
        let result = server::dispatch(&state, method, &json!({})).await;
        assert!(result.is_ok(), "{method} deveria ser aceito");
    }
}

#[tokio::test]
async fn tools_list_equals_the_frozen_catalog() {
    let state = state();
    let result = server::dispatch(&state, "tools/list", &json!({}))
        .await
        .unwrap();
    let tools = result["tools"].as_array().unwrap();
    assert_eq!(tools.len(), euterpe::tools::catalog::all().len());
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"spotify_get_currently_playing"));
    assert!(names.contains(&"spotify_undo_last_mutation"));
    assert!(names.contains(&"spotify_create_playlist"));
    // `spotify_` em todas (renomear = breaking change).
    assert!(names.iter().all(|n| n.starts_with("spotify_")));
}

#[tokio::test]
async fn unknown_method_is_minus_32601() {
    let state = state();
    let err = server::dispatch(&state, "nao/existe", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(err.code, jsonrpc::METHOD_NOT_FOUND);
}

#[tokio::test]
async fn unknown_tool_is_iserror_and_not_an_exception() {
    let state = state();
    let result = server::dispatch(
        &state,
        "tools/call",
        &json!({ "name": "spotify_nao_existe", "arguments": {} }),
    )
    .await
    .expect("tool desconhecida NÃO é erro de protocolo");
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("unknown_tool"));
}

#[tokio::test]
async fn tools_call_without_arguments_key_defaults_to_empty_object() {
    let state = state();
    let result = server::dispatch(
        &state,
        "tools/call",
        &json!({ "name": "spotify_get_playlists" }),
    )
    .await
    .unwrap();
    // Sem cliente conectado ⇒ client_offline, mas o protocolo não quebra.
    assert_eq!(result["isError"], true);
}

#[tokio::test]
async fn tools_call_requires_a_name() {
    let state = state();
    let err = server::dispatch(&state, "tools/call", &json!({}))
        .await
        .unwrap_err();
    assert_eq!(err.code, jsonrpc::INVALID_PARAMS);
}

#[tokio::test]
async fn resources_and_prompts_are_exposed() {
    let state = state();
    let resources = server::dispatch(&state, "resources/list", &json!({}))
        .await
        .unwrap();
    let uris: Vec<&str> = resources["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["uri"].as_str().unwrap())
        .collect();
    assert_eq!(
        uris,
        vec![
            "euterpe://playlists",
            "euterpe://currently-playing",
            "euterpe://voice"
        ]
    );

    let prompts = server::dispatch(&state, "prompts/list", &json!({}))
        .await
        .unwrap();
    assert_eq!(prompts["prompts"][0]["name"], "curate-playlist");

    let prompt = server::dispatch(
        &state,
        "prompts/get",
        &json!({ "name": "curate-playlist", "arguments": { "brief": "chuva" } }),
    )
    .await
    .unwrap();
    let text = prompt["messages"][0]["content"]["text"].as_str().unwrap();
    assert!(text.contains("chuva"));
}

#[tokio::test]
async fn reading_an_unknown_resource_is_invalid_params() {
    let state = state();
    let err = server::dispatch(
        &state,
        "resources/read",
        &json!({ "uri": "euterpe://nada" }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, jsonrpc::INVALID_PARAMS);
}

#[tokio::test]
async fn reading_a_known_resource_without_a_client_reports_offline() {
    let state = state();
    let err = server::dispatch(
        &state,
        "resources/read",
        &json!({ "uri": "euterpe://playlists" }),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("client_offline"));
}

#[tokio::test]
async fn reading_voice_resource_returns_voice_guidelines_without_client() {
    let state = state();
    let res = server::dispatch(
        &state,
        "resources/read",
        &json!({ "uri": "euterpe://voice" }),
    )
    .await
    .unwrap();
    let text = res["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("Euterpe"));
    assert!(text.contains("thinkingVerbs"));
}

#[test]
fn session_requirement_matches_the_spec() {
    assert!(!server::requires_session("initialize"));
    assert!(!server::requires_session("notifications/initialized"));
    assert!(!server::requires_session("ping"));
    assert!(server::requires_session("tools/list"));
    assert!(server::requires_session("tools/call"));
}

#[test]
fn jsonrpc_round_trip_shape() {
    let response = jsonrpc::Response::ok(json!(7), json!({"a": 1}));
    let value = serde_json::to_value(&response).unwrap();
    assert_eq!(value["jsonrpc"], "2.0");
    assert_eq!(value["id"], 7);
    assert_eq!(value["result"]["a"], 1);
}
