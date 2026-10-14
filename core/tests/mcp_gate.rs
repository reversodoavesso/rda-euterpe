//! Gate de mutação do MCP (D3): allow / confirm / deny **sempre** com snapshot.

mod common;

use common::*;
use euterpe::mcp::server;
use euterpe::AppState;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// Extensão falsa que aprova propostas e devolve 2 faixas no snapshot.
fn approving_extension(daemon: &TestDaemon) -> tokio::task::JoinHandle<()> {
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "approver", "locale": "en" });
        if ws.send(Message::Text(hello.to_string())).await.is_err() {
            return;
        }
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match msg["type"].as_str() {
                Some("proposal.create") => {
                    let decision = json!({
                        "type": "proposal.decision",
                        "proposalId": msg["proposalId"],
                        "decision": "approve",
                    });
                    let _ = ws.send(Message::Text(decision.to_string())).await;
                }
                Some("tool.call") => {
                    let id = msg["id"].as_str().unwrap_or("").to_string();
                    let is_snapshot = id.starts_with("snap_");
                    let data = if is_snapshot {
                        json!([{ "uri": "spotify:track:a" }, { "uri": "spotify:track:b" }])
                    } else {
                        json!({ "added": 2 })
                    };
                    let payload =
                        json!({ "type": "tool.result", "id": id, "ok": true, "data": data });
                    let _ = ws.send(Message::Text(payload.to_string())).await;
                }
                _ => {}
            }
        }
    })
}

async fn wait_for_client(daemon: &TestDaemon) {
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("a extensão falsa não registrou");
}

async fn mcp_call(state: &AppState, name: &str, args: Value) -> Value {
    server::dispatch(
        state,
        "tools/call",
        &json!({ "name": name, "arguments": args }),
    )
    .await
    .expect("tools/call não deve ser erro de protocolo")
}

fn content_text(result: &Value) -> Value {
    let text = result["content"][0]["text"].as_str().unwrap_or("");
    serde_json::from_str(text).unwrap_or(Value::String(text.to_string()))
}

#[tokio::test]
async fn deny_blocks_the_mutation_before_touching_the_client() {
    let daemon = spawn().await;
    let _ext = approving_extension(&daemon);
    wait_for_client(&daemon).await;
    daemon
        .state
        .settings
        .put(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_POLICY,
            "deny",
        )
        .unwrap();

    let result = mcp_call(
        &daemon.state,
        "spotify_add_tracks",
        json!({ "playlist_id": "p", "uris": ["x"] }),
    )
    .await;
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("mutation_denied"));

    // Nenhum snapshot foi criado (não houve mutação).
    let snapshot = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p")))
        .unwrap();
    assert_eq!(snapshot, None);
}

#[tokio::test]
async fn allow_executes_and_always_carries_snapshot_metadata() {
    let daemon = spawn().await;
    let _ext = approving_extension(&daemon);
    wait_for_client(&daemon).await;
    daemon
        .state
        .settings
        .put(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_POLICY,
            "allow",
        )
        .unwrap();

    let result = mcp_call(
        &daemon.state,
        "spotify_add_tracks",
        json!({ "playlist_id": "p", "uris": ["x", "y"] }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let data = content_text(&result);
    assert_eq!(data["added"], 2);
    assert_eq!(data["undo_hint"], "spotify_undo_last_mutation");
    assert!(
        data["snapshot_id"].as_i64().is_some(),
        "D3: snapshot presente em TODOS os caminhos"
    );

    // O snapshot realmente existe e tem as faixas anteriores.
    let snapshot = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p")))
        .unwrap();
    assert_eq!(
        snapshot,
        Some(vec![
            "spotify:track:a".to_string(),
            "spotify:track:b".to_string()
        ])
    );
}

#[tokio::test]
async fn confirm_goes_through_the_user_proposal_and_still_snapshots() {
    let daemon = spawn_with(|cfg| cfg.proposal_timeout_ms = 5_000).await;
    let _ext = approving_extension(&daemon);
    wait_for_client(&daemon).await;
    daemon
        .state
        .settings
        .put(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_POLICY,
            "confirm",
        )
        .unwrap();

    let result = mcp_call(
        &daemon.state,
        "spotify_add_tracks",
        json!({ "playlist_id": "p", "uris": ["x"] }),
    )
    .await;
    assert_eq!(result["isError"], false, "{result}");
    let data = content_text(&result);
    assert_eq!(data["undo_hint"], "spotify_undo_last_mutation");
    assert!(data["snapshot_id"].as_i64().is_some());

    // O fluxo passou por proposta (registro de auditoria não existe aqui pois o
    // MCP não tem sessions_dir, mas o snapshot prova que a ordem foi correta).
    let snapshot = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p")))
        .unwrap();
    assert!(snapshot.is_some());
}

#[tokio::test]
async fn allowlist_restricts_which_mutations_can_run() {
    let daemon = spawn().await;
    let _ext = approving_extension(&daemon);
    wait_for_client(&daemon).await;
    daemon
        .state
        .settings
        .put_json(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_ALLOWLIST,
            &json!(["add_tracks"]),
        )
        .unwrap();
    daemon
        .state
        .settings
        .put(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_POLICY,
            "allow",
        )
        .unwrap();

    let ok = mcp_call(
        &daemon.state,
        "spotify_add_tracks",
        json!({ "playlist_id": "p", "uris": ["x"] }),
    )
    .await;
    assert_eq!(ok["isError"], false);
    let blocked = mcp_call(
        &daemon.state,
        "spotify_remove_tracks",
        json!({ "playlist_id": "p", "uris": ["x"] }),
    )
    .await;
    assert_eq!(blocked["isError"], true);
    assert!(blocked["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("mutation_denied"));
}

#[tokio::test]
async fn read_only_tools_are_not_gated_by_the_policy() {
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, default_responder);
    wait_for_client(&daemon).await;
    daemon
        .state
        .settings
        .put(
            &daemon.state.store,
            euterpe::store::settings::KEY_MUTATION_POLICY,
            "deny",
        )
        .unwrap();

    let result = mcp_call(
        &daemon.state,
        "spotify_get_playlist_tracks",
        json!({ "playlist_id": "p" }),
    )
    .await;
    assert_eq!(
        result["isError"], false,
        "leitura nunca é bloqueada: {result}"
    );
}

#[tokio::test]
async fn undo_last_mutation_is_exposed_and_uses_the_snapshot() {
    let daemon = spawn().await;
    let _ext = approving_extension(&daemon);
    wait_for_client(&daemon).await;

    // Primeiro uma mutação (allow), que cria o snapshot.
    mcp_call(
        &daemon.state,
        "spotify_add_tracks",
        json!({ "playlist_id": "p", "uris": ["x"] }),
    )
    .await;

    // Depois o undo: restaurar é outra mutação confirmada pelo usuário.
    let undo = mcp_call(
        &daemon.state,
        "spotify_undo_last_mutation",
        json!({ "playlist_id": "p" }),
    )
    .await;
    assert_eq!(undo["isError"], false, "{undo}");
    let data = content_text(&undo);
    assert_eq!(
        data["restored_tracks"], 2,
        "devolve as 2 faixas do snapshot"
    );

    // O snapshot foi consumido (marcado como desfeito).
    let after = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p")))
        .unwrap();
    assert_eq!(after, None);
}
