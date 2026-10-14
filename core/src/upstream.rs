//! Espelho (proxy) para o agente Node — a entrega da **Fase 2** (D6).
//!
//! Mecanismo: `euterpe.exe` assume a porta 8337 e o bridge WS. Quando
//! `CHAT_UPSTREAM` está definido (ex.: `ws://127.0.0.1:8338/ws`), o daemon abre
//! **uma** conexão WS de saída para o Node e:
//!
//!  - encaminha `chat.send` / `chat.clear` / `event.songchange` para cima;
//!  - encaminha **tudo** que desce (`chat.stream`, `tool.call`, `proposal.create`,
//!    `chat.done`) para as conexões locais (a extensão);
//!  - encaminha `tool.result` / `proposal.decision` das conexões locais para cima.
//!
//! Assim a extensão continua sendo "as mãos" e o Node continua sendo o cérebro —
//! sem duplicar nenhuma chamada às APIs internas do Spotify (o motivo de A ter
//! sido descartada em `PLAN-REFACTOR.md`). O flip é reversível por 1 variável.

use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::bridge::Sink;
use crate::config::Config;
use crate::protocol::{ClientMsg, Decision, ServerMsg};
use crate::AppState;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Inner {
    sinks: Vec<Sink>,
    out: Option<mpsc::UnboundedSender<ClientMsg>>,
    broadcast: Option<broadcast::Sender<ServerMsg>>,
}

/// Conexão de espelho compartilhada por todo o processo.
pub struct Upstream {
    url: String,
    secret: String,
    inner: Mutex<Inner>,
}

impl Upstream {
    pub fn new(cfg: &Config) -> Self {
        Self {
            url: cfg.chat_upstream.clone(),
            secret: cfg.ws_secret.clone(),
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.url.trim().is_empty()
    }

    /// Registra o sink de uma conexão local (recebe tudo que desce do Node).
    pub async fn register_sink(&self, sink: Sink) {
        let mut inner = self.inner.lock().await;
        inner.sinks.retain(|s| !s.is_closed());
        if !inner.sinks.iter().any(|s| s.same_channel(&sink)) {
            inner.sinks.push(sink);
        }
    }

    pub async fn unregister_sink(&self, sink: &Sink) {
        let mut inner = self.inner.lock().await;
        inner
            .sinks
            .retain(|s| !s.is_closed() && !s.same_channel(sink));
    }

    /// Garante a conexão e a tarefa de leitura. `true` se está pronta.
    pub async fn ensure(self: &Arc<Self>, state: &AppState) -> bool {
        if !self.enabled() {
            return false;
        }
        {
            let inner = self.inner.lock().await;
            if inner
                .out
                .as_ref()
                .map(|tx| !tx.is_closed())
                .unwrap_or(false)
            {
                return true;
            }
        }
        let (out_tx, out_rx) = mpsc::unbounded_channel::<ClientMsg>();
        {
            let mut inner = self.inner.lock().await;
            inner.out = Some(out_tx.clone());
            if inner.broadcast.is_none() {
                let (tx, _) = broadcast::channel::<ServerMsg>(256);
                inner.broadcast = Some(tx);
            }
        }
        let this = Arc::clone(self);
        let state = state.clone();
        tokio::spawn(async move {
            let runner = Arc::clone(&this);
            if let Err(err) = runner.run(state, out_rx).await {
                tracing::warn!(error = %err, "upstream: conexão encerrada");
            }
            let mut inner = this.inner.lock().await;
            inner.out = None;
        });
        true
    }

    async fn run(
        self: Arc<Self>,
        state: AppState,
        mut out_rx: mpsc::UnboundedReceiver<ClientMsg>,
    ) -> anyhow::Result<()> {
        let connect =
            tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&self.url));
        let (stream, _) = match connect.await {
            Ok(Ok(pair)) => pair,
            Ok(Err(err)) => anyhow::bail!("upstream_connect:{err}"),
            Err(_) => anyhow::bail!("upstream_connect:timeout"),
        };
        tracing::info!(url = %self.url, "upstream: conectado ao agente Node (Fase 2 / D6)");
        let (mut ws_tx, mut ws_rx) = stream.split();

        let hello = ClientMsg::Hello {
            secret: self.secret.clone(),
            app_version: crate::VERSION.to_string(),
            locale: None,
        };
        ws_tx
            .send(Message::Text(serde_json::to_string(&hello)?))
            .await?;

        // Aguarda `hello.ok` antes de aceitar tráfego.
        loop {
            let Some(frame) = ws_rx.next().await else {
                anyhow::bail!("upstream_closed_before_handshake");
            };
            let frame = frame?;
            if let Message::Text(text) = &frame {
                if let Ok(msg) = serde_json::from_str::<ServerMsg>(text) {
                    if matches!(msg, ServerMsg::HelloOk { .. }) {
                        break;
                    }
                }
            }
        }

        let this = Arc::clone(&self);
        loop {
            tokio::select! {
                outgoing = out_rx.recv() => {
                    let Some(msg) = outgoing else { break };
                    ws_tx.send(Message::Text(serde_json::to_string(&msg)?)).await?;
                }
                incoming = ws_rx.next() => {
                    let Some(frame) = incoming else { break };
                    let frame = frame?;
                    match frame {
                        Message::Text(text) => {
                            if let Ok(msg) = serde_json::from_str::<ServerMsg>(&text) {
                                this.relay(&state, msg).await;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
        Ok(())
    }

    /// Encaminha uma mensagem que desceu do Node para todas as conexões locais.
    async fn relay(&self, state: &AppState, msg: ServerMsg) {
        let sinks = {
            let mut inner = self.inner.lock().await;
            inner.sinks.retain(|s| !s.is_closed());
            inner.sinks.clone()
        };
        for sink in sinks {
            let _ = sink.send(msg.clone());
        }
        if let Some(tx) = {
            let inner = self.inner.lock().await;
            inner.broadcast.as_ref().cloned()
        } {
            let _ = tx.send(msg);
        }
        let _ = state;
    }

    async fn send(&self, msg: ClientMsg) -> bool {
        let out = {
            let inner = self.inner.lock().await;
            inner.out.clone()
        };
        match out {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }
}

/// Handle de chat preso a uma conexão local.
#[derive(Clone)]
pub struct UpstreamChat {
    state: AppState,
    sink: Sink,
}

impl UpstreamChat {
    pub fn new(state: AppState, sink: Sink) -> Self {
        Self { state, sink }
    }

    /// Registra o sink no upstream (idempotente via `same_channel`).
    pub async fn register(&self) {
        if self.state.upstream.enabled() {
            self.state.upstream.register_sink(self.sink.clone()).await;
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.state.upstream.enabled()
    }

    /// Envia `chat.send` ao Node e espera o `chat.done` da sessão.
    pub async fn chat(&self, session_id: &str, text: &str, locale: Option<&str>) {
        self.register().await;
        if !self.state.upstream.ensure(&self.state).await {
            let _ = self.sink.send(ServerMsg::ChatStatus {
                session_id: Some(session_id.to_string()),
                status: "error".to_string(),
                detail: Some("chat_upstream_unavailable".to_string()),
            });
            let _ = self.sink.send(ServerMsg::ChatDone {
                session_id: Some(session_id.to_string()),
                suggestions: None,
            });
            return;
        }
        let mut rx = {
            let inner = self.state.upstream.inner.lock().await;
            inner.broadcast.as_ref().map(|tx| tx.subscribe())
        };

        // O idioma do cliente precisa chegar ao Node; o handshake do upstream é
        // único, então mandamos o `hello` de novo com o locale (idempotente: o
        // Node responde `hello.ok` e segue).
        if locale.is_some() {
            let _ = self
                .state
                .upstream
                .send(ClientMsg::Hello {
                    secret: self.state.cfg.ws_secret.clone(),
                    app_version: crate::VERSION.to_string(),
                    locale: locale.map(str::to_string),
                })
                .await;
        }
        let sent = self
            .state
            .upstream
            .send(ClientMsg::ChatSend {
                text: text.to_string(),
                session_id: Some(session_id.to_string()),
            })
            .await;
        if !sent {
            let _ = self.sink.send(ServerMsg::ChatStatus {
                session_id: Some(session_id.to_string()),
                status: "error".to_string(),
                detail: Some("chat_upstream_send_failed".to_string()),
            });
            let _ = self.sink.send(ServerMsg::ChatDone {
                session_id: Some(session_id.to_string()),
                suggestions: None,
            });
            return;
        }

        // Não duplicamos o relay dos sinks: apenas esperamos o fim para liberar a
        // fila serial da conexão.
        if let Some(rx) = rx.as_mut() {
            let deadline = tokio::time::Instant::now() + CHAT_TIMEOUT;
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Ok(ServerMsg::ChatDone {
                        session_id: Some(id),
                        ..
                    })) if id == session_id => break,
                    Ok(Ok(_)) => continue,
                    Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                    _ => break,
                }
            }
        }
    }

    pub async fn forward_clear(&self, session_id: &str) {
        if self.state.upstream.ensure(&self.state).await {
            self.state
                .upstream
                .send(ClientMsg::ChatClear {
                    session_id: session_id.to_string(),
                })
                .await;
        }
    }

    pub async fn forward_song_change(&self, uri: &str) {
        if self.state.upstream.ensure(&self.state).await {
            self.state
                .upstream
                .send(ClientMsg::SongChange {
                    uri: uri.to_string(),
                })
                .await;
        }
    }

    pub async fn forward_tool_result(
        &self,
        id: &str,
        ok: bool,
        data: serde_json::Value,
        code: Option<String>,
    ) {
        if self.state.upstream.ensure(&self.state).await {
            self.state
                .upstream
                .send(ClientMsg::ToolResult {
                    id: id.to_string(),
                    ok,
                    data,
                    code,
                })
                .await;
        }
    }

    pub async fn forward_decision(&self, proposal_id: &str, decision: Decision) {
        if self.state.upstream.ensure(&self.state).await {
            self.state
                .upstream
                .send(ClientMsg::ProposalDecision {
                    proposal_id: proposal_id.to_string(),
                    decision,
                })
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn upstream_is_disabled_without_chat_upstream() {
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-upstream"));
        let up = Upstream::new(&cfg);
        assert!(!up.enabled());
    }

    #[test]
    fn upstream_is_enabled_with_chat_upstream() {
        let mut cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-upstream"));
        cfg.chat_upstream = "ws://127.0.0.1:8338/ws".into();
        assert!(Upstream::new(&cfg).enabled());
    }
}
