//! Handshake e ciclo de vida da conexão WS da extensão (contratos C1/C2).
//!
//! Cada conexão autenticada:
//!  - recebe `hello{secret,appVersion,locale}` → `hello.ok{version}`;
//!  - registra um `Sink` (fila serial) no bridge;
//!  - responde `pong` a `ping` **antes** do handshake (como o Node);
//!  - resolve `tool.result` / `proposal.decision` imediatamente, fora da fila
//!    serial (senão o fluxo trava esperando a si mesmo);
//!  - no handshake inválido fecha com `1008 unauthorized`;
//!  - na saída desregistra o cliente e os pendentes viram `client_offline`.

pub mod chat;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::protocol::{ClientMsg, DebugLevel, ServerMsg, ToolResult};
use crate::AppState;

pub const CLOSE_UNAUTHORIZED: u16 = 1008;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<(u16, String)>();

    let writer: JoinHandle<()> = tokio::spawn(async move {
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    let Some(msg) = maybe else { break };
                    let Ok(payload) = serde_json::to_string(&msg) else { continue };
                    if sender.send(Message::Text(payload)).await.is_err() {
                        break;
                    }
                }
                maybe = close_rx.recv() => {
                    let Some((code, reason)) = maybe else { break };
                    let _ = sender
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            }
        }
        let _ = sender.close().await;
    });

    let mut guard = None;
    let mut locale = "en".to_string();
    let mut authed = false;
    let mut chain: JoinHandle<()> = tokio::spawn(async {});
    let upstream_chat = crate::upstream::UpstreamChat::new(state.clone(), tx.clone());

    while let Some(Ok(frame)) = receiver.next().await {
        let raw = match frame {
            Message::Text(text) => text,
            Message::Binary(bin) => String::from_utf8_lossy(&bin).to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let msg = match ClientMsg::parse(&raw) {
            Ok(m) => m,
            Err(_) => {
                let _ = tx.send(ServerMsg::ChatStatus {
                    session_id: None,
                    status: "error".to_string(),
                    detail: Some(crate::i18n::t(&locale, "status.invalidMessage", &[])),
                });
                continue;
            }
        };

        if let ClientMsg::Ping = msg {
            let _ = tx.send(ServerMsg::Pong);
            continue;
        }

        if !authed {
            match msg {
                ClientMsg::Hello {
                    secret,
                    app_version,
                    locale: client_locale,
                } => {
                    if secret == state.cfg.ws_secret {
                        authed = true;
                        locale =
                            crate::i18n::normalize_locale(client_locale.as_deref()).to_string();
                        guard = Some(
                            state
                                .bridge
                                .register(tx.clone(), app_version, client_locale),
                        );
                        tracing::info!(
                            locale = %locale,
                            "{}",
                            crate::i18n::t(&locale, "status.clientAuthenticated", &[])
                        );
                        let _ = tx.send(ServerMsg::HelloOk {
                            version: crate::VERSION.to_string(),
                        });
                    } else {
                        tracing::warn!(
                            "{}",
                            crate::i18n::t(&locale, "status.handshakeRejected", &[])
                        );
                        let _ = close_tx.send((CLOSE_UNAUTHORIZED, "unauthorized".to_string()));
                        break;
                    }
                }
                _ => {
                    tracing::warn!(
                        "{}",
                        crate::i18n::t(&locale, "status.handshakeRejected", &[])
                    );
                    let _ = close_tx.send((CLOSE_UNAUTHORIZED, "unauthorized".to_string()));
                    break;
                }
            }
            continue;
        }

        match msg {
            ClientMsg::Hello { .. } => {
                let _ = tx.send(ServerMsg::HelloOk {
                    version: crate::VERSION.to_string(),
                });
            }
            ClientMsg::ClientDebug { level, detail } => {
                let level = level.unwrap_or(DebugLevel::Log);
                tracing::info!(client = true, level = ?level, "[client] {detail}");
            }
            ClientMsg::ToolResult { id, ok, data, code } => {
                // Repassa ao upstream (o Node pode estar esperando) e resolve local.
                upstream_chat
                    .forward_tool_result(&id, ok, data.clone(), code.clone())
                    .await;
                let result = if ok {
                    ToolResult::ok(data)
                } else {
                    ToolResult {
                        ok: false,
                        data: None,
                        code,
                    }
                };
                state.bridge.resolve_tool_result(&id, result);
            }
            ClientMsg::ProposalDecision {
                proposal_id,
                decision,
            } => {
                upstream_chat.forward_decision(&proposal_id, decision).await;
                state.bridge.resolve_proposal(&proposal_id, decision);
            }
            ClientMsg::ChatSend { text, session_id } => {
                let state = state.clone();
                let tx = tx.clone();
                let locale = locale.clone();
                let upstream_chat = upstream_chat.clone();
                let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let previous = std::mem::replace(&mut chain, tokio::spawn(async {}));
                chain = tokio::spawn(async move {
                    let _ = previous.await;
                    chat::handle_chat_send(state, tx, upstream_chat, session_id, text, locale)
                        .await;
                });
            }
            ClientMsg::ChatClear { session_id } => {
                let state = state.clone();
                let tx = tx.clone();
                let upstream_chat = upstream_chat.clone();
                let previous = std::mem::replace(&mut chain, tokio::spawn(async {}));
                chain = tokio::spawn(async move {
                    let _ = previous.await;
                    if upstream_chat.is_enabled() {
                        upstream_chat.forward_clear(&session_id).await;
                    }
                    state
                        .store
                        .with(|c| {
                            crate::store::history::clear_history(c, &session_id);
                            Ok(())
                        })
                        .ok();
                    crate::logging::log_session(
                        &state.cfg.sessions_dir,
                        &session_id,
                        "chat.clear",
                        None,
                    );
                    let _ = tx.send(ServerMsg::ChatCleared { session_id });
                });
            }
            ClientMsg::SongChange { uri } => {
                let state = state.clone();
                let tx = tx.clone();
                let locale = locale.clone();
                let upstream_chat = upstream_chat.clone();
                let previous = std::mem::replace(&mut chain, tokio::spawn(async {}));
                chain = tokio::spawn(async move {
                    let _ = previous.await;
                    if upstream_chat.is_enabled() {
                        upstream_chat.forward_song_change(&uri).await;
                        return;
                    }
                    chat::handle_song_change(state, tx, uri, locale).await;
                });
            }
            ClientMsg::PlaylistModified {
                playlist_id,
                hash,
                uris,
            } => {
                let state = state.clone();
                tokio::spawn(async move {
                    // 1. Verifica se o hash já é idêntico ao último no banco
                    let latest_hash = state
                        .store
                        .with(|c| Ok(crate::store::snapshots::get_latest_hash(c, &playlist_id)))
                        .ok()
                        .flatten();

                    if let Some(h) = latest_hash {
                        if h == hash {
                            return; // Zero I/O se o hash for idêntico
                        }
                    }

                    // 2. Obtém snapshot anterior para cálculo do diff
                    let prev_tracks = state
                        .store
                        .with(|c| {
                            Ok(crate::store::snapshots::get_latest_snapshot(
                                c,
                                &playlist_id,
                            ))
                        })
                        .ok()
                        .flatten()
                        .unwrap_or_default();

                    // 3. Calcula delta e salva
                    let delta = crate::tools::server::diff::calculate_diff(&prev_tracks, &uris);
                    state
                        .store
                        .with(|c| {
                            crate::store::snapshots::save_snapshot(c, &playlist_id, &uris);
                            crate::store::snapshots::record_diff(c, &playlist_id, &hash, &delta)?;
                            Ok(())
                        })
                        .ok();

                    tracing::info!(
                        playlist_id = %playlist_id,
                        added = delta.added.len(),
                        removed = delta.removed.len(),
                        reordered = delta.reordered,
                        "playlist diff gravado com sucesso"
                    );
                });
            }
            ClientMsg::Ping | ClientMsg::Pong => {}
        }
    }

    drop(guard);
    let _ = writer.await;
    tracing::info!(
        "{}",
        crate::i18n::t(&locale, "status.clientDisconnected", &[])
    );
}
