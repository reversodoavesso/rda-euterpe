//! Tabela `settings` — a novidade do Rust (PLAN-REFACTOR.md §2.2).
//!
//! Guarda escolhas do usuário que devem sobreviver ao restart: provider/modelo
//! ativos, política de mutação, backend de busca, toggles. Mantém um cache em
//! memória para não bater no SQLite a cada mensagem de chat.

use parking_lot::RwLock;
use serde_json::Value;
use std::collections::BTreeMap;

use super::Store;
use crate::config::{
    Config, EffectiveConfig, ModelProfile, MutationPolicy, WebSearchBackend, ROLE_CHAT,
    ROLE_CURATION,
};

pub const KEY_ACTIVE_PROVIDER: &str = "activeProvider";
pub const KEY_ACTIVE_MODEL: &str = "activeModel";
pub const KEY_CURATION_MODEL: &str = "curationModel";
/// Perfis nomeados (JSON: `[ModelProfile]`).
pub const KEY_PROFILES: &str = "profiles";
/// Id do perfil ativo (o chip do header).
pub const KEY_ACTIVE_PROFILE: &str = "activeProfile";
/// `papel → id de perfil` (JSON: `{ "chat": "sol" }`).
pub const KEY_ROLE_PROFILES: &str = "roleProfiles";
/// `conversa → id de perfil` (JSON: `{ "s-1": "barato" }`).
pub const KEY_SESSION_OVERRIDES: &str = "sessionOverrides";
/// Instruções do usuário, acrescentadas ao system prompt em runtime.
pub const KEY_INSTRUCTIONS: &str = "instructions";
pub const KEY_MCP_ENABLED: &str = "mcpEnabled";
/// Último teste observado de um perfil (JSON `{ok, latencyMs, at}`).
pub const KEY_LAST_TEST_PREFIX: &str = "lastTest:";
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

    /// Valor JSON decodificado; ausente ou inválido ⇒ `None` (nunca explode).
    pub fn get_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get(key)
            .and_then(|raw| serde_json::from_str::<T>(&raw).ok())
    }

    /// Último teste **observado** do perfil: `(ok, latência_ms, unix_segundos)`.
    /// Enquanto não houver teste, a UI mostra "sem teste" — nunca estimamos.
    pub fn last_test(&self, profile_id: &str) -> Option<(bool, u32, u64)> {
        let raw = self.get(&format!("{KEY_LAST_TEST_PREFIX}{profile_id}"))?;
        let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
        Some((
            v.get("ok")?.as_bool()?,
            v.get("latencyMs")?.as_u64()? as u32,
            v.get("at")?.as_u64()?,
        ))
    }

    /// Grava o resultado do teste do perfil (chamado por `POST /profiles/:id/test`).
    pub fn set_last_test(
        &self,
        store: &Store,
        profile_id: &str,
        ok: bool,
        latency_ms: u32,
    ) -> anyhow::Result<()> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let value = serde_json::json!({ "ok": ok, "latencyMs": latency_ms, "at": at });
        self.put_json(
            store,
            &format!("{KEY_LAST_TEST_PREFIX}{profile_id}"),
            &value,
        )
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
        if let Some(v) = self.get(KEY_INSTRUCTIONS) {
            eff.instructions = v;
        }
        if let Some(v) = self.get_bool(KEY_MCP_ENABLED) {
            eff.mcp_enabled = v;
        }

        // --- perfis nomeados: o PERFIL é a fonte do par provider/modelo ---
        // Sem perfis explícitos, o sintetizado reflete o que está valendo agora —
        // assim `activeProvider`/`activeModel` continuam funcionando sozinhos
        // (quem nunca criou um perfil não pode regredir).
        if self.get(KEY_PROFILES).is_none() {
            eff.profiles = vec![ModelProfile::default_from(
                &eff.active_provider,
                &eff.active_model,
            )];
        }
        if let Some(list) = self.get_json::<Vec<ModelProfile>>(KEY_PROFILES) {
            if !list.is_empty() {
                eff.profiles = list;
            }
        }
        if let Some(p) = eff.profiles.iter_mut().find(|p| p.id == "default") {
            p.provider = eff.active_provider.clone();
            p.model = eff.active_model.clone();
        }
        if let Some(v) = self.get(KEY_ACTIVE_PROFILE) {
            eff.active_profile = v;
        }
        if let Some(map) = self.get_json::<BTreeMap<String, String>>(KEY_ROLE_PROFILES) {
            eff.role_profiles = map;
        }
        if let Some(map) = self.get_json::<BTreeMap<String, String>>(KEY_SESSION_OVERRIDES) {
            eff.session_overrides = map;
        }
        // Precedência do chat: papel `chat` vence o perfil ativo global.
        let chat_id = eff
            .role_profiles
            .get(ROLE_CHAT)
            .cloned()
            .unwrap_or_else(|| eff.active_profile.clone());
        let chat = eff.profile(&chat_id);
        eff.active_profile = chat.id.clone();
        eff.active_provider = chat.provider;
        eff.active_model = chat.model;
        // Parâmetros do perfil alimentam a requisição real (loop LLM).
        eff.active_temperature = chat.temperature;
        eff.active_max_tokens = chat.max_tokens;
        eff.active_base_url = chat.base_url;
        // Curadoria: só troca o par quando o papel está definido (senão mantém
        // `curationModel`/provider da config, como sempre foi).
        if eff.role_profiles.contains_key(ROLE_CURATION) {
            let curation = eff.curation_profile();
            eff.curation_provider = curation.provider;
            eff.curation_model = curation.model;
        }
        eff
    }

    /// Config efetiva **de uma conversa**: o override daquela conversa vence a
    /// resolução global (é o "usar só nesta conversa" da UI).
    pub fn effective_for_session(&self, cfg: &Config, session_id: Option<&str>) -> EffectiveConfig {
        let mut eff = self.effective(cfg);
        let Some(session_id) = session_id else {
            return eff;
        };
        let Some(id) = eff.session_overrides.get(session_id).cloned() else {
            return eff;
        };
        let profile = eff.profile(&id);
        eff.active_profile = profile.id.clone();
        eff.active_provider = profile.provider;
        eff.active_model = profile.model;
        eff.active_temperature = profile.temperature;
        eff.active_max_tokens = profile.max_tokens;
        eff.active_base_url = profile.base_url;
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
        assert_eq!(cache.effective(&cfg).active_model, "deepseek-flash");

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

    // --- perfis / papéis / override (B) ---

    fn cfg() -> Config {
        Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-profiles"))
    }

    fn profiles() -> Vec<ModelProfile> {
        vec![
            ModelProfile::new("sol", "Sol", "deepseek", "deepseek-flash"),
            ModelProfile::new("barato", "Barato", "groq", "llama-3.3-70b"),
            ModelProfile::new("pro", "Pro", "openai", "gpt-4o"),
        ]
    }

    #[test]
    fn the_active_profile_drives_provider_and_model() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache
            .put_json(
                &store,
                KEY_PROFILES,
                &serde_json::to_value(profiles()).unwrap(),
            )
            .unwrap();
        cache.put(&store, KEY_ACTIVE_PROFILE, "barato").unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.active_provider, "groq");
        assert_eq!(eff.active_model, "llama-3.3-70b");
        assert_eq!(eff.active_profile, "barato");
        assert_eq!(eff.profiles.len(), 3);
    }

    #[test]
    fn the_chat_role_beats_the_active_profile() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache
            .put_json(
                &store,
                KEY_PROFILES,
                &serde_json::to_value(profiles()).unwrap(),
            )
            .unwrap();
        cache.put(&store, KEY_ACTIVE_PROFILE, "barato").unwrap();
        cache
            .put_json(
                &store,
                KEY_ROLE_PROFILES,
                &serde_json::json!({ "chat": "sol" }),
            )
            .unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.active_profile, "sol");
        assert_eq!(eff.active_provider, "deepseek");
        assert_eq!(eff.active_model, "deepseek-flash");
    }

    #[test]
    fn the_curation_role_can_point_at_another_provider() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache
            .put_json(
                &store,
                KEY_PROFILES,
                &serde_json::to_value(profiles()).unwrap(),
            )
            .unwrap();
        cache
            .put_json(
                &store,
                KEY_ROLE_PROFILES,
                &serde_json::json!({ "curation": "pro" }),
            )
            .unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.curation_provider, "openai");
        assert_eq!(eff.curation_model, "gpt-4o");
        // Sem papel de curadoria o default segue sendo o modelo da config.
        let sem_papel = SettingsCache::load(&Store::in_memory().unwrap()).unwrap();
        let eff2 = sem_papel.effective(&cfg());
        assert_eq!(eff2.curation_provider, eff2.active_provider);
    }

    #[test]
    fn a_session_override_wins_only_for_that_session() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache
            .put_json(
                &store,
                KEY_PROFILES,
                &serde_json::to_value(profiles()).unwrap(),
            )
            .unwrap();
        cache.put(&store, KEY_ACTIVE_PROFILE, "sol").unwrap();
        cache
            .put_json(
                &store,
                KEY_SESSION_OVERRIDES,
                &serde_json::json!({ "s-42": "barato" }),
            )
            .unwrap();

        let cfg = cfg();
        let global = cache.effective(&cfg);
        assert_eq!(global.active_model, "deepseek-flash");

        let s42 = cache.effective_for_session(&cfg, Some("s-42"));
        assert_eq!(s42.active_model, "llama-3.3-70b");
        assert_eq!(s42.active_profile, "barato");

        // Outra conversa segue o global; sem sessionId também.
        assert_eq!(
            cache.effective_for_session(&cfg, Some("s-99")).active_model,
            "deepseek-flash"
        );
        assert_eq!(
            cache.effective_for_session(&cfg, None).active_model,
            "deepseek-flash"
        );
        // E o perfil resolvido para a conversa é o mesmo que a UI mostra.
        assert_eq!(s42.chat_profile_for_session(Some("s-42")).name, "Barato");
    }

    #[test]
    fn an_unknown_profile_id_falls_back_instead_of_breaking() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        cache
            .put_json(
                &store,
                KEY_PROFILES,
                &serde_json::to_value(profiles()).unwrap(),
            )
            .unwrap();
        // Id que não existe em `profiles`: fail-closed, cai no primeiro perfil.
        cache.put(&store, KEY_ACTIVE_PROFILE, "fantasma").unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.active_model, "deepseek-flash");
        // JSON corrompido também não derruba a resolução.
        cache.put(&store, KEY_PROFILES, "{isso nao e json").unwrap();
        assert_eq!(cache.effective(&cfg()).active_model, "deepseek-flash");
    }

    #[test]
    fn instructions_and_mcp_toggle_come_from_settings() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        assert!(cache.effective(&cfg()).mcp_enabled);
        assert!(cache.effective(&cfg()).instructions.is_empty());

        cache
            .put(&store, KEY_INSTRUCTIONS, "Sempre cite o BPM.")
            .unwrap();
        cache.put(&store, KEY_MCP_ENABLED, "false").unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.instructions, "Sempre cite o BPM.");
        assert!(!eff.mcp_enabled);
    }

    #[test]
    fn measured_latency_is_stored_per_profile() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        assert_eq!(
            cache.last_test("sol"),
            None,
            "sem teste ⇒ a UI mostra 'sem teste'"
        );
        cache.set_last_test(&store, "sol", true, 1180).unwrap();
        let (ok, ms, at) = cache.last_test("sol").expect("gravado");
        assert!(ok);
        assert_eq!(ms, 1180);
        assert!(at > 1_700_000_000, "timestamp unix plausível");
        assert_eq!(cache.last_test("barato"), None);
        // Teste que falhou também é registrado (a UI mostra o estado real).
        cache.set_last_test(&store, "barato", false, 40).unwrap();
        assert_eq!(cache.last_test("barato").map(|(ok, _, _)| ok), Some(false));
    }

    #[test]
    fn profile_params_reach_the_effective_config() {
        let store = Store::in_memory().unwrap();
        let cache = SettingsCache::load(&store).unwrap();
        let mut list = profiles();
        list[1].temperature = Some(0.3);
        list[1].max_tokens = Some(4096);
        list[1].base_url = Some("http://127.0.0.1:8080/v1".to_string());
        cache
            .put_json(&store, KEY_PROFILES, &serde_json::to_value(&list).unwrap())
            .unwrap();
        cache.put(&store, KEY_ACTIVE_PROFILE, "barato").unwrap();

        let eff = cache.effective(&cfg());
        assert_eq!(eff.active_temperature, Some(0.3));
        assert_eq!(eff.active_max_tokens, Some(4096));
        assert_eq!(
            eff.active_base_url.as_deref(),
            Some("http://127.0.0.1:8080/v1")
        );
        // Perfil sem params não inventa nada.
        assert_eq!(eff.profile("sol").temperature, None);

        // E o override por conversa leva os params do perfil da conversa.
        cache
            .put_json(
                &store,
                KEY_SESSION_OVERRIDES,
                &serde_json::json!({ "s-9": "barato" }),
            )
            .unwrap();
        assert_eq!(
            cache
                .effective_for_session(&cfg(), Some("s-9"))
                .active_max_tokens,
            Some(4096)
        );
    }
}
