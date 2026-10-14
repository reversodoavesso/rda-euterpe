//! Concorrência e invariantes de estado (PLAN-REFACTOR.md §2.3).

mod common;

use common::*;
use euterpe::bridge::CallOptions;
use euterpe::config::MutationPolicy;
use euterpe::protocol::ToolResult;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
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
async fn two_simultaneous_callers_are_both_served() {
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |name, args| {
        // A resposta ecoa os argumentos: prova que não houve troca de payload.
        json!({ "tool": name, "echo": args["n"] })
    });
    wait_for_client(&daemon).await;

    let state = daemon.state.clone();
    let first = tokio::spawn({
        let state = state.clone();
        async move {
            state
                .bridge
                .raw_call(&state.cfg, "a", "get_playlists", json!({ "n": 1 }), None)
                .await
        }
    });
    let second = tokio::spawn({
        let state = state.clone();
        async move {
            state
                .bridge
                .raw_call(&state.cfg, "b", "get_saved_tracks", json!({ "n": 2 }), None)
                .await
        }
    });
    let (r1, r2) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(r1.data.unwrap()["echo"], 1);
    assert_eq!(r2.data.unwrap()["echo"], 2);
}

#[tokio::test]
async fn killing_the_extension_midflight_yields_client_offline_not_timeout() {
    let daemon = spawn_with(|cfg| cfg.tool_timeout_ms = 30_000).await;
    // Extensão que autentica e, ao receber `tool.call`, **não responde** — a
    // chamada fica pendente até a conexão morrer.
    let url = daemon.ws_url();
    let secret = daemon.secret();
    let ext = tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "silent", "locale": "en" });
        if ws.send(Message::Text(hello.to_string())).await.is_err() {
            return;
        }
        while ws.next().await.is_some() {}
    });
    wait_for_client(&daemon).await;

    let state = daemon.state.clone();
    let pending = tokio::spawn(async move {
        state
            .bridge
            .raw_call(&state.cfg, "kill", "get_playlists", json!({}), None)
            .await
    });
    // Dá tempo da chamada virar pendente, então mata a extensão.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    ext.abort();

    let result = tokio::time::timeout(std::time::Duration::from_secs(20), pending)
        .await
        .expect("não pode pendurar: o drop do cliente resolve os pendentes")
        .unwrap();
    assert_eq!(
        result,
        ToolResult::err("client_offline"),
        "invariante 3: a queda do cliente vira client_offline, não timeout de 30 s"
    );
}

#[tokio::test]
async fn two_concurrent_mutations_are_serialized_by_the_mutation_lock() {
    let daemon = spawn_with(|cfg| {
        cfg.proposal_timeout_ms = 10_000;
        cfg.tool_timeout_ms = 10_000;
    })
    .await;

    let in_flight = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let url = daemon.ws_url();
    let secret = daemon.secret();
    let (i, p) = (Arc::clone(&in_flight), Arc::clone(&peak));
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "mut", "locale": "en" });
        let _ = ws.send(Message::Text(hello.to_string())).await;
        let mut waiting_snapshot: Vec<String> = Vec::new();
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            match msg["type"].as_str() {
                Some("proposal.create") => {
                    let now = i.fetch_add(1, Ordering::SeqCst) + 1;
                    p.fetch_max(now, Ordering::SeqCst);
                    let decision = json!({
                        "type": "proposal.decision",
                        "proposalId": msg["proposalId"],
                        "decision": "approve",
                    });
                    let _ = ws.send(Message::Text(decision.to_string())).await;
                }
                Some("tool.call") => {
                    let id = msg["id"].as_str().unwrap_or("").to_string();
                    let name = msg["name"].as_str().unwrap_or("").to_string();
                    // O snapshot é a chamada `snap_*` (get_playlist_tracks).
                    if id.starts_with("snap_") {
                        waiting_snapshot.push(id.clone());
                        let payload = json!({
                            "type": "tool.result",
                            "id": id,
                            "ok": true,
                            "data": [{ "uri": "spotify:track:a" }],
                        });
                        let _ = ws.send(Message::Text(payload.to_string())).await;
                        continue;
                    }
                    assert_eq!(name, "add_tracks");
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    let payload = json!({ "type": "tool.result", "id": id, "ok": true, "data": {"ok": true} });
                    let _ = ws.send(Message::Text(payload.to_string())).await;
                    // Fim da seção crítica desta mutação.
                    i.fetch_sub(1, Ordering::SeqCst);
                }
                _ => {}
            }
        }
    });
    wait_for_client(&daemon).await;

    let state = daemon.state.clone();
    let store1 = std::sync::Arc::clone(&daemon.state.store);
    let store2 = std::sync::Arc::clone(&daemon.state.store);
    let one = tokio::spawn({
        let state = state.clone();
        async move {
            let opts = CallOptions {
                call_id: "m1".to_string(),
                session_id: "s".to_string(),
                locale: "en".to_string(),
                mutation: MutationPolicy::Confirm,
                snapshot: true,
                store: Some(&store1),
                sessions_dir: None,
                timeout_ms: 10_000,
            };
            state
                .bridge
                .call_tool(
                    &state.cfg,
                    "add_tracks",
                    json!({ "playlist_id": "p1", "uris": ["a"] }),
                    opts,
                )
                .await
        }
    });
    let two = tokio::spawn({
        let state = state.clone();
        async move {
            let opts = CallOptions {
                call_id: "m2".to_string(),
                session_id: "s".to_string(),
                locale: "en".to_string(),
                mutation: MutationPolicy::Confirm,
                snapshot: true,
                store: Some(&store2),
                sessions_dir: None,
                timeout_ms: 10_000,
            };
            state
                .bridge
                .call_tool(
                    &state.cfg,
                    "add_tracks",
                    json!({ "playlist_id": "p2", "uris": ["b"] }),
                    opts,
                )
                .await
        }
    });
    let (r1, r2) = (one.await.unwrap(), two.await.unwrap());
    assert_eq!(r1, ToolResult::ok(json!({ "ok": true })));
    assert_eq!(r2, ToolResult::ok(json!({ "ok": true })));
    assert_eq!(
        peak.load(Ordering::SeqCst),
        1,
        "invariante 2: nunca duas mutações em voo"
    );
    // Ambos os snapshots foram gravados antes de cada escrita.
    for playlist in ["p1", "p2"] {
        let snapshot = daemon
            .state
            .store
            .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, playlist)))
            .unwrap();
        assert_eq!(snapshot, Some(vec!["spotify:track:a".to_string()]));
    }
}

#[tokio::test]
async fn mcp_style_calls_do_not_go_through_the_chat_queue() {
    // O MCP chama tools em paralelo; se entrasse na fila serial do chat, o
    // segundo só começaria após o primeiro. Aqui provamos o paralelismo real.
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |name, _args| json!({ "tool": name }));
    wait_for_client(&daemon).await;

    let state = daemon.state.clone();
    let started = std::time::Instant::now();
    let mut handles = Vec::new();
    for i in 0..8 {
        let state = state.clone();
        handles.push(tokio::spawn(async move {
            let id = format!("mcp-{i}");
            state
                .bridge
                .raw_call(&state.cfg, &id, "get_playlists", json!({}), None)
                .await
        }));
    }
    for handle in handles {
        assert!(handle.await.unwrap().ok);
    }
    // 8 chamadas concorrentes num responder instantâneo: precisa ser rápido.
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}
