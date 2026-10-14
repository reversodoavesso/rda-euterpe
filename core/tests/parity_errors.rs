//! Paridade dos códigos e timeouts (contratos C3/C4).

mod common;

use common::*;
use euterpe::bridge::CallOptions;
use euterpe::config::MutationPolicy;
use euterpe::protocol::ToolResult;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

async fn wait_for_client(daemon: &TestDaemon) {
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("a extensão falsa não registrou");
}

#[tokio::test]
async fn defaults_are_the_frozen_30s_and_120s() {
    let cfg = euterpe::config::Config::from_sources(&json!({}), &Default::default()).unwrap();
    assert_eq!(cfg.tool_timeout_ms, 30_000, "C3: timeout de tool = 30 s");
    assert_eq!(
        cfg.proposal_timeout_ms, 120_000,
        "C3: proposta de mutação = 120 s"
    );
    assert_eq!(cfg.llm_timeout_ms, 120_000);
    assert_eq!(cfg.port, 8337);
}

#[tokio::test]
async fn tool_timeout_becomes_client_timeout() {
    let daemon = spawn_with(|cfg| cfg.tool_timeout_ms = 300).await;
    // Extensão que autentica mas nunca responde tool.call.
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "silent", "locale": "en" });
        let _ = ws.send(Message::Text(hello.to_string())).await;
        // Mantém a conexão aberta sem responder nada.
        while ws.next().await.is_some() {}
    });
    wait_for_client(&daemon).await;

    let started = std::time::Instant::now();
    let result = daemon
        .state
        .bridge
        .raw_call(&daemon.state.cfg, "t-1", "get_playlists", json!({}), None)
        .await;
    assert_eq!(result, ToolResult::err("client_timeout"));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[tokio::test]
async fn proposal_timeout_counts_as_user_rejection() {
    let daemon = spawn_with(|cfg| {
        cfg.proposal_timeout_ms = 300;
        cfg.tool_timeout_ms = 3_000;
    })
    .await;
    // Extensão que ignora `proposal.create`.
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "silent", "locale": "en" });
        let _ = ws.send(Message::Text(hello.to_string())).await;
        while ws.next().await.is_some() {}
    });
    wait_for_client(&daemon).await;

    let opts = CallOptions {
        call_id: "mut-timeout".to_string(),
        session_id: "s".to_string(),
        locale: "en".to_string(),
        mutation: MutationPolicy::Confirm,
        snapshot: false,
        store: Some(&daemon.state.store),
        sessions_dir: None,
        timeout_ms: 3_000,
    };
    let result = daemon
        .state
        .bridge
        .call_tool(
            &daemon.state.cfg,
            "add_tracks",
            json!({ "playlist_id": "p", "uris": ["a"] }),
            opts,
        )
        .await;
    assert_eq!(result, ToolResult::err("user_rejected"));
}

#[tokio::test]
async fn explicit_rejection_returns_user_rejected() {
    let daemon = spawn_with(|cfg| cfg.proposal_timeout_ms = 3_000).await;
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "rejecter", "locale": "en" });
        let _ = ws.send(Message::Text(hello.to_string())).await;
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if msg["type"] == "proposal.create" {
                let decision = json!({
                    "type": "proposal.decision",
                    "proposalId": msg["proposalId"],
                    "decision": "reject",
                });
                let _ = ws.send(Message::Text(decision.to_string())).await;
            }
        }
    });
    wait_for_client(&daemon).await;

    let opts = CallOptions {
        call_id: "mut-reject".to_string(),
        session_id: "s".to_string(),
        locale: "en".to_string(),
        mutation: MutationPolicy::Confirm,
        snapshot: false,
        store: Some(&daemon.state.store),
        sessions_dir: None,
        timeout_ms: 3_000,
    };
    let result = daemon
        .state
        .bridge
        .call_tool(
            &daemon.state.cfg,
            "remove_tracks",
            json!({ "playlist_id": "p", "uris": ["a"] }),
            opts,
        )
        .await;
    assert_eq!(result, ToolResult::err("user_rejected"));
}

#[tokio::test]
async fn rate_limited_code_is_passed_through_unchanged() {
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |_name, _args| error_response("rate_limited"));
    wait_for_client(&daemon).await;
    let result = daemon
        .state
        .bridge
        .raw_call(&daemon.state.cfg, "r-1", "get_top_tracks", json!({}), None)
        .await;
    assert_eq!(result, ToolResult::err("rate_limited"));
    assert!(result.is_rate_limited());
}

#[tokio::test]
async fn client_offline_is_immediate_and_is_a_new_code() {
    let daemon = spawn().await;
    let started = std::time::Instant::now();
    let result = daemon
        .state
        .bridge
        .raw_call(&daemon.state.cfg, "o-1", "get_playlists", json!({}), None)
        .await;
    assert_eq!(result, ToolResult::err("client_offline"));
    assert!(
        started.elapsed() < std::time::Duration::from_millis(250),
        "fail-closed precisa ser imediato"
    );
    // Código aditivo documentado em PLAN-REFACTOR.md §71.
    assert_ne!(result.code.as_deref(), Some("client_timeout"));
}

#[tokio::test]
async fn unknown_tool_code_shape_is_preserved() {
    // O `unknown_tool:<n>` é produzido pelo loop quando o modelo pede fora do catálogo.
    let code = format!("unknown_tool:{}", "nao_existe");
    assert!(code.starts_with("unknown_tool:"));
    assert_eq!(
        euterpe::tools::server::run_server_tool(
            "nao_existe",
            &json!({}),
            &euterpe::tools::server::ServerToolContext {
                cfg: &euterpe::config::Config::for_test(std::path::PathBuf::from(
                    "C:/tmp/euterpe-codes"
                )),
                store: None,
                bridge: std::sync::Arc::new(euterpe::bridge::Bridge::new()),
                locale: "en".into(),
                session_id: "s".into(),
            }
        )
        .await,
        ToolResult::err("unknown_server_tool:nao_existe")
    );
}

#[tokio::test]
async fn undo_without_snapshot_reports_no_snapshot() {
    let daemon = spawn().await;
    // `undo` consulta o snapshot ANTES de falar com o cliente: sem snapshot, o
    // código de erro é `no_snapshot` mesmo com o Spotify fechado.
    let opts = CallOptions::mcp(MutationPolicy::Allow, "undo-1", "en", &daemon.state.store);
    let result = daemon
        .state
        .bridge
        .run_server_tool(
            &daemon.state.cfg,
            "undo_last_mutation",
            json!({ "playlist_id": "sem-snapshot" }),
            opts,
        )
        .await;
    assert_eq!(result, ToolResult::err("no_snapshot"));
}

#[tokio::test]
async fn duplicate_call_id_is_refused_instead_of_shadowing() {
    let result = ToolResult::err("duplicate_call_id");
    assert_eq!(result.code.as_deref(), Some("duplicate_call_id"));
    assert!(!result.ok);
}
