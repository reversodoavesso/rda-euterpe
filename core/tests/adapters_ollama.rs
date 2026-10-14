//! Testes de integração do adapter `Ollama` (wire nativo `/api/chat`), via
//! `wiremock` + um servidor TCP mínimo para o NDJSON fragmentado.
//!
//! Prova: `complete()` de uma linha NDJSON, `stream()` com NDJSON em várias
//! linhas cortadas no meio, `tool_calls` nativos com id sintetizado,
//! `list_models()` em `/api/tags` e a detecção do wire OpenAI (LM Studio).

use euterpe::llm::adapters::ollama::Ollama;
use euterpe::llm::canonical::{ChatRequest, LlmAdapter, LlmEvent, Msg};
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn adapter(server: &MockServer) -> Ollama {
    Ollama::new(server.uri(), "llama3.2")
}

fn ask() -> ChatRequest {
    ChatRequest::new("llama3.2", vec![Msg::user("oi")])
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

/// Servidor HTTP mínimo que responde em chunks explícitos (ver a nota em
/// `adapters_openai.rs`: o `wiremock` 0.6 não fragmenta o corpo).
async fn spawn_fragmented_server(pieces: Vec<String>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do servidor de teste");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.expect("accept");
        let mut scratch = [0u8; 4096];
        let _ = sock.read(&mut scratch).await;
        sock.write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n",
        )
        .await
        .expect("headers");
        for piece in pieces {
            let frame = format!("{:x}\r\n{piece}\r\n", piece.len());
            sock.write_all(frame.as_bytes()).await.expect("chunk");
            sock.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        sock.write_all(b"0\r\n\r\n").await.expect("fim");
        let _ = sock.flush().await;
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn complete_parses_a_single_ndjson_line() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {"content": "oi"},
            "done": true
        })))
        .mount(&server)
        .await;

    let done = adapter(&server).complete(ask()).await.expect("complete ok");
    assert_eq!(done.text.as_deref(), Some("oi"));
}

#[tokio::test]
async fn stream_handles_ndjson_split_mid_line() {
    // Cada pedaço corta no meio de uma linha NDJSON de propósito.
    let pieces = vec![
        "{\"message\":{\"cont".to_string(),
        "ent\":\"oi\"},\"done\":false}\n{\"mess".to_string(),
        "age\":{\"content\":\" tudo\"},\"done\":false}\n".to_string(),
        "{\"message\":{\"content\":\"\"},\"done\":true}\n".to_string(),
    ];
    let base = spawn_fragmented_server(pieces).await;
    let adapter = Ollama::new(base, "llama3.2");

    let events = collect(&adapter, ask())
        .await
        .expect("stream fragmentado ok");
    assert_eq!(
        events,
        vec![
            LlmEvent::Delta("oi".to_string()),
            LlmEvent::Delta(" tudo".to_string()),
            LlmEvent::Done,
        ]
    );
}

#[tokio::test]
async fn native_tool_calls_use_the_name_as_id_with_repeat_suffix() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "message": {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "get_artist", "arguments": {"id": "a"}}},
                    {"function": {"name": "get_artist", "arguments": {"id": "b"}}}
                ]
            },
            "done": true
        })))
        .mount(&server)
        .await;

    let done = adapter(&server).complete(ask()).await.expect("complete ok");
    assert_eq!(done.tool_calls.len(), 2);
    assert_eq!(done.tool_calls[0].id, "get_artist");
    assert_eq!(done.tool_calls[0].name, "get_artist");
    assert_eq!(done.tool_calls[0].parsed_args()["id"], "a");
    assert_eq!(done.tool_calls[1].id, "get_artist#1");
    assert_eq!(done.tool_calls[1].parsed_args()["id"], "b");
}

#[tokio::test]
async fn list_models_reads_the_models_array_at_api_tags() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/tags"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "models": [{"model": "llama3.2"}]
        })))
        .mount(&server)
        .await;

    let models = adapter(&server)
        .list_models()
        .await
        .expect("list_models ok");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "llama3.2");
}

#[test]
fn a_base_ending_in_v1_prefers_the_openai_wire() {
    // LM Studio expõe `/v1/chat/completions`; nesse caso usamos o wire OpenAI.
    assert!(Ollama::new("http://127.0.0.1:1234/v1", "m").prefer_openai_wire);
    assert!(!Ollama::new("http://127.0.0.1:11434", "m").prefer_openai_wire);
}
