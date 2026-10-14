//! Tabela `settings` — a novidade do Rust (PLAN-REFACTOR.md §2.2).
//!
//! Guarda escolhas do usuário que devem sobreviver ao restart: provider/modelo
//! ativos, política de mutação, backend de busca, toggles. Mantém um cache em
//! memória para não bater no SQLite a cada mensagem de chat.

use parking_lot::RwLock;
use serde_json::Value;
use std::collections::BTreeMap;

use super::Store;
use crate::config::{Config, EffectiveConfig, MutationPolicy, WebSearchBackend};

pub const KEY_ACTIVE_PROVIDER: &str = "activeProvider";
pub const KEY_ACTIVE_MODEL: &str = "activeModel";
pub const KEY_CURATION_MODEL: &str = "curationModel";
pub const KEY_MUTATION_POLICY: &str = "mutationPolicy";
pub const KEY_MUTATION_ALLOWLIST: &str = "mutationAllowlist";
pub const KEY_WEB_SEARCH: &str = "webSearch";
pub const KEY_DEBUG: &str = "debug";
pub const KEY_SUGGESTIONS: &str = "suggestions";
pub const KEY_AUTO_ROUTING: &str = "autoRouting";
pub const KEY_CHAT_HISTORY: &str = "chatHistoryTurns";
pub const KEY_MAX_TOOL_STEPS: &str = "maxToolSteps";
pub const KEY_CHAT_UPSTREAM: &str = "chatUpstream";
/// Provider escolhido por provider específico para "curadoria" (modelo forte).
pub const KEY_LAST_MODEL_PREFIX: &str = "lastModel:";

/// Cache em memória + persistência na tabela `settings`.
pub struct SettingsCache {
    map: RwLock<BTreeMap<String, String>>,
}

impl SettingsCache {
    pub fn load(store: &Store) -> anyhow::Result<Self> {
        let rows: Vec<(String, String)> = store
            .with(|c| {
                let mut stmt = c.prepare("SELECT key, value FROM settings")?;
                let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                it.collect()
            })
            .unwrap_or_default();
        Ok(Self {
            map: RwLock::new(rows.into_iter().collect()),
        })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.map
            .read()
            .get(key)
            .cloned()
            .filter(|v| !v.trim().is_empty())
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
    }

    pub fn get_u32(&self, key: &str) -> Option<u32> {
        self.get(key).and_then(|v| v.trim().parse().ok())
    }

    pub fn all(&self) -> BTreeMap<String, String> {
        self.map.read().clone()
    }

    /// Grava (memória + banco).
    pub fn put(&self, store: &Store, key: &str, value: &str) -> anyhow::Result<()> {
        store.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                rusqlite::params![key, value],
            )
            .map(|_| ())
        })?;
        self.map.write().insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn put_json(&self, store: &Store, key: &str, value: &Value) -> anyhow::Result<()> {
        self.put(store, key, &serde_json::to_string(value)?)
    }

    pub fn remove(&self, store: &Store, key: &str) -> anyhow::Result<()> {
        store.with(|c| {
            c.execute("DELETE FROM settings WHERE key = ?", [key])
                .map(|_| ())
        })?;
        self.map.write().remove(key);
        Ok(())
    }

    /// Overrides persistidos sobre a config de env/arquivo.
    pub fn effective(&self, cfg: &Config) -> EffectiveConfig {
        let mut eff = cfg.default_effective();
        if let Some(v) = self.get(KEY_ACTIVE_PROVIDER) {
            eff.active_provider = v;
        }
        if let Some(v) = self.get(KEY_ACTIVE_MODEL) {
            eff.active_model = v;
        }
        if let Some(v) = self.get(KEY_CURATION_MODEL) {
            eff.curation_model = v;
        }
        if let Some(v) = self
            .get(KEY_MUTATION_POLICY)
            .as_deref()
            .and_then(MutationPolicy::parse)
        {
            eff.mutation_policy = v;
        }
        if let Some(v) = self
            .get(KEY_WEB_SEARCH)
            .as_deref()
            .and_then(WebSearchBackend::parse)
        {
            eff.web_search = v;
        }
        if let Some(v) = self.get_bool(KEY_DEBUG) {
            eff.debug = v;
        }
        if let Some(v) = self.get_bool(KEY_SUGGESTIONS) {
            eff.suggestions = v;
        }
        if let Some(v) = self.get_bool(KEY_AUTO_ROUTING) {
            eff.auto_routing = v;
        }
        if let Some(v) = self.get_u32(KEY_CHAT_HISTORY) {
            eff.chat_history_turns = v;
        }
        if let Some(v) = self.get_u32(KEY_MAX_TOOL_STEPS) {
            eff.max_tool_steps = v;
        }
        if let Some(v) = self.get(KEY_CHAT_UPSTREAM) {
            eff.chat_upstream = v;
        }
        eff
    }

    /// Allowlist de mutação (D3): vazio ⇒ todas permitidas.
    pub fn mutation_allowlist(&self) -> Vec<String> {
        self.get(KEY_MUTATION_ALLOWLIST)
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_overrides_env_config() {
        let store = Store::in_memory().unwrap();
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-x"));
        let cache = SettingsCache::load(&store).unwrap();
        assert_eq!(cache.effective(&cfg).active_model, "deepseek-chat");

        cache.put(&store, KEY_ACTIVE_MODEL, "gpt-4o-mini").unwrap();
        cache.put(&store, KEY_MUTATION_POLICY, "confirm").unwrap();
        cache.put(&store, KEY_SUGGESTIONS, "false").unwrap();
        cache.put(&store, KEY_CHAT_HISTORY, "8").unwrap();

        let eff = cache.effective(&cfg);
        assert_eq!(eff.active_model, "gpt-4o-mini");
        assert_eq!(eff.mutation_policy, MutationPolicy::Confirm);
        assert!(!eff.suggestions);
        assert_eq!(eff.chat_history_turns, 8);

        // Recarregar do banco preserva os overrides.
        let reloaded = SettingsCache::load(&store).unwrap();
        assert_eq!(reloaded.effective(&cfg).active_model, "gpt-4o-mini");
    }

    #[test]
    fn empty_values_are_treated_as_absent() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache.put(&store, KEY_DEBUG, "").unwrap();
        assert_eq!(cache.get(KEY_DEBUG), None);
        assert_eq!(cache.get_bool(KEY_DEBUG), None);
    }

    #[test]
    fn mutation_allowlist_defaults_empty() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        assert!(cache.mutation_allowlist().is_empty());
        cache
            .put_json(
                &store,
                KEY_MUTATION_ALLOWLIST,
                &serde_json::json!(["add_tracks"]),
            )
            .unwrap();
        assert_eq!(cache.mutation_allowlist(), vec!["add_tracks".to_string()]);
    }
}
