mod common;

use common::*;
use euterpe::config::MutationPolicy;
use serde_json::{json, Value};
use wiremock::{
    matchers::{body_partial_json, method, path},
    Mock, MockServer, ResponseTemplate,
};

async fn call(d: &TestDaemon, name: &str, args: Value) -> Value {
    d.http()
        .post(format!("{}/mcp", d.base()))
        .bearer_auth(d.secret())
        .json(&json!({
            "jsonrpc":"2.0", "id":1, "method":"tools/call",
            "params":{"name":name,"arguments":args}
        }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap()["result"]
        .clone()
}
fn data(result: &Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn mcp_routes_without_extension_and_does_not_fall_back_to_desktop() {
    let backend = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/tools/call"))
        .and(body_partial_json(json!({"name":"get_playlists"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"ok":true,"data":{"total":1,"playlists":[]}})),
        )
        .expect(1)
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
    let _extension = d.state.bridge.register(sender, "test".into(), None);
    let response = call(&d, "spotify_get_playlists", json!({})).await;
    assert_eq!(response["isError"], false);
    assert_eq!(data(&response)["total"], 1);
    assert_eq!(d.state.bridge.client_count(), 1);
    assert!(d.state.bridge.is_headless());
    assert_eq!(
        d.http()
            .post(format!("{}/mcp", d.base()))
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        d.http()
            .get(format!("{}/config", d.base()))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

#[tokio::test]
async fn deny_and_failed_snapshots_prevent_writes() {
    let backend = MockServer::start().await;
    let d = spawn_with(|c| {
        c.headless_url = backend.uri();
        c.mutation_policy = MutationPolicy::Deny;
    })
    .await;
    assert_eq!(
        data(
            &call(
                &d,
                "spotify_add_tracks",
                json!({"playlist_id":"p","uris":[]})
            )
            .await
        )["code"],
        "mutation_denied"
    );
    assert!(backend.received_requests().await.unwrap().is_empty());

    Mock::given(body_partial_json(json!({"name":"get_playlist_tracks"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"ok":false,"code":"incomplete_playlist"})),
        )
        .expect(1)
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    assert_eq!(
        data(
            &call(
                &d,
                "spotify_add_tracks",
                json!({"playlist_id":"p","uris":[]})
            )
            .await
        )["code"],
        "snapshot_unavailable"
    );
    assert_eq!(backend.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn web_confirmation_requires_auth_and_precedes_snapshot_and_write() {
    let backend = MockServer::start().await;
    Mock::given(body_partial_json(json!({"name":"get_playlist_tracks"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"ok":true,"data":[{"uri":"spotify:track:a"},{"uri":"spotify:track:a"}]}),
        ))
        .expect(1)
        .mount(&backend)
        .await;
    Mock::given(body_partial_json(json!({"name":"add_tracks"})))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"ok":true,"data":{"added":1}})),
        )
        .expect(1)
        .mount(&backend)
        .await;
    let d = std::sync::Arc::new(
        spawn_with(|c| {
            c.headless_url = backend.uri();
            c.mutation_policy = MutationPolicy::Confirm;
        })
        .await,
    );
    let task = tokio::spawn({
        let d = d.clone();
        async move {
            call(
                &d,
                "spotify_add_tracks",
                json!({"playlist_id":"p","uris":["spotify:track:b"]}),
            )
            .await
        }
    });
    let url = format!("{}/proposals", d.base());
    assert_eq!(d.http().get(&url).send().await.unwrap().status(), 401);
    let mut id = String::new();
    for _ in 0..100 {
        let proposals: Value = d
            .http()
            .get(&url)
            .bearer_auth(d.secret())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(value) = proposals["proposals"][0]["proposalId"].as_str() {
            id = value.to_string();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!id.is_empty());
    assert!(backend.received_requests().await.unwrap().is_empty());
    let decision = format!("{url}/{id}");
    assert_eq!(
        d.http()
            .post(&decision)
            .json(&json!({"decision":"approve"}))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert!(d
        .http()
        .post(&decision)
        .bearer_auth(d.secret())
        .json(&json!({"decision":"approve"}))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert_eq!(task.await.unwrap()["isError"], false);
    let snapshot = d
        .state
        .store
        .with(|c| Ok(euterpe::store::snapshots::get_latest_snapshot(c, "p")))
        .unwrap()
        .unwrap();
    assert_eq!(snapshot, vec!["spotify:track:a", "spotify:track:a"]);
    assert_eq!(
        d.http()
            .post(&decision)
            .bearer_auth(d.secret())
            .json(&json!({"decision":"approve"}))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert!(d.state.bridge.pending_proposals().is_empty());
}

#[tokio::test]
async fn rejected_or_expired_proposals_never_write() {
    let backend = MockServer::start().await;
    let d = spawn_with(|c| {
        c.headless_url = backend.uri();
        c.mutation_policy = MutationPolicy::Confirm;
        c.proposal_timeout_ms = 30;
    })
    .await;
    let response = call(
        &d,
        "spotify_create_playlist",
        json!({"name":"test","tracks":[]}),
    )
    .await;
    assert_eq!(data(&response)["code"], "user_rejected");
    assert!(d.state.bridge.pending_proposals().is_empty());
    assert!(backend.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn lost_mutation_response_is_unknown_and_never_retried() {
    let backend = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    let response = call(
        &d,
        "spotify_create_playlist",
        json!({"name":"test","tracks":[]}),
    )
    .await;
    assert_eq!(data(&response)["code"], "headless_outcome_unknown");
}

#[tokio::test]
async fn unsupported_tools_keep_the_backend_error() {
    let backend = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"ok":false,"code":"unsupported_in_headless"})),
        )
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    assert_eq!(
        data(&call(&d, "spotify_get_top_tracks", json!({})).await)["code"],
        "unsupported_in_headless"
    );
    assert_eq!(d.state.bridge.client_count(), 0);
}

#[tokio::test]
async fn malformed_or_unsaved_snapshot_blocks_mutation() {
    for malformed in [true, false] {
        let backend = MockServer::start().await;
        let snapshot = if malformed {
            json!({"items":[]})
        } else {
            json!([])
        };
        Mock::given(body_partial_json(json!({"name":"get_playlist_tracks"})))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok":true,"data":snapshot})),
            )
            .expect(1)
            .mount(&backend)
            .await;
        let d = spawn_with(|c| c.headless_url = backend.uri()).await;
        if !malformed {
            d.state
                .store
                .with(|c| {
                    c.execute_batch("DROP TABLE snapshots")?;
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(
            data(
                &call(
                    &d,
                    "spotify_add_tracks",
                    json!({"playlist_id":"p","uris":[]})
                )
                .await
            )["code"],
            "snapshot_unavailable"
        );
        assert_eq!(backend.received_requests().await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn cancelled_confirmation_removes_pending_proposal() {
    let backend = MockServer::start().await;
    let d = spawn_with(|c| {
        c.headless_url = backend.uri();
        c.mutation_policy = MutationPolicy::Confirm;
    })
    .await;
    let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
    let (other_sink, mut other_events) = tokio::sync::mpsc::unbounded_channel();
    d.state.bridge.watch_proposals("mcp", sink);
    d.state
        .bridge
        .watch_proposals("other-conversation", other_sink);
    let state = d.state.clone();
    let task = tokio::spawn(async move {
        let opts = euterpe::bridge::CallOptions::mcp(
            MutationPolicy::Confirm,
            "cancel",
            "en",
            &state.store,
        );
        state
            .bridge
            .call_tool(
                &state.cfg,
                "create_playlist",
                json!({"name":"test","tracks":[]}),
                opts,
            )
            .await
    });
    for _ in 0..100 {
        if !d.state.bridge.pending_proposals().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(!d.state.bridge.pending_proposals().is_empty());
    let event = events
        .try_recv()
        .expect("SSE subscriber receives its proposal");
    assert!(
        matches!(event, euterpe::protocol::ServerMsg::ProposalCreate { name, .. } if name == "create_playlist")
    );
    assert!(other_events.try_recv().is_err());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(d.state.bridge.pending_proposals().is_empty());
    assert!(backend.received_requests().await.unwrap().is_empty());
    d.state.bridge.unwatch_proposals("mcp");
    assert!(events.recv().await.is_none());
}
