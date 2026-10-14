//! Orquestradores de servidor (paridade com `agent/src/tools/server.ts`).
//!
//! Fase 5: a cadeia de busca na web passa a ter fallback próprio, então
//! **Docker/SearXNG deixam de ser pré-requisito** para o chat.

pub mod charts;
pub mod cover;
pub mod enrich;
pub mod image_search;
pub mod lyrics;
pub mod web_search;
pub mod weekly_report;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::bridge::Bridge;
use crate::config::Config;
use crate::protocol::{ToolCallRequest, ToolResult};
use crate::store::Store;

/// Contexto das tools de servidor.
pub struct ServerToolContext<'a> {
    pub cfg: &'a Config,
    pub store: Option<&'a Store>,
    pub bridge: Arc<Bridge>,
    pub locale: String,
    pub session_id: String,
}

impl<'a> ServerToolContext<'a> {
    /// Chama uma tool de cliente (a que roda dentro do Spotify).
    ///
    /// Mantém o gate de mutação: `undo_last_mutation` é uma tool de *servidor*
    /// que, ao restaurar o snapshot, dispara uma mutação de cliente e portanto
    /// passa pela confirmação do usuário (exatamente como no Node).
    pub async fn request_client_tool(
        &self,
        id: &str,
        name: &str,
        args: serde_json::Value,
    ) -> ToolResult {
        let store = match self.store {
            Some(store) => store,
            None => dummy_store(),
        };
        let opts = crate::bridge::CallOptions::agentic(
            self.cfg,
            id,
            &self.session_id,
            &self.locale,
            store,
        );
        self.bridge.call_tool(self.cfg, name, args, opts).await
    }
}

/// Store vazio usado quando o contexto não tem banco (não deveria acontecer em
/// produção; existe para manter a assinatura simples nos testes).
fn dummy_store() -> &'static Store {
    static DUMMY: OnceLock<Store> = OnceLock::new();
    DUMMY.get_or_init(|| Store::in_memory().expect("store em memória"))
}

/// Cliente HTTP compartilhado (keep-alive; evita handshake por chamada).
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("euterpe/0.2 (+local)")
            .connect_timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Executa concorrência limitada em lotes (semântica de `mapLimit` do Node).
pub async fn map_limit<T, R, F, Fut>(items: Vec<T>, limit: usize, f: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R> + Send,
{
    let limit = limit.max(1);
    let mut items = items;
    let mut out = Vec::with_capacity(items.len());
    while !items.is_empty() {
        let take = limit.min(items.len());
        let batch: Vec<T> = items.drain(..take).collect();
        let futures = batch.into_iter().map(&f).collect::<Vec<_>>();
        out.extend(futures_util::future::join_all(futures).await);
    }
    out
}

/// Despacho das tools de servidor (paridade com `runServerTool`).
pub async fn run_server_tool(
    name: &str,
    args: &serde_json::Value,
    ctx: &ServerToolContext<'_>,
) -> ToolResult {
    let str_arg = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let num_arg =
        |key: &str, default: u64| args.get(key).and_then(|v| v.as_u64()).unwrap_or(default);
    let arr_arg = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    match name {
        "undo_last_mutation" => {
            let playlist_id = str_arg("playlist_id");
            let store = match ctx.store {
                Some(s) => s,
                None => return ToolResult::err("no_store"),
            };
            let snapshot = store
                .with(|c| {
                    Ok(crate::store::snapshots::get_latest_snapshot(
                        c,
                        &playlist_id,
                    ))
                })
                .ok()
                .flatten();
            let snapshot = match snapshot {
                Some(s) => s,
                None => return ToolResult::err("no_snapshot"),
            };
            let res = ctx
                .request_client_tool(
                    &format!("undo_{playlist_id}"),
                    "replace_playlist_tracks",
                    serde_json::json!({ "playlist_id": playlist_id, "uris": snapshot }),
                )
                .await;
            if !res.ok {
                return res;
            }
            store
                .with(|c| {
                    crate::store::snapshots::mark_snapshot_undone(c, &playlist_id);
                    Ok(())
                })
                .ok();
            ToolResult::ok(serde_json::json!({ "restored_tracks": snapshot.len() }))
        }
        "web_search" => {
            web_search::web_search(
                ctx,
                &str_arg("q"),
                &if str_arg("categories").is_empty() {
                    "general".to_string()
                } else {
                    str_arg("categories")
                },
                args.get("time_range").and_then(|v| v.as_str()),
            )
            .await
        }
        "enrich_tracks" => enrich::enrich_tracks(arr_arg("ids"), ctx).await,
        "lyrics_bulk" => {
            let tracks = args
                .get("tracks")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|t| lyrics::LyricsRequest {
                            uri: t
                                .get("uri")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            artist: t
                                .get("artist")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            title: t
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            album: t.get("album").and_then(|v| v.as_str()).map(str::to_string),
                            duration_ms: t.get("duration_ms").and_then(|v| v.as_i64()),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            lyrics::lyrics_bulk(tracks).await
        }
        "chart_lookup" => {
            let store = ctx.store;
            charts::chart_lookup(store, arr_arg("uris"), &{
                let r = str_arg("region");
                if r.is_empty() {
                    "global".to_string()
                } else {
                    r
                }
            })
            .await
        }
        "image_search" => {
            image_search::image_search(&str_arg("q"), num_arg("per_page", 10) as usize).await
        }
        "weekly_report" => weekly_report::weekly_report(ctx).await,
        "prepare_cover" => {
            cover::prepare_cover(&str_arg("url"), num_arg("max_kb", 256) as usize).await
        }
        "lyrics_lookup" => {
            lyrics::lyrics_lookup(
                &str_arg("artist"),
                &str_arg("title"),
                args.get("album").and_then(|v| v.as_str()),
                args.get("duration_ms").and_then(|v| v.as_i64()),
            )
            .await
        }
        "similar_artists" => {
            enrich::similar_artists(&str_arg("artist"), num_arg("limit", 10) as usize, ctx).await
        }
        "artist_info" => {
            enrich::artist_info(&str_arg("artist"), num_arg("limit", 10) as usize, ctx).await
        }
        other => ToolResult::err(format!("unknown_server_tool:{other}")),
    }
}

/// Helper: `tool.call` cru para as tools de servidor que precisam falar com o cliente.
pub fn client_call(id: &str, name: &str, args: serde_json::Value) -> ToolCallRequest {
    ToolCallRequest {
        id: id.to_string(),
        name: name.to_string(),
        args,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn map_limit_preserves_order_and_bounds_concurrency() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (i, p) = (Arc::clone(&inflight), Arc::clone(&peak));
        let out = map_limit(vec![1, 2, 3, 4, 5, 6, 7], 3, move |x| {
            let (i, p) = (Arc::clone(&i), Arc::clone(&p));
            async move {
                let now = i.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                i.fetch_sub(1, Ordering::SeqCst);
                x * 2
            }
        })
        .await;
        assert_eq!(out, vec![2, 4, 6, 8, 10, 12, 14]);
        assert!(
            peak.load(Ordering::SeqCst) <= 3,
            "concorrência excedeu o limite"
        );
    }

    #[tokio::test]
    async fn unknown_server_tool_is_an_error_not_a_panic() {
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-tools"));
        let ctx = ServerToolContext {
            cfg: &cfg,
            store: None,
            bridge: Arc::new(Bridge::new()),
            locale: "en".into(),
            session_id: "s".into(),
        };
        let res = run_server_tool("nope", &serde_json::json!({}), &ctx).await;
        assert_eq!(res, ToolResult::err("unknown_server_tool:nope"));
    }

    #[tokio::test]
    async fn undo_without_snapshot_reports_no_snapshot() {
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-tools"));
        let store = Store::in_memory().unwrap();
        let ctx = ServerToolContext {
            cfg: &cfg,
            store: Some(&store),
            bridge: Arc::new(Bridge::new()),
            locale: "en".into(),
            session_id: "s".into(),
        };
        let res = run_server_tool(
            "undo_last_mutation",
            &serde_json::json!({"playlist_id":"p"}),
            &ctx,
        )
        .await;
        assert_eq!(res, ToolResult::err("no_snapshot"));
    }
}
