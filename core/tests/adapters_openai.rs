//! Testes de integração do adapter `OpenAiCompat` (`PLAN-REFACTOR.md` §F4).
//!
//! Cobre o wire não-streaming (`tool_calls` + `usage`), o SSE streaming, o
//! acúmulo de `tool_calls` fatiados, os erros HTTP 401/429 e `list_models`.
//!
//! Nota sobre fragmentação: o `wiremock` 0.6 responde com um corpo `Full<Bytes>`
//! de um único chunk, então **não** consegue cortar no meio de uma linha `data:`.
//! Para provar a tolerância do adapter a chunks arbitrários usamos um servidor
//! TCP mínimo (`spawn_fragmented_server`) que emite o corpo em chunks explícitos
//! com `Transfer-Encoding: chunked`.

use euterpe::llm::adapters::openai_compat::OpenAiCompat;
use euterpe::llm::canonical::{ChatRequest, LlmAdapter, LlmEvent, Msg, ToolCall};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn adapter(server: &MockServer) -> OpenAiCompat {
    OpenAiCompat::new(
        server.uri(),
        Some("test-key".to_string()),
        "gpt-x",
        Default::default(),
        Value::Null,
    )
}

fn ask() -> ChatRequest {
    ChatRequest::new("gpt-x", vec![Msg::user("oi")])
}

fn sse(value: Value) -> String {
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

/// Servidor HTTP mínimo que responde em chunks explícitos (corta no meio das
/// linhas de propósito). Ver a nota no topo do arquivo.
async fn spawn_fragmented_server(content_type: &'static str, pieces: Vec<String>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do servidor de teste");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        // Lê (parte de) o request para o cliente terminar de escrever.
        let mut scratch = [0u8; 4096];
        let _ = sock.read(&mut scratch).await;
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n"
        );
        sock.write_all(head.as_bytes()).await.expect("headers");
        for piece in pieces {
            let frame = format!("{:x}\r\n{piece}\r\n", piece.len());
            sock.write_all(frame.as_bytes()).await.expect("chunk");
            sock.flush().await.expect("flush");
            // Respiro curto para o cliente ler este pedaço antes do próximo.
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        sock.write_all(b"0\r\n\r\n").await.expect("fim");
        let _ = sock.flush().await;
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn complete_parses_tool_calls_and_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{"message": {
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "add_tracks", "arguments": "{\"uris\":[\"x\"]}"}
                }]
            }}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3}
        })))
        .mount(&server)
        .await;

    let done = adapter(&server).complete(ask()).await.expect("complete ok");
    assert_eq!(done.text, None);
    assert_eq!(done.usage, Some((10, 3)));
    assert_eq!(
        done.tool_calls,
        vec![ToolCall::new("call_1", "add_tracks", "{\"uris\":[\"x\"]}")]
    );
    assert_eq!(done.tool_calls[0].parsed_args()["uris"][0], "x");
}

#[tokio::test]
async fn stream_emits_deltas_in_order_then_done() {
    let server = MockServer::start().await;
    let body = format!(
        "{}{}{}",
        sse(json!({"choices": [{"delta": {"content": "Ola"}}]})),
        sse(json!({"choices": [{"delta": {"content": " mundo"}}]})),
        "data: [DONE]\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
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
            LlmEvent::Delta("Ola".to_string()),
            LlmEvent::Delta(" mundo".to_string()),
            LlmEvent::Done,
        ]
    );
}

#[tokio::test]
async fn stream_tolerates_chunks_cutting_a_data_line() {
    // Corte dentro de `data:`, dentro do JSON e dentro do `[DONE]`.
    let pieces = vec![
        "da".to_string(),
        "ta: {\"choices\":[{\"delta\":{\"content\":\"Ola\"}}]}\n\ndata: {\"cho".to_string(),
        "ices\":[{\"delta\":{\"content\":\" mundo\"}}]}\n\ndata: [D".to_string(),
        "ONE]\n\n".to_string(),
    ];
    let base = spawn_fragmented_server("text/event-stream", pieces).await;
    let adapter = OpenAiCompat::new(base, None, "gpt-x", Default::default(), Value::Null);

    let events = collect(&adapter, ask())
        .await
        .expect("stream fragmentado ok");
    assert_eq!(
        events,
        vec![
            LlmEvent::Delta("Ola".to_string()),
            LlmEvent::Delta(" mundo".to_string()),
            LlmEvent::Done,
        ]
    );
}

#[tokio::test]
async fn tool_call_deltas_split_across_chunks_merge_into_one_call() {
    let server = MockServer::start().await;
    // `arguments` chega dividido em dois pedaços: `{"uris":[` + `"x"]}`.
    let args_head = r#"{"uris":["#;
    let args_tail = r#""x"]}"#;
    let body = format!(
        "{}{}{}",
        sse(json!({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "call_1", "function": {"name": "add_", "arguments": args_head}}
        ]}}]})),
        sse(json!({"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"name": "tracks", "arguments": args_tail}}
        ]}}]})),
        "data: [DONE]\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
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
            LlmEvent::ToolCall(ToolCall::new("call_1", "add_tracks", r#"{"uris":["x"]}"#)),
            LlmEvent::Done,
        ]
    );
}

#[tokio::test]
async fn http_401_is_reported_as_a_stable_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error": "bad key"})))
        .mount(&server)
        .await;

    let err = adapter(&server)
        .complete(ask())
        .await
        .expect_err("401 deve falhar");
    assert!(
        err.to_string().contains("openai_compat_http_401"),
        "veio: {err}"
    );
}

#[tokio::test]
async fn http_429_fails_fast_without_sleeping_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "30")
                .set_body_json(json!({"error": "slow down"})),
        )
        .mount(&server)
        .await;

    let started = Instant::now();
    let err = adapter(&server)
        .complete(ask())
        .await
        .expect_err("429 deve falhar");
    assert!(
        err.to_string().contains("openai_compat_http_429"),
        "veio: {err}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "não pode dormir o Retry-After (levou {:?})",
        started.elapsed()
    );
}

#[tokio::test]
async fn list_models_reads_the_data_array() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": [
                {"id": "gpt-x", "owned_by": "openai"},
                {"id": "gpt-y", "owned_by": "openai"}
            ]
        })))
        .mount(&server)
        .await;

    let models = adapter(&server)
        .list_models()
        .await
        .expect("list_models ok");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-x");
    assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
    assert_eq!(models[1].id, "gpt-y");
}
