//! Testes de integração do adapter `Anthropic` (Messages API), via `wiremock`.
//!
//! Prova: streaming de texto agregado + `Done`, montagem de `tool_use` a partir
//! de `input_json_delta` fatiado, `thinking_delta` → `Reasoning`, erro 401 e o
//! shape do corpo enviado (`system` no parâmetro e `input_schema` nas tools).

use euterpe::llm::adapters::anthropic::Anthropic;
use euterpe::llm::canonical::{ChatRequest, LlmAdapter, LlmEvent, Msg, ToolCall};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn adapter(server: &MockServer) -> Anthropic {
    Anthropic::new(server.uri(), "test-key", "claude-x")
}

fn chat() -> ChatRequest {
    ChatRequest::new("claude-x", vec![Msg::user("oi")])
}

fn event(value: Value) -> String {
    format!("data: {value}\n\n")
}

/// Consome `stream()` até o canal fechar e devolve os eventos na ordem.
async fn collect(adapter: &dyn LlmAdapter, req: ChatRequest) -> anyhow::Result<Vec<LlmEvent>> {
    let (tx, mut rx) = mpsc::channel(64);
    let stream_fut = adapter.stream(req, tx);
    let drain = async {
        let mut out = Vec::new();
        while let Some(ev) = rx.recv().await {
            out.push(ev);
        }
        out
    };
    let (res, events) = tokio::join!(stream_fut, drain);
    res?;
    Ok(events)
}

fn text_sse() -> String {
    format!(
        "{}{}{}{}{}",
        event(json!({"type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""}})),
        event(json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": "Ola"}})),
        event(json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": " mundo"}})),
        event(json!({"type": "content_block_stop", "index": 0})),
        event(json!({"type": "message_stop"})),
    )
}

async fn mount_sse(server: &MockServer, body: String) {
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(server)
        .await;
}

#[tokio::test]
async fn complete_aggregates_text_and_finishes() {
    let server = MockServer::start().await;
    mount_sse(&server, text_sse()).await;

    let adapter = adapter(&server);
    let events = collect(&adapter, chat()).await.expect("stream ok");
    assert_eq!(
        events,
        vec![
            LlmEvent::Delta("Ola".to_string()),
            LlmEvent::Delta(" mundo".to_string()),
            LlmEvent::Done,
        ]
    );

    let done = adapter.complete(chat()).await.expect("complete ok");
    assert_eq!(done.text.as_deref(), Some("Ola mundo"));
    assert!(done.tool_calls.is_empty());
}

#[tokio::test]
async fn tool_use_input_json_is_assembled_from_partial_deltas() {
    let server = MockServer::start().await;
    let body = format!(
        "{}{}{}{}{}",
        event(json!({"type": "content_block_start", "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu_1",
                "name": "get_playlists", "input": {}}})),
        event(json!({"type": "content_block_delta", "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": r#"{"lim"#}})),
        event(json!({"type": "content_block_delta", "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": r#"it": 5}"#}})),
        event(json!({"type": "content_block_stop", "index": 1})),
        event(json!({"type": "message_stop"})),
    );
    mount_sse(&server, body).await;

    let adapter = adapter(&server);
    let events = collect(&adapter, chat()).await.expect("stream ok");
    assert_eq!(
        events,
        vec![
            LlmEvent::ToolCall(ToolCall {
                id: "toolu_1".to_string(),
                name: "get_playlists".to_string(),
                arguments: r#"{"limit": 5}"#.to_string(),
            }),
            LlmEvent::Done,
        ]
    );
    // O JSON somado é válido e parseável.
    if let LlmEvent::ToolCall(call) = &events[0] {
        assert_eq!(call.parsed_args()["limit"], 5);
    } else {
        panic!("esperava um ToolCall");
    }
}

#[tokio::test]
async fn thinking_delta_becomes_reasoning() {
    let server = MockServer::start().await;
    let body = format!(
        "{}{}",
        event(json!({"type": "content_block_delta", "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "pensando"}})),
        event(json!({"type": "message_stop"})),
    );
    mount_sse(&server, body).await;

    let adapter = adapter(&server);
    let events = collect(&adapter, chat()).await.expect("stream ok");
    assert_eq!(
        events,
        vec![LlmEvent::Reasoning("pensando".to_string()), LlmEvent::Done,]
    );
}

#[tokio::test]
async fn http_401_is_reported_as_a_stable_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let err = adapter(&server)
        .complete(chat())
        .await
        .expect_err("401 deve falhar");
    assert!(
        err.to_string().contains("anthropic_http_401"),
        "veio: {err}"
    );
}

#[tokio::test]
async fn request_body_carries_system_and_input_schema() {
    let server = MockServer::start().await;
    let captured: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&captured);
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(move |req: &Request| {
            *sink.lock().expect("lock do capturador") = req.body_json::<Value>().ok();
            ResponseTemplate::new(200).set_body_raw(text_sse().into_bytes(), "text/event-stream")
        })
        .mount(&server)
        .await;

    let mut req = ChatRequest::new("claude-x", vec![Msg::system("sys"), Msg::user("oi")]);
    req.tools = vec![json!({
        "type": "function",
        "function": {
            "name": "get_playlists",
            "description": "d",
            "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}}
        }
    })];
    let _ = adapter(&server).complete(req).await.expect("complete ok");

    let body = captured
        .lock()
        .expect("lock do capturador")
        .clone()
        .expect("corpo capturado");
    // `system` vai como parâmetro top-level (não como mensagem).
    assert_eq!(body["system"], "sys");
    assert_eq!(body["messages"][0]["role"], "user");
    // Tools usam `input_schema`, não `function.parameters`.
    assert_eq!(body["tools"][0]["name"], "get_playlists");
    assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    assert!(body["tools"][0].get("input_schema").is_some());
    assert!(body["tools"][0].get("function").is_none());
}
