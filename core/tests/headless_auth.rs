mod common;
use common::*;
use serde_json::{json, Value};
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn pairing_proxy_requires_auth_and_filters_credentials() {
    let backend = MockServer::start().await;
    Mock::given(method("GET")).and(path("/auth")).respond_with(ResponseTemplate::new(200).set_body_json(json!({
        "status":"pending","authenticated":false,"verification_url":"https://accounts.spotify.com/pair","user_code":"CODE","expires_at":"2026-10-23T12:30:00Z",
        "access_token":"must-not-leak","credentials":{"data":"must-not-leak"}
    }))).expect(1).mount(&backend).await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    let url = format!("{}/spotify/auth", d.base());
    assert_eq!(d.http().get(&url).send().await.unwrap().status(), 401);
    let response = d
        .http()
        .get(&url)
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let data: Value = response.json().await.unwrap();
    assert_eq!(data["user_code"], "CODE");
    assert!(!data.to_string().contains("must-not-leak"));
}

#[tokio::test]
async fn worker_secret_is_forwarded_only_to_private_backend() {
    let backend = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/auth"))
        .and(header("authorization", "Bearer private-worker-key"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"status":"idle","authenticated":false})),
        )
        .expect(1)
        .mount(&backend)
        .await;
    let d = spawn_with(|c| {
        c.headless_url = backend.uri();
        c.headless_secret = "private-worker-key".into();
    })
    .await;
    let response = d
        .http()
        .get(format!("{}/spotify/auth", d.base()))
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(!response
        .text()
        .await
        .unwrap()
        .contains("private-worker-key"));
}

#[tokio::test]
async fn pairing_start_cancel_and_already_authenticated_preserve_status() {
    let backend = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/auth/start"))
        .respond_with(ResponseTemplate::new(409).set_body_json(
            json!({"status":"authenticated","authenticated":true,"error":"already_authenticated"}),
        ))
        .mount(&backend)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/auth"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"status":"idle","authenticated":false})),
        )
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    assert_eq!(
        d.http()
            .post(format!("{}/spotify/auth/start", d.base()))
            .bearer_auth(d.secret())
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    let cancelled: Value = d
        .http()
        .delete(format!("{}/spotify/auth", d.base()))
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "idle");
}

#[tokio::test]
async fn unavailable_backend_returns_sanitized_error_and_desktop_has_no_pairing() {
    let backend = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500).set_body_string("private internal error"))
        .mount(&backend)
        .await;
    let d = spawn_with(|c| c.headless_url = backend.uri()).await;
    let result = d
        .http()
        .get(format!("{}/spotify/auth", d.base()))
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap();
    assert_eq!(result.status(), 502);
    assert!(!result.text().await.unwrap().contains("private"));
    let d = spawn().await;
    assert_eq!(
        d.http()
            .get(format!("{}/spotify/auth", d.base()))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}
