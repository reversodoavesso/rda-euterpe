//! Testes de integração do adapter `Gemini` (`generateContent` e
//! `streamGenerateContent?alt=sse`), via `wiremock`.
//!
//! Prova: parsing de `parts[].text` + `usageMetadata`, `functionCall` com `id`
//! sintetizado, streaming com `Delta`/`Done`, erro 401 e o shape exato da URL
//! (`alt=sse` só no streaming).

use euterpe::llm::adapters::gemini::Gemini;
use euterpe::llm::canonical::{ChatRequest, LlmAdapter, LlmEvent, Msg};
use serde_json::json;
use tokio::sync::mpsc;
use wiremock::matchers::{method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

const MODEL: &str = "gemini-2.0-flash";
const STREAM_PATH: &str = "/v1beta/models/gemini-2.0-flash:streamGenerateContent";
const GEN_PATH: &str = "/v1beta/models/gemini-2.0-flash:generateContent";

fn adapter(server: &MockServer) -> Gemini {
    Gemini::new(server.uri(), "test-key", MODEL)
}

fn ask() -> ChatRequest {
    ChatRequest::new(MODEL, vec![Msg::user("oi")])
}

fn sse(value: serde_json::Value) -> String {
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

#[tokio::test]
async fn complete_parses_text_and_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GEN_PATH))
        .and(query_param_is_missing("alt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"parts": [{"text": "olá"}]}}],
            "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2}
        })))
        .mount(&server)
        .await;

    let done = adapter(&server).complete(ask()).await.expect("complete ok");
    assert_eq!(done.text.as_deref(), Some("olá"));
    assert_eq!(done.usage, Some((7, 2)));
}

#[tokio::test]
async fn function_calls_synthesize_ids_with_a_repeat_suffix() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GEN_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"parts": [
                {"functionCall": {"name": "search_spotify", "args": {"q": "miles"}}},
                {"functionCall": {"name": "search_spotify", "args": {"q": "coltrane"}}}
            ]}}]
        })))
        .mount(&server)
        .await;

    let done = adapter(&server).complete(ask()).await.expect("complete ok");
    assert_eq!(done.tool_calls.len(), 2);
    assert_eq!(done.tool_calls[0].id, "search_spotify");
    assert_eq!(done.tool_calls[0].name, "search_spotify");
    assert_eq!(done.tool_calls[1].id, "search_spotify#1");
    assert_eq!(done.tool_calls[1].name, "search_spotify");
    assert_eq!(done.tool_calls[1].parsed_args()["q"], "coltrane");
}

#[tokio::test]
async fn stream_emits_deltas_and_done() {
    let server = MockServer::start().await;
    let body = format!(
        "{}{}",
        sse(json!({"candidates": [{"content": {"parts": [{"text": "Ol"}]}}]})),
        sse(json!({"candidates": [{"content": {"parts": [{"text": "á"}]}}]})),
    );
    Mock::given(method("POST"))
        .and(path(STREAM_PATH))
        .and(query_param("alt", "sse"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(body.into_bytes(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let adapter = adapter(&server);
    let events = collect(&adapter, ask()).await.expect("stream ok");
    assert_eq!(
        events,
        vec![
            LlmEvent::Delta("Ol".to_string()),
            LlmEvent::Delta("á".to_string()),
            LlmEvent::Done,
        ]
    );
}

#[tokio::test]
async fn http_401_is_reported_as_a_stable_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(GEN_PATH))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad key"})))
        .mount(&server)
        .await;

    let err = adapter(&server)
        .complete(ask())
        .await
        .expect_err("401 deve falhar");
    assert!(err.to_string().contains("gemini_http_401"), "veio: {err}");
}

#[tokio::test]
async fn alt_sse_is_present_only_on_the_streaming_url() {
    let server = MockServer::start().await;
    // Estes mocks só casam se a query estiver correta; qualquer desvio vira 404.
    Mock::given(method("POST"))
        .and(path(STREAM_PATH))
        .and(query_param("alt", "sse"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            sse(json!({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]})).into_bytes(),
            "text/event-stream",
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(GEN_PATH))
        .and(query_param_is_missing("alt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "candidates": [{"content": {"parts": [{"text": "ok"}]}}]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let adapter = adapter(&server);
    let events = collect(&adapter, ask()).await.expect("stream com alt=sse");
    assert_eq!(events.last(), Some(&LlmEvent::Done));
    let done = adapter
        .complete(ask())
        .await
        .expect("generateContent sem alt");
    assert_eq!(done.text.as_deref(), Some("ok"));

    // Prova que cada mock foi efetivamente exercitado (não houve 404 silencioso).
    server.verify().await;
}
