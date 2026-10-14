//! Euterpe daemon — biblioteca.
//!
//! A organização segue `PLAN-REFACTOR.md` (§2.2): um módulo por responsabilidade.
//! `main.rs` é apenas o *composition root*; tudo o que é testável vive aqui.

pub mod bridge;
pub mod cli;
pub mod config;
pub mod http;
pub mod i18n;
pub mod llm;
pub mod logging;
pub mod mcp;
pub mod paths;
pub mod protocol;
pub mod providers;
pub mod secrets;
pub mod startup;
pub mod store;
pub mod tools;
pub mod upstream;
pub mod ws;

/// Versão do daemon. Deve espelhar `VERSION` em `agent/src/protocol.ts` para que
/// o handshake `hello.ok.version` seja indistinguível entre Node e Rust.
pub const VERSION: &str = "0.2.0";

use std::sync::Arc;

/// Estado compartilhado entre as rotas HTTP e as conexões WS.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<config::Config>,
    pub store: Arc<store::Store>,
    pub bridge: Arc<bridge::Bridge>,
    pub settings: Arc<store::settings::SettingsCache>,
    /// Conexão de espelho para o agente Node (Fase 2 / D6). Inerte quando
    /// `CHAT_UPSTREAM` está vazio.
    pub upstream: Arc<upstream::Upstream>,
}

impl AppState {
    pub fn new(cfg: config::Config) -> anyhow::Result<Self> {
        let store = Arc::new(store::Store::open(&cfg.db_path)?);
        let settings = Arc::new(store::settings::SettingsCache::load(&store)?);
        let bridge = Arc::new(bridge::Bridge::new());
        let upstream = Arc::new(upstream::Upstream::new(&cfg));
        Ok(Self {
            cfg: Arc::new(cfg),
            store,
            bridge,
            settings,
            upstream,
        })
    }

    /// Config efetiva = env/config.json + overrides persistidos em `settings`.
    pub fn effective(&self) -> config::EffectiveConfig {
        self.settings.effective(&self.cfg)
    }

    /// Conveniência para testes e rotas.
    pub fn locale(&self) -> String {
        crate::i18n::normalize_locale(None).to_string()
    }
}
