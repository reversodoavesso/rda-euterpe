mod common;
use common::*;
use serde_json::{json, Value};

#[tokio::test]
async fn erase_history_keeps_other_conversation_and_requires_auth() {
    let daemon = spawn_with(|c| c.headless_url = "http://127.0.0.1:1".into()).await;
    let id = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    daemon
        .state
        .store
        .with(|c| {
            euterpe::store::history::save_message(c, &id, "user", "private");
            euterpe::store::history::save_message(c, &other, "user", "keep");
            Ok(())
        })
        .unwrap();
    let url = format!("{}/history/{id}", daemon.base());
    assert_eq!(
        daemon.http().delete(&url).send().await.unwrap().status(),
        401
    );
    let history: Value = daemon
        .http()
        .get(&url)
        .bearer_auth(daemon.secret())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["messages"][0]["content"], "private");
    assert_eq!(
        daemon
            .http()
            .delete(&url)
            .bearer_auth(daemon.secret())
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let history: Value = daemon
        .http()
        .get(&url)
        .bearer_auth(daemon.secret())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["messages"], json!([]));
    assert_eq!(
        daemon
            .state
            .store
            .with(|c| Ok(euterpe::store::history::get_history(c, &other, 20)))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        daemon
            .http()
            .delete(format!("{}/history/invalid", daemon.base()))
            .bearer_auth(daemon.secret())
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
}

#[tokio::test]
async fn stop_cancels_only_the_requested_session_and_is_private() {
    let daemon = spawn_with(|c| c.headless_url = "http://127.0.0.1:1".into()).await;
    let a = tokio_util::sync::CancellationToken::new();
    let b = tokio_util::sync::CancellationToken::new();
    {
        let mut chats = daemon.state.chats.lock().unwrap();
        chats.insert("a".into(), (uuid::Uuid::new_v4(), a.clone()));
        chats.insert("b".into(), (uuid::Uuid::new_v4(), b.clone()));
    }
    let url = format!("{}/chat/a/cancel", daemon.base());
    assert_eq!(daemon.http().post(&url).send().await.unwrap().status(), 401);
    assert!(!a.is_cancelled());
    let reply: Value = daemon
        .http()
        .post(&url)
        .bearer_auth(daemon.secret())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["cancelled"], true);
    assert!(a.is_cancelled());
    assert!(!b.is_cancelled());
}
