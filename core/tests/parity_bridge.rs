//! Paridade do bridge WS (contratos C1/C2).
//!
//! A extensão **não muda**: qualquer divergência aqui quebra o mod inteiro.

mod common;

use common::*;
use euterpe::protocol::ToolResult;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn health_handshake_returns_the_frozen_version() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (msg, _) = recv_until(&mut ws, "hello.ok").await;
    assert_eq!(msg["version"], euterpe::VERSION);
    assert_eq!(euterpe::VERSION, "0.2.0");
}

#[tokio::test]
async fn wrong_secret_closes_with_1008_unauthorized() {
    let daemon = spawn().await;
    let mut ws = connect_extension_with(&daemon, "not-the-secret", Some("en")).await;
    // O daemon manda `chat.status{error}` e em seguida fecha com 1008.
    let mut closed: Option<(u16, String)> = None;
    for _ in 0..5 {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(Some(frame))))) => {
                closed = Some((u16::from(frame.code), frame.reason.to_string()));
                break;
            }
            Ok(Some(Ok(_))) => continue,
            _ => break,
        }
    }
    assert_eq!(closed, Some((1008, "unauthorized".to_string())));
    assert!(
        !daemon.state.bridge.has_client(),
        "cliente não autorizado não pode registrar"
    );
}

#[tokio::test]
async fn any_first_message_that_is_not_hello_is_unauthorized() {
    let daemon = spawn().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(daemon.ws_url())
        .await
        .unwrap();
    send(&mut ws, json!({ "type": "chat.send", "text": "oi" })).await;
    let mut closed = false;
    for _ in 0..5 {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(Some(frame))))) => {
                assert_eq!(u16::from(frame.code), 1008);
                closed = true;
                break;
            }
            Ok(Some(Ok(_))) => continue,
            _ => break,
        }
    }
    assert!(closed, "deveria fechar com 1008");
}

#[tokio::test]
async fn invalid_message_reports_error_without_dropping_the_connection() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut ws, "hello.ok").await;

    // C2: mensagem inválida ⇒ chat.status{error} e a conexão sobrevive.
    ws.send(Message::Text("not json at all".to_string()))
        .await
        .unwrap();
    let (status, _) = recv_until(&mut ws, "chat.status").await;
    assert_eq!(status["status"], "error");
    assert_eq!(
        status["detail"], "Mensagem inválida",
        "locale pt-BR do handshake"
    );

    // Segunda inválida: objeto sem `type` conhecido.
    ws.send(Message::Text(json!({"type":"nope"}).to_string()))
        .await
        .unwrap();
    let (status2, _) = recv_until(&mut ws, "chat.status").await;
    assert_eq!(status2["status"], "error");

    // A conexão continua viva.
    send(&mut ws, json!({ "type": "ping" })).await;
    let (pong, _) = recv_until(&mut ws, "pong").await;
    assert_eq!(pong["type"], "pong");
}

#[tokio::test]
async fn ping_is_answered_even_before_the_handshake() {
    let daemon = spawn().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(daemon.ws_url())
        .await
        .unwrap();
    send(&mut ws, json!({ "type": "ping" })).await;
    let (pong, _) = recv_until(&mut ws, "pong").await;
    assert_eq!(pong["type"], "pong");
}

#[tokio::test]
async fn hello_after_auth_is_just_acknowledged() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut ws, "hello.ok").await;
    // Depois de autenticado, um novo `hello` (ainda com segredo) confirma de novo.
    send(
        &mut ws,
        json!({ "type": "hello", "secret": daemon.secret(), "appVersion": "1.0.0" }),
    )
    .await;
    let (again, _) = recv_until(&mut ws, "hello.ok").await;
    assert_eq!(again["version"], euterpe::VERSION);
}

#[tokio::test]
async fn tool_call_round_trip_echoes_the_id_and_payload() {
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |name, args| {
        assert_eq!(name, "get_playlists");
        assert_eq!(args["limit"], 3);
        json!({ "source": "client", "total": 1, "playlists": [] })
    });
    // Espera a extensão registrar.
    for _ in 0..50 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let result = daemon
        .state
        .bridge
        .raw_call(
            &daemon.state.cfg,
            "call-1",
            "get_playlists",
            json!({ "limit": 3 }),
            None,
        )
        .await;
    assert!(result.ok, "{result:?}");
    assert_eq!(result.data.unwrap()["total"], 1);
}

#[tokio::test]
async fn client_debug_is_accepted_and_does_not_break_the_session() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut ws, "hello.ok").await;
    send(
        &mut ws,
        json!({ "type": "client.debug", "level": "warn", "detail": "ruído do client" }),
    )
    .await;
    send(&mut ws, json!({ "type": "ping" })).await;
    let (pong, _) = recv_until(&mut ws, "pong").await;
    assert_eq!(pong["type"], "pong");
}

#[tokio::test]
async fn multiple_clients_keep_only_the_most_recent_active() {
    let daemon = spawn().await;
    let first = connect_extension(&daemon).await;
    let mut second = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut second, "hello.ok").await;
    drop(first);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(daemon.state.bridge.client_count(), 1);
    // O cliente ativo é o mais recente.
    assert_eq!(
        daemon
            .state
            .bridge
            .active_client()
            .map(|c| c.app_version)
            .as_deref(),
        Some("1.0.0")
    );
    assert_eq!(
        daemon.state.bridge.clients().len(),
        1,
        "invariante 7: registry é um mapa, não um singular"
    );
}

#[tokio::test]
async fn chat_send_without_provider_answers_with_fallback_and_done() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut ws, "hello.ok").await;
    send(
        &mut ws,
        json!({ "type": "chat.send", "text": "oi", "sessionId": "s-fallback" }),
    )
    .await;

    let mut deltas = String::new();
    let done;
    loop {
        let msg = recv(&mut ws).await;
        match msg["type"].as_str() {
            Some("chat.stream") => deltas.push_str(msg["delta"].as_str().unwrap_or("")),
            Some("chat.done") => {
                done = msg;
                break;
            }
            _ => {}
        }
    }
    assert!(
        deltas.contains("provider"),
        "esperava o fallback de provider, veio: {deltas}"
    );
    assert_eq!(done["sessionId"], "s-fallback");
    assert_eq!(done["suggestions"], json!([]));
}

#[tokio::test]
async fn chat_clear_acknowledges_and_wipes_history() {
    let daemon = spawn().await;
    let mut ws = connect_extension(&daemon).await;
    let (_, _) = recv_until(&mut ws, "hello.ok").await;
    daemon
        .state
        .store
        .with(|c| {
            euterpe::store::history::save_message(c, "s-clear", "user", "oi");
            Ok(())
        })
        .unwrap();
    send(
        &mut ws,
        json!({ "type": "chat.clear", "sessionId": "s-clear" }),
    )
    .await;
    let (cleared, _) = recv_until(&mut ws, "chat.cleared").await;
    assert_eq!(cleared["sessionId"], "s-clear");
    let history = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::history::get_history(c, "s-clear", 10)))
        .unwrap();
    assert!(history.is_empty());
}

#[tokio::test]
async fn proposal_flow_approves_and_executes() {
    let daemon = spawn_with(|cfg| {
        cfg.proposal_timeout_ms = 5_000;
    })
    .await;
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "fake", "locale": "en" });
        ws.send(Message::Text(hello.to_string())).await.unwrap();
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            match msg["type"].as_str() {
                Some("proposal.create") => {
                    let decision = json!({
                        "type": "proposal.decision",
                        "proposalId": msg["proposalId"],
                        "decision": "approve",
                    });
                    ws.send(Message::Text(decision.to_string())).await.unwrap();
                }
                Some("tool.call") => {
                    let payload = json!({
                        "type": "tool.result",
                        "id": msg["id"],
                        "ok": true,
                        "data": [{ "uri": "spotify:track:a" }],
                    });
                    ws.send(Message::Text(payload.to_string())).await.unwrap();
                }
                _ => {}
            }
        }
    });
    for _ in 0..50 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let opts = euterpe::bridge::CallOptions {
        call_id: "mut-1".to_string(),
        session_id: "s".to_string(),
        locale: "en".to_string(),
        mutation: euterpe::config::MutationPolicy::Confirm,
        snapshot: true,
        store: Some(&daemon.state.store),
        sessions_dir: Some(&daemon.state.cfg.sessions_dir),
        timeout_ms: 3_000,
    };
    let result = daemon
        .state
        .bridge
        .call_tool(
            &daemon.state.cfg,
            "add_tracks",
            json!({ "playlist_id": "p1", "uris": ["spotify:track:x"] }),
            opts,
        )
        .await;
    assert!(result.ok, "mutação aprovada deveria executar: {result:?}");
    assert_ne!(result, ToolResult::err("user_rejected"));

    // O snapshot da playlist foi gravado antes da escrita (invariante 2 + D3).
    let snapshot = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p1")))
        .unwrap();
    assert_eq!(snapshot, Some(vec!["spotify:track:a".to_string()]));
}
