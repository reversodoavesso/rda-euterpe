//! Helpers compartilhados dos testes de integração.
#![allow(dead_code)]

use euterpe::{config::Config, AppState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use tokio_tungstenite::tungstenite::Message;

/// Daemon de teste: servidor HTTP+WS real numa porta efêmera, com dados em um
/// diretório temporário (nunca toca `%APPDATA%`).
pub struct TestDaemon {
    pub addr: SocketAddr,
    pub state: AppState,
    _dir: tempfile::TempDir,
}

impl TestDaemon {
    pub fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}/ws", self.addr)
    }

    pub fn secret(&self) -> String {
        self.state.cfg.ws_secret.clone()
    }

    pub fn http(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client")
    }
}

/// Sobe um daemon com configuração de teste.
pub async fn spawn() -> TestDaemon {
    spawn_with(|_| {}).await
}

/// Sobe um daemon permitindo ajustar a config (timeouts curtos, etc.).
pub async fn spawn_with(patch: impl FnOnce(&mut Config)) -> TestDaemon {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut cfg = Config::for_test(dir.path().to_path_buf());
    cfg.ws_secret = "test-secret".to_string();
    cfg.data_dir = dir.path().to_path_buf();
    cfg.sessions_dir = dir.path().join("sessions");
    cfg.probes_dir = dir.path().join("probes");
    patch(&mut cfg);
    let state = AppState::new(cfg).expect("app state");
    let app = euterpe::http::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    TestDaemon {
        addr,
        state,
        _dir: dir,
    }
}

pub type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Conecta como "extensão" e faz o handshake (contrato C1).
pub async fn connect_extension(daemon: &TestDaemon) -> Ws {
    connect_extension_with(daemon, &daemon.secret(), Some("pt-BR")).await
}

pub async fn connect_extension_with(daemon: &TestDaemon, secret: &str, locale: Option<&str>) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(daemon.ws_url())
        .await
        .expect("ws connect");
    send(
        &mut ws,
        json!({ "type": "hello", "secret": secret, "appVersion": "1.0.0", "locale": locale }),
    )
    .await;
    ws
}

/// Envia uma mensagem crua no WS.
pub async fn send(ws: &mut Ws, msg: Value) {
    ws.send(Message::Text(msg.to_string()))
        .await
        .expect("ws send");
}

/// Lê a próxima mensagem, com timeout (evita teste pendurado).
pub async fn recv(ws: &mut Ws) -> Value {
    recv_timeout(ws, std::time::Duration::from_secs(10)).await
}

pub async fn recv_timeout(ws: &mut Ws, timeout: std::time::Duration) -> Value {
    let frame = tokio::time::timeout(timeout, ws.next())
        .await
        .expect("timeout esperando mensagem")
        .expect("stream terminou")
        .expect("frame inválido");
    match frame {
        Message::Text(text) => serde_json::from_str(&text).expect("json"),
        other => panic!("frame inesperado: {other:?}"),
    }
}

/// Lê mensagens até encontrar `type`, devolvendo-a (e as intermediárias).
pub async fn recv_until(ws: &mut Ws, wanted: &str) -> (Value, Vec<Value>) {
    let mut seen = Vec::new();
    for _ in 0..50 {
        let msg = recv(ws).await;
        if msg.get("type").and_then(|v| v.as_str()) == Some(wanted) {
            return (msg, seen);
        }
        seen.push(msg);
    }
    panic!("não recebi `{wanted}` em 50 mensagens");
}

/// Extensão falsa: responde todo `tool.call` com `responder(name, args)`.
/// Devolve o JoinHandle; cancele-o para simular a queda do cliente.
pub fn fake_extension(
    daemon: &TestDaemon,
    responder: impl Fn(&str, &Value) -> Value + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let url = daemon.ws_url();
    let secret = daemon.secret();
    tokio::spawn(async move {
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
            return;
        };
        let hello =
            json!({ "type": "hello", "secret": secret, "appVersion": "fake", "locale": "en" });
        if ws.send(Message::Text(hello.to_string())).await.is_err() {
            return;
        }
        while let Some(Ok(frame)) = ws.next().await {
            let Message::Text(text) = frame else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if msg.get("type").and_then(|v| v.as_str()) != Some("tool.call") {
                continue;
            }
            let id = msg
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = msg
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let args = msg.get("args").cloned().unwrap_or(json!({}));
            let result = responder(&name, &args);
            let mut payload = json!({ "type": "tool.result", "id": id, "ok": true });
            if result.get("__error").is_some() {
                payload["ok"] = json!(false);
                payload["data"] = Value::Null;
                payload["code"] = result["__error"].clone();
            } else {
                payload["data"] = result;
            }
            if ws.send(Message::Text(payload.to_string())).await.is_err() {
                break;
            }
        }
    })
}

/// Resposta padrão: `get_playlist_tracks` devolve 2 faixas, o resto devolve `{ok:true}`.
pub fn default_responder(name: &str, _args: &Value) -> Value {
    match name {
        "get_playlist_tracks" => json!([
            { "uri": "spotify:track:a", "name": "A" },
            { "uri": "spotify:track:b", "name": "B" },
        ]),
        _ => json!({ "ok": true, "tool": name }),
    }
}

/// Resposta de erro com um código.
pub fn error_response(code: &str) -> Value {
    json!({ "__error": code })
}
