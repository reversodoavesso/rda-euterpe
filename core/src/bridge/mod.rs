//! Bridge: registry de clientes (a extensão), mapa de chamadas pendentes,
//! lock de mutação e gates de confirmação.
//!
//! Invariantes (PLAN-REFACTOR.md §2.3) implementadas e testadas em
//! `tests/bridge_concurrency.rs`:
//!
//! 1. `clients` mantém **N** conexões possíveis, mas
//!    só a **mais recente** autenticada é usada (equivalente ao `activeClient`
//!    singular do Node, sem o bug de reuso do socket).
//! 2. `mutation_lock` garante **exatamente uma** mutação em voo, cobrindo
//!    proposta → snapshot → escrita (protege snapshot × escrita).
//! 3. No modo desktop, sem extensão viva, tool devolve `client_offline`
//!    **imediato**: nunca cache velho, nunca esperar 30 s.
//! 4. Nenhum id de chamada é reutilizado enquanto pendente (falha explícita).
//! 5. `pending` é global (ids são únicos), então o MCP chama tools em paralelo sem
//!    passar pela fila serial do chat.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

use crate::config::{Config, MutationPolicy};
use crate::protocol::{Decision, ServerMsg, ToolResult};
use crate::tools::{catalog, server::ServerToolContext};

pub mod headless;

/// Canal de saída de uma conexão (WS ou SSE).
pub type Sink = mpsc::UnboundedSender<ServerMsg>;

#[derive(Debug, Clone)]
pub struct ClientHandle {
    pub id: Uuid,
    pub tx: Sink,
    pub app_version: String,
    pub locale: Option<String>,
}

struct Pending {
    tx: oneshot::Sender<ToolResult>,
}

struct ProposalGuard<'a> {
    bridge: &'a Bridge,
    id: String,
}

impl Drop for ProposalGuard<'_> {
    fn drop(&mut self) {
        self.bridge.proposals.lock().remove(&self.id);
    }
}

/// Bridge compartilhado.
pub struct Bridge {
    clients: Mutex<Vec<ClientHandle>>,
    pending: Mutex<HashMap<String, Pending>>,
    proposals: Mutex<HashMap<String, (oneshot::Sender<Decision>, serde_json::Value)>>,
    proposal_sinks: Mutex<HashMap<String, Sink>>,
    mutation_lock: AsyncMutex<()>,
    headless: Option<headless::Headless>,
}

/// Guarda de vida de uma conexão autenticada: ao dropar, desregistra.
pub struct ClientGuard {
    bridge: Arc<Bridge>,
    id: Uuid,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.bridge.unregister(self.id);
    }
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            proposals: Mutex::new(HashMap::new()),
            proposal_sinks: Mutex::new(HashMap::new()),
            mutation_lock: AsyncMutex::new(()),
            headless: None,
        }
    }

    pub fn from_config(cfg: &Config) -> anyhow::Result<Self> {
        let mut bridge = Self::new();
        if !cfg.headless_url.is_empty() {
            bridge.headless = Some(headless::Headless::with_secret(
                &cfg.headless_url,
                &cfg.headless_secret,
            )?);
        }
        Ok(bridge)
    }

    pub fn is_headless(&self) -> bool {
        self.headless.is_some()
    }

    pub async fn headless_auth(
        &self,
        action: &str,
    ) -> Result<(u16, headless::AuthStatus), headless::AuthUnavailable> {
        match &self.headless {
            Some(backend) => backend.auth(action).await,
            None => Err(headless::AuthUnavailable),
        }
    }

    pub fn has_backend(&self) -> bool {
        self.is_headless() || self.has_client()
    }

    pub fn pending_proposals(&self) -> Vec<serde_json::Value> {
        self.proposals
            .lock()
            .values()
            .map(|(_, v)| v.clone())
            .collect()
    }

    pub fn watch_proposals(&self, session: &str, sink: Sink) {
        self.proposal_sinks.lock().insert(session.to_string(), sink);
    }

    pub fn unwatch_proposals(&self, session: &str) {
        self.proposal_sinks.lock().remove(session);
    }

    /* ------------------------------------------------------------- registry */

    /// Registra uma conexão autenticada. A devolvida é a "ativa" até que outra
    /// chegue (mesma semântica do `activeClient` do Node).
    pub fn register(
        self: &Arc<Self>,
        tx: Sink,
        app_version: String,
        locale: Option<String>,
    ) -> ClientGuard {
        let id = Uuid::new_v4();
        let handle = ClientHandle {
            id,
            tx,
            app_version,
            locale,
        };
        let mut clients = self.clients.lock();
        clients.retain(|c| !c.tx.is_closed());
        clients.push(handle);
        ClientGuard {
            bridge: Arc::clone(self),
            id,
        }
    }

    fn unregister(&self, id: Uuid) {
        let mut clients = self.clients.lock();
        clients.retain(|c| c.id != id && !c.tx.is_closed());
        let pending = std::mem::take(&mut *self.pending.lock());
        // Resolve os pendentes com `client_offline`: quem está esperando não pode
        // ficar 30 s pendurado porque a extensão morreu (invariante 3).
        for (_, p) in pending {
            let _ = p.tx.send(ToolResult::err("client_offline"));
        }
    }

    pub fn client_count(&self) -> usize {
        let mut clients = self.clients.lock();
        clients.retain(|c| !c.tx.is_closed());
        clients.len()
    }

    pub fn has_client(&self) -> bool {
        self.client_count() > 0
    }

    /// Conexão ativa (a mais recente viva).
    pub fn active_client(&self) -> Option<ClientHandle> {
        let mut clients = self.clients.lock();
        clients.retain(|c| !c.tx.is_closed());
        clients.last().cloned()
    }

    /// Snapshot do registry (para `/mcp` e a UI mostrarem "N clientes").
    pub fn clients(&self) -> Vec<ClientHandle> {
        let mut clients = self.clients.lock();
        clients.retain(|c| !c.tx.is_closed());
        clients.clone()
    }

    /* -------------------------------------------------------------- pending */

    fn register_pending(&self, id: &str) -> Result<oneshot::Receiver<ToolResult>, ToolResult> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock();
        if pending.contains_key(id) {
            // Invariante 4: nunca reaproveitar um id em voo.
            return Err(ToolResult::err("duplicate_call_id"));
        }
        pending.insert(id.to_string(), Pending { tx });
        Ok(rx)
    }

    fn settle_pending(&self, id: &str, result: ToolResult) {
        let entry = self.pending.lock().remove(id);
        if let Some(p) = entry {
            let _ = p.tx.send(result);
        }
    }

    /// Entrega o resultado vindo da extensão (`tool.result`).
    pub fn resolve_tool_result(&self, id: &str, result: ToolResult) -> bool {
        if self.pending.lock().contains_key(id) {
            self.settle_pending(id, result);
            true
        } else {
            false
        }
    }

    /// Entrega a decisão do usuário sobre uma proposta.
    pub fn resolve_proposal(&self, proposal_id: &str, decision: Decision) -> bool {
        let entry = self.proposals.lock().remove(proposal_id);
        match entry {
            Some((tx, _)) => {
                let _ = tx.send(decision);
                true
            }
            None => false,
        }
    }

    /* ---------------------------------------------------------- tool calling */

    /// Chama uma tool Spotify no backend selecionado (extensão ou headless).
    ///
    /// * `mutation` decide o gate: `Allow` executa direto; `Confirm` abre proposta
    ///   no Spotify ou na fila web; `Deny` recusa sem tocar no backend.
    /// * `snapshot` grava o estado anterior da playlist antes da escrita.
    pub async fn call_tool(
        self: &Arc<Self>,
        cfg: &Config,
        name: &str,
        args: serde_json::Value,
        opts: CallOptions<'_>,
    ) -> ToolResult {
        let call_id = opts.call_id.clone();
        let mutating = catalog::is_mutating(name);
        // A guarda precisa sobreviver até o retorno da escrita abaixo.
        let _mutation_guard;
        if mutating {
            if opts.mutation == MutationPolicy::Deny {
                return ToolResult::err("mutation_denied");
            }
            if !self.has_backend() {
                return ToolResult::err("client_offline");
            }
            // Invariante 2: serializa proposta + snapshot + escrita.
            _mutation_guard = self.mutation_lock.lock().await;

            if opts.mutation == MutationPolicy::Confirm {
                match self.ask_proposal(cfg, name, &args, &opts).await {
                    Ok(true) => {}
                    Ok(false) => return ToolResult::err("user_rejected"),
                    Err(code) => return ToolResult::err(code),
                }
            }

            if opts.snapshot {
                if let Some(playlist_id) = args
                    .get("playlist_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                {
                    // O snapshot vai por um id derivado do id original, como no Node
                    // (`snap_<id>`), e **não** dispara outro gate (é um get_*).
                    let snap_id = format!("snap_{call_id}");
                    let snap_args = serde_json::json!({ "playlist_id": playlist_id });
                    if let Some(store) = opts.store {
                        match self
                            .raw_call(cfg, &snap_id, "get_playlist_tracks", snap_args, None)
                            .await
                        {
                            ToolResult { ok: true, data, .. } => {
                                if self.is_headless()
                                    && !data.as_ref().is_some_and(|d| {
                                        d.as_array().is_some_and(|items| {
                                            items.iter().all(|t| {
                                                t.get("uri")
                                                    .and_then(|v| v.as_str())
                                                    .is_some_and(|s| !s.is_empty())
                                            })
                                        })
                                    })
                                {
                                    return ToolResult::err("snapshot_unavailable");
                                }
                                let uris: Vec<String> = data
                                    .as_ref()
                                    .and_then(|d| d.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|t| t.get("uri").and_then(|u| u.as_str()))
                                            .filter(|u| !u.is_empty())
                                            .map(str::to_string)
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let saved = store.with(|c| {
                                    crate::store::snapshots::try_save_snapshot(
                                        c,
                                        &playlist_id,
                                        &uris,
                                    )?;
                                    Ok(())
                                });
                                if saved.is_err() && self.is_headless() {
                                    return ToolResult::err("snapshot_unavailable");
                                }
                            }
                            _ if self.is_headless() => {
                                return ToolResult::err("snapshot_unavailable")
                            }
                            _ => {
                                tracing::warn!(call = %call_id, "snapshot indisponível; seguindo sem restaurável");
                            }
                        }
                    }
                }
            }
        }

        self.raw_call(cfg, &call_id, name, args, Some(opts)).await
    }

    /// Chamada crua, sem gate de mutação (usada para `get_*`, para o snapshot e
    /// pelos orquestradores de servidor).
    pub async fn raw_call(
        self: &Arc<Self>,
        cfg: &Config,
        call_id: &str,
        name: &str,
        args: serde_json::Value,
        opts: Option<CallOptions<'_>>,
    ) -> ToolResult {
        if let Some(backend) = &self.headless {
            let timeout_ms = opts.map(|o| o.timeout_ms).unwrap_or(cfg.tool_timeout_ms);
            return backend.call(name, args, timeout_ms).await;
        }
        let client = match self.active_client() {
            Some(c) => c,
            // Invariante 3: fail-closed imediato.
            None => return ToolResult::err("client_offline"),
        };
        let rx = match self.register_pending(call_id) {
            Ok(rx) => rx,
            Err(err) => return err,
        };
        let msg = ServerMsg::ToolCall {
            id: call_id.to_string(),
            name: name.to_string(),
            args: args.clone(),
        };
        if client.tx.send(msg).is_err() {
            self.settle_pending(call_id, ToolResult::err("client_offline"));
            return ToolResult::err("client_offline");
        }

        let timeout_ms = opts.map(|o| o.timeout_ms).unwrap_or(cfg.tool_timeout_ms);
        let waited = tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await;
        match waited {
            Ok(Ok(result)) => result,
            // Canal fechado (conexão morreu) ⇒ offline, não timeout.
            Ok(Err(_)) => {
                self.pending.lock().remove(call_id);
                ToolResult::err("client_offline")
            }
            // C3: timeout de tool = 30 s ⇒ `client_timeout`.
            Err(_) => {
                self.pending.lock().remove(call_id);
                ToolResult::err("client_timeout")
            }
        }
    }

    /// Executa uma tool de **servidor** (paridade com `runServerTool`).
    pub async fn run_server_tool(
        self: &Arc<Self>,
        cfg: &Config,
        name: &str,
        args: serde_json::Value,
        opts: CallOptions<'_>,
    ) -> ToolResult {
        let ctx = ServerToolContext {
            cfg,
            store: opts.store,
            bridge: Arc::clone(self),
            locale: opts.locale.to_string(),
            session_id: opts.session_id.to_string(),
        };
        crate::tools::server::run_server_tool(name, &args, &ctx).await
    }

    /// Abre a proposta no Spotify e espera a decisão (C3: 120 s ⇒ `reject`).
    async fn ask_proposal(
        self: &Arc<Self>,
        cfg: &Config,
        name: &str,
        args: &serde_json::Value,
        opts: &CallOptions<'_>,
    ) -> Result<bool, String> {
        let client = if self.is_headless() {
            None
        } else {
            self.active_client()
        };
        if client.is_none() && !self.is_headless() {
            return Err("client_offline".to_string());
        }
        let proposal_id = Uuid::new_v4().to_string();
        let summary = summarize(&opts.locale, name, args);
        if let Some(logs) = opts.sessions_dir {
            crate::logging::log_session(
                logs,
                &opts.session_id,
                "proposal.created",
                Some(serde_json::json!({
                    "proposalId": proposal_id,
                    "title": summary,
                    "name": name,
                    "args": args,
                })),
            );
        }
        let (tx, rx) = oneshot::channel();
        let message = ServerMsg::ProposalCreate {
            proposal_id: proposal_id.clone(),
            kind: "tool".to_string(),
            title: summary,
            name: name.to_string(),
            args: args.clone(),
        };
        self.proposals.lock().insert(
            proposal_id.clone(),
            (tx, serde_json::to_value(&message).unwrap_or_default()),
        );
        let _proposal_guard = ProposalGuard {
            bridge: self,
            id: proposal_id.clone(),
        };
        if self.is_headless() {
            if let Some(sink) = self.proposal_sinks.lock().get(&opts.session_id) {
                let _ = sink.send(message.clone());
            }
        }
        if let Some(client) = client {
            if client.tx.send(message).is_err() {
                self.proposals.lock().remove(&proposal_id);
                return Err("client_offline".to_string());
            }
        }
        let decision =
            tokio::time::timeout(Duration::from_millis(cfg.proposal_timeout_ms), rx).await;
        let decision = match decision {
            Ok(Ok(d)) => d,
            // Timeout ou canal fechado: recusa (nunca auto-aprova).
            _ => {
                self.proposals.lock().remove(&proposal_id);
                Decision::Reject
            }
        };
        if let Some(logs) = opts.sessions_dir {
            crate::logging::log_session(
                logs,
                &opts.session_id,
                "proposal.decided",
                Some(serde_json::json!({ "proposalId": proposal_id, "decision": decision })),
            );
        }
        Ok(matches!(decision, Decision::Approve))
    }

    /// Envia uma mensagem crua para a conexão ativa (usado por `/probe`).
    pub fn send_to_active(&self, msg: ServerMsg) -> bool {
        match self.active_client() {
            Some(client) => client.tx.send(msg).is_ok(),
            None => false,
        }
    }
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

/// Parâmetros de uma chamada de tool.
///
/// Strings são **owned** de propósito: elimina o inferno de lifetimes ao compor
/// ids dinâmicos (`snap_<id>`, `sc_<uri>`, `mcp_<uuid>`) sem alocar um `String`
/// temporário que não vive o suficiente.
#[derive(Clone)]
pub struct CallOptions<'a> {
    /// Id da chamada no protocolo WS (`tool.call.id`).
    pub call_id: String,
    pub session_id: String,
    pub locale: String,
    pub mutation: MutationPolicy,
    pub snapshot: bool,
    pub store: Option<&'a crate::store::Store>,
    pub sessions_dir: Option<&'a Path>,
    pub timeout_ms: u64,
}

impl<'a> CallOptions<'a> {
    pub fn agentic(
        cfg: &'a Config,
        call_id: &str,
        session_id: &str,
        locale: &str,
        store: &'a crate::store::Store,
    ) -> Self {
        Self {
            call_id: call_id.to_string(),
            session_id: session_id.to_string(),
            locale: locale.to_string(),
            // O loop agentic sempre confirma mutações (descrição das tools).
            mutation: MutationPolicy::Confirm,
            snapshot: true,
            store: Some(store),
            sessions_dir: Some(&cfg.sessions_dir),
            timeout_ms: cfg.tool_timeout_ms,
        }
    }

    pub fn mcp(
        mutation: MutationPolicy,
        call_id: &str,
        locale: &str,
        store: &'a crate::store::Store,
    ) -> Self {
        Self {
            call_id: call_id.to_string(),
            session_id: "mcp".to_string(),
            locale: locale.to_string(),
            mutation,
            // D3: snapshot independente da política.
            snapshot: true,
            store: Some(store),
            sessions_dir: None,
            timeout_ms: 30_000,
        }
    }
}

/// Resumo humano da mutação (paridade com `summarize()` de `agent/src/index.ts`).
pub fn summarize(locale: &str, name: &str, args: &serde_json::Value) -> String {
    let count = |key: &str| -> usize {
        args.get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    };
    let s = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "create_playlist" => crate::i18n::t(
            locale,
            "proposal.createPlaylist",
            &[
                ("name", &s("name")),
                ("count", &count("tracks").to_string()),
            ],
        ),
        "add_tracks" => crate::i18n::t(
            locale,
            "proposal.addTracks",
            &[("count", &count("uris").to_string())],
        ),
        "remove_tracks" => crate::i18n::t(
            locale,
            "proposal.removeTracks",
            &[("count", &count("uris").to_string())],
        ),
        "set_playlist_details" => crate::i18n::t(locale, "proposal.setDetails", &[]),
        "replace_playlist_tracks" => crate::i18n::t(
            locale,
            "proposal.replaceTracks",
            &[("count", &count("uris").to_string())],
        ),
        "set_playlist_cover" => crate::i18n::t(locale, "proposal.setCover", &[]),
        _ => crate::i18n::t(locale, "proposal.execute", &[("name", name)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_matches_node_strings() {
        assert_eq!(
            summarize(
                "en",
                "create_playlist",
                &serde_json::json!({"name":"Foco","tracks":["a","b"]})
            ),
            "Create playlist \"Foco\" with 2 tracks"
        );
        assert_eq!(
            summarize("pt-br", "add_tracks", &serde_json::json!({"uris":["a"]})),
            "Adicionar 1 faixas à playlist"
        );
        assert_eq!(
            summarize("en", "set_playlist_cover", &serde_json::json!({})),
            "Change the playlist cover"
        );
        assert_eq!(
            summarize("en", "unknown_tool", &serde_json::json!({})),
            "Run unknown_tool"
        );
    }

    #[tokio::test]
    async fn offline_client_fails_closed_immediately() {
        let bridge = Arc::new(Bridge::new());
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-bridge"));
        let start = std::time::Instant::now();
        let res = bridge
            .raw_call(&cfg, "c1", "get_playlists", serde_json::json!({}), None)
            .await;
        assert_eq!(res, ToolResult::err("client_offline"));
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "não pode esperar o timeout"
        );
    }

    #[tokio::test]
    async fn duplicate_call_id_is_rejected() {
        let bridge = Arc::new(Bridge::new());
        let (tx, _rx) = mpsc::unbounded_channel();
        let _guard = bridge.register(tx, "1.0.0".into(), None);
        let first = bridge.register_pending("same-id");
        assert!(first.is_ok());
        let second = bridge.register_pending("same-id");
        assert_eq!(second.err().unwrap(), ToolResult::err("duplicate_call_id"));
    }

    #[tokio::test]
    async fn resolve_tool_result_only_when_pending() {
        let bridge = Arc::new(Bridge::new());
        assert!(!bridge.resolve_tool_result("nope", ToolResult::ok_empty()));
        let _rx = bridge.register_pending("yes").unwrap();
        assert!(bridge.resolve_tool_result("yes", ToolResult::ok_empty()));
        assert!(!bridge.resolve_tool_result("yes", ToolResult::ok_empty()));
    }

    #[tokio::test]
    async fn dropping_client_resolves_pending_as_offline() {
        let bridge = Arc::new(Bridge::new());
        let (tx, _rx) = mpsc::unbounded_channel();
        let guard = bridge.register(tx, "1.0.0".into(), None);
        let rx = bridge.register_pending("in-flight").unwrap();
        drop(guard);
        let got = rx.await.unwrap();
        assert_eq!(got, ToolResult::err("client_offline"));
        assert_eq!(bridge.client_count(), 0);
    }

    #[tokio::test]
    async fn deny_policy_blocks_before_touching_the_client() {
        let bridge = Arc::new(Bridge::new());
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-bridge"));
        let res = bridge
            .call_tool(
                &cfg,
                "add_tracks",
                serde_json::json!({"playlist_id":"p","uris":["a"]}),
                CallOptions {
                    call_id: "c".to_string(),
                    session_id: "s".to_string(),
                    locale: "en".to_string(),
                    mutation: MutationPolicy::Deny,
                    snapshot: true,
                    store: None,
                    sessions_dir: None,
                    timeout_ms: 10,
                },
            )
            .await;
        assert_eq!(res, ToolResult::err("mutation_denied"));
    }
}
