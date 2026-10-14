//! Configuração efetiva do daemon (PLAN-REFACTOR.md §2.2, §F4).
//!
//! Fontes, da menor para a maior precedência:
//!  1. defaults embutidos;
//!  2. `config.json` no diretório de dados;
//!  3. variáveis de ambiente;
//!  4. overrides persistidos na tabela `settings` (via [`super::store::settings`]).
//!
//! Compatibilidade: `DEEPSEEK_API_KEY` continua funcionando e é traduzida para um
//! provider `deepseek` (wire `openai-compat`), como no agente Node (`config.ts`).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MutationPolicy {
    #[default]
    Allow,
    Confirm,
    Deny,
}

impl MutationPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Confirm => "confirm",
            Self::Deny => "deny",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "allow" => Some(Self::Allow),
            "confirm" => Some(Self::Confirm),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// Fio de protocolo de um provider (o "contrato tradicional" = openai-compat).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Wire {
    #[default]
    OpenaiCompat,
    Anthropic,
    Gemini,
    Ollama,
}

impl Wire {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "openai-compat" | "openai" | "openai-compatible" | "custom" => Some(Self::OpenaiCompat),
            "anthropic" | "claude" => Some(Self::Anthropic),
            "gemini" | "google" => Some(Self::Gemini),
            "ollama" | "lmstudio" | "local" => Some(Self::Ollama),
            _ => None,
        }
    }
}

/// Configuração de um provider cadastrado pelo usuário.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: Wire,
    #[serde(default)]
    pub base_url: String,
    /// Cabeçalhos extras (provider "custom").
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Corpo extra mesclado no request (provider "custom").
    #[serde(default, rename = "extraBody")]
    pub extra_body: serde_json::Value,
    #[serde(default)]
    pub models: Vec<String>,
    /// Modelo default sugerido para chat.
    #[serde(default, rename = "defaultModel")]
    pub default_model: Option<String>,
    /// Modelo default sugerido para curadoria (roteamento por complexidade).
    #[serde(default, rename = "curationModel")]
    pub curation_model: Option<String>,
}

impl ProviderConfig {
    pub fn preset(id: &str) -> Option<Self> {
        let (name, kind, base_url, default_model, curation_model): (&str, Wire, &str, &str, &str) =
            match id {
                "deepseek" => (
                    "DeepSeek",
                    Wire::OpenaiCompat,
                    "https://api.deepseek.com",
                    // `deepseek-chat`/`deepseek-reasoner` foram descontinuados em
                    // 2026-07-24 (api-docs.deepseek.com/updates). Os nomes atuais
                    // são `deepseek-flash` (V4.1-Flash) e `deepseek-v4-pro`.
                    "deepseek-flash",
                    "deepseek-v4-pro",
                ),
                "openai" => (
                    "OpenAI",
                    Wire::OpenaiCompat,
                    "https://api.openai.com/v1",
                    "gpt-4o-mini",
                    "gpt-4o",
                ),
                "groq" => (
                    "Groq",
                    Wire::OpenaiCompat,
                    "https://api.groq.com/openai/v1",
                    "llama-3.3-70b-versatile",
                    "llama-3.3-70b-versatile",
                ),
                "openrouter" => (
                    "OpenRouter",
                    Wire::OpenaiCompat,
                    "https://openrouter.ai/api/v1",
                    "openai/gpt-4o-mini",
                    "anthropic/claude-3.5-sonnet",
                ),
                "together" => (
                    "Together",
                    Wire::OpenaiCompat,
                    "https://api.together.xyz/v1",
                    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                    "meta-llama/Llama-3.3-70B-Instruct-Turbo",
                ),
                "xai" => (
                    "xAI",
                    Wire::OpenaiCompat,
                    "https://api.x.ai/v1",
                    "grok-2-latest",
                    "grok-2-latest",
                ),
                "mistral" => (
                    "Mistral",
                    Wire::OpenaiCompat,
                    "https://api.mistral.ai/v1",
                    "mistral-small-latest",
                    "mistral-large-latest",
                ),
                "anthropic" => (
                    "Anthropic",
                    Wire::Anthropic,
                    "https://api.anthropic.com",
                    "claude-3-5-haiku-latest",
                    "claude-3-5-sonnet-latest",
                ),
                "gemini" => (
                    "Google Gemini",
                    Wire::Gemini,
                    "https://generativelanguage.googleapis.com",
                    "gemini-3.8-flash",
                    "gemini-3.8-flash",
                ),
                "ollama" => (
                    "Ollama",
                    Wire::Ollama,
                    "http://127.0.0.1:11434",
                    "llama3.2",
                    "llama3.2",
                ),
                "lmstudio" => (
                    "LM Studio",
                    Wire::OpenaiCompat,
                    "http://127.0.0.1:1234/v1",
                    "local-model",
                    "local-model",
                ),
                "custom" => ("Custom (OpenAI-compat)", Wire::OpenaiCompat, "", "", ""),
                _ => return None,
            };
        Some(Self {
            id: id.to_string(),
            name: name.to_string(),
            kind,
            base_url: base_url.to_string(),
            headers: BTreeMap::new(),
            extra_body: serde_json::Value::Null,
            models: Vec::new(),
            default_model: Some(default_model.to_string()).filter(|s| !s.is_empty()),
            curation_model: Some(curation_model.to_string()).filter(|s| !s.is_empty()),
        })
    }

    /// Ids de presets conhecidos (ordem estável para a UI).
    pub fn preset_ids() -> &'static [&'static str] {
        &[
            "deepseek",
            "openai",
            "anthropic",
            "gemini",
            "groq",
            "openrouter",
            "together",
            "xai",
            "mistral",
            "ollama",
            "lmstudio",
            "custom",
        ]
    }
}

/// Backend de busca na web (Fase 5: cadeia SearXNG → Brave/Tavily → DuckDuckGo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WebSearchBackend {
    #[default]
    Auto,
    Searxng,
    Brave,
    Tavily,
    Duckduckgo,
    Off,
}

impl WebSearchBackend {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => Some(Self::Auto),
            "searxng" => Some(Self::Searxng),
            "brave" => Some(Self::Brave),
            "tavily" => Some(Self::Tavily),
            "duckduckgo" | "ddg" => Some(Self::Duckduckgo),
            "off" | "none" | "disabled" => Some(Self::Off),
            _ => None,
        }
    }
}

/// Configuração do daemon (env + config.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub ws_secret: String,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub providers: Vec<ProviderConfig>,
    pub active_provider: String,
    pub active_model: String,
    pub curation_model: String,
    pub mutation_policy: MutationPolicy,
    pub web_search: WebSearchBackend,
    pub searxng_url: String,
    pub brave_api_key: Option<String>,
    pub tavily_api_key: Option<String>,
    pub lastfm_api_key: Option<String>,
    pub tastedive_api_key: Option<String>,
    pub chat_history_turns: u32,
    pub max_tool_steps: u32,
    pub suggestions: bool,
    pub auto_routing: bool,
    pub debug: bool,
    pub llm_timeout_ms: u64,
    pub tool_timeout_ms: u64,
    pub proposal_timeout_ms: u64,
    /// Quando definido, o chat é encaminhado por WS ao agente Node (Fase 2 / D6).
    /// Ex.: `ws://127.0.0.1:8338/ws`. Vazio ⇒ loop LLM nativo do Rust (Fase 4).
    pub chat_upstream: String,
    /// Pasta de logs de sessão (compatível com o agente Node).
    pub sessions_dir: PathBuf,
    pub probes_dir: PathBuf,
}

impl Config {
    /// Carrega a configuração: defaults ← `config.json` ← env, e resolve o
    /// segredo do handshake (arquivo/env) só aqui.
    ///
    /// [`Self::from_sources`] é puro de propósito: **não** cria arquivo nenhum em
    /// `%APPDATA%`, o que mantém os testes unitários sem efeito colateral.
    pub fn load() -> anyhow::Result<Self> {
        let data_dir = paths::data_dir();
        paths::ensure_dir(&data_dir)?;
        let file: serde_json::Value = match std::fs::read_to_string(paths::config_file()) {
            Ok(raw) if !raw.trim().is_empty() => {
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)
            }
            _ => serde_json::Value::Null,
        };
        let mut cfg = Self::from_sources(&file, &std::env::vars().collect())?;
        if cfg.ws_secret.trim().is_empty() {
            cfg.ws_secret = crate::secrets::ws_secret()?;
        }
        Ok(cfg)
    }

    /// Núcleo puro (testável): `config.json` = `file`, env = `env`.
    pub fn from_sources(
        file: &serde_json::Value,
        env: &BTreeMap<String, String>,
    ) -> anyhow::Result<Self> {
        let pick = |key: &str| -> Option<String> {
            if let Some(v) = env.get(key) {
                let t = v.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
                return None;
            }
            file.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        };
        let pick_bool = |key: &str, default: bool| -> bool {
            if let Some(v) = env.get(key) {
                let t = v.trim().to_ascii_lowercase();
                if !t.is_empty() {
                    return matches!(t.as_str(), "1" | "true" | "yes" | "on");
                }
            }
            file.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
        };
        let pick_u64 = |key: &str, default: u64| -> u64 {
            if let Some(v) = env.get(key) {
                if let Ok(n) = v.trim().parse::<u64>() {
                    return n;
                }
            }
            file.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
        };

        // providers: do config.json; sempre garante ao menos o preset deepseek.
        let mut providers: Vec<ProviderConfig> = file
            .get("providers")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        if providers.is_empty() {
            for id in ProviderConfig::preset_ids() {
                if let Some(p) = ProviderConfig::preset(id) {
                    providers.push(p);
                }
            }
        }

        let host = pick("HOST").unwrap_or_else(|| "127.0.0.1".to_string());
        let port = pick("PORT")
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8337);

        // Back-compat Node: DEEPSEEK_API_KEY + LLM_BASE_URL + LLM_CHAT_MODEL.
        let deepseek_key = pick("DEEPSEEK_API_KEY");
        let legacy_base = pick("LLM_BASE_URL");
        if let Some(url) = legacy_base {
            if let Some(p) = providers.iter_mut().find(|p| p.id == "deepseek") {
                p.base_url = url;
            }
        }
        if let Some(key) = deepseek_key {
            // Guarda a chave no store de segredos (não em config.json).
            let _ = crate::secrets::set_provider_key("deepseek", &key);
        }

        let active_provider = pick("EUTERPE_PROVIDER")
            .or_else(|| {
                file.get("activeProvider")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "deepseek".to_string());

        let default_model = providers
            .iter()
            .find(|p| p.id == active_provider)
            .and_then(|p| p.default_model.clone())
            .unwrap_or_else(|| "deepseek-flash".to_string());
        let default_curation = providers
            .iter()
            .find(|p| p.id == active_provider)
            .and_then(|p| p.curation_model.clone())
            .unwrap_or_else(|| default_model.clone());

        let mutation_policy = pick("EUTERPE_MUTATION_POLICY")
            .as_deref()
            .and_then(MutationPolicy::parse)
            .unwrap_or_default();
        let web_search = pick("EUTERPE_WEB_SEARCH")
            .as_deref()
            .and_then(WebSearchBackend::parse)
            .unwrap_or_default();

        Ok(Self {
            host,
            port,
            ws_secret: pick("WS_SECRET").unwrap_or_default(),
            data_dir: paths::data_dir(),
            db_path: paths::db_path(),
            providers,
            active_provider,
            active_model: pick("LLM_CHAT_MODEL").unwrap_or(default_model),
            curation_model: pick("LLM_CURATION_MODEL").unwrap_or(default_curation),
            mutation_policy,
            web_search,
            searxng_url: pick("SEARXNG_URL").unwrap_or_else(|| "http://127.0.0.1:8888".to_string()),
            brave_api_key: pick("BRAVE_API_KEY"),
            tavily_api_key: pick("TAVILY_API_KEY"),
            lastfm_api_key: pick("LASTFM_API_KEY"),
            tastedive_api_key: pick("TASTEDIVE_API_KEY"),
            chat_history_turns: pick_u64("CHAT_HISTORY", 0) as u32,
            max_tool_steps: pick_u64("MAX_TOOL_STEPS", 12) as u32,
            suggestions: pick_bool("EUTERPE_SUGGESTIONS", true),
            auto_routing: pick_bool("AUTO_ROUTING", false),
            debug: pick_bool("EUTERPE_DEBUG", false),
            llm_timeout_ms: pick_u64("LLM_TIMEOUT_MS", 120_000),
            tool_timeout_ms: pick_u64("EUTERPE_TOOL_TIMEOUT_MS", 30_000),
            proposal_timeout_ms: pick_u64("EUTERPE_PROPOSAL_TIMEOUT_MS", 120_000),
            chat_upstream: pick("CHAT_UPSTREAM").unwrap_or_default(),
            sessions_dir: paths::sessions_dir(),
            probes_dir: paths::probes_dir(),
        })
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|p| p.id == id)
    }

    /// Construtor de conveniência para testes.
    pub fn for_test(data_dir: PathBuf) -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 0,
            ws_secret: "test-secret".into(),
            db_path: data_dir.join("euterpe.db"),
            providers: vec![ProviderConfig::preset("deepseek").unwrap()],
            active_provider: "deepseek".into(),
            active_model: "deepseek-flash".into(),
            curation_model: "deepseek-v4-pro".into(),
            mutation_policy: MutationPolicy::Allow,
            web_search: WebSearchBackend::Auto,
            searxng_url: "http://127.0.0.1:8888".into(),
            brave_api_key: None,
            tavily_api_key: None,
            lastfm_api_key: None,
            tastedive_api_key: None,
            chat_history_turns: 0,
            max_tool_steps: 12,
            suggestions: true,
            auto_routing: false,
            debug: false,
            llm_timeout_ms: 120_000,
            tool_timeout_ms: 5_000,
            proposal_timeout_ms: 5_000,
            chat_upstream: String::new(),
            sessions_dir: data_dir.join("sessions"),
            probes_dir: data_dir.join("probes"),
            data_dir,
        }
    }
}

/// Papel do modelo: quem responde o chat.
pub const ROLE_CHAT: &str = "chat";
/// Papel do modelo: curadoria (proposta de playlist / pedido de criação).
pub const ROLE_CURATION: &str = "curation";

/// Perfil de modelo: um nome curto para `provider + modelo`. Substitui os dois
/// selects do header — o chip do chat mostra o **perfil**, não o par solto.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    /// Parâmetros do perfil. `None` = aplica o padrão do adapter. Todos com
    /// `serde(default)` para que perfis já gravados continuem válidos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Sobrescreve o `base_url` do provider (caso típico: servidor local).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl ModelProfile {
    pub fn new(id: &str, name: &str, provider: &str, model: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            temperature: None,
            max_tokens: None,
            base_url: None,
        }
    }

    /// Perfil sintetizado da config, para `profiles` nunca ficar vazio (a UI
    /// sempre tem um chip para mostrar).
    pub fn default_from(provider: &str, model: &str) -> Self {
        Self::new("default", "Padrão", provider, model)
    }
}

/// Vista efetiva (env + `settings` do banco). É o que as rotas usam.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveConfig {
    pub active_provider: String,
    pub active_model: String,
    /// Provider do papel de curadoria (pode diferir do provider do chat).
    pub curation_provider: String,
    pub curation_model: String,
    /// Perfis nomeados. Nunca vazio (ver [`ModelProfile::default_from`]).
    pub profiles: Vec<ModelProfile>,
    /// Id do perfil ativo (o que o chip do chat mostra).
    pub active_profile: String,
    /// `papel → id de perfil` (`chat`, `curation`).
    pub role_profiles: BTreeMap<String, String>,
    /// `conversa → id de perfil` (override de uma conversa só).
    pub session_overrides: BTreeMap<String, String>,
    /// Instruções do usuário, acrescentadas ao system prompt em runtime. Nunca
    /// gravadas no asset gerado (`prompts.json` é golden — ver `prompts.rs`).
    pub instructions: String,
    /// Parâmetros do perfil ativo do chat, aplicados à requisição real.
    pub active_temperature: Option<f32>,
    pub active_max_tokens: Option<u32>,
    /// `base_url` do perfil ativo (None = a do provider).
    pub active_base_url: Option<String>,
    pub mcp_enabled: bool,
    pub mutation_policy: MutationPolicy,
    pub web_search: WebSearchBackend,
    pub debug: bool,
    pub suggestions: bool,
    pub auto_routing: bool,
    pub chat_history_turns: u32,
    pub max_tool_steps: u32,
    pub chat_upstream: String,
}

impl EffectiveConfig {
    /// Id do perfil que a conversa usa: override da conversa → papel `chat` →
    /// perfil ativo global.
    pub fn profile_id_for_session(&self, session_id: Option<&str>) -> String {
        if let Some(id) = session_id.and_then(|s| self.session_overrides.get(s)) {
            return id.clone();
        }
        if let Some(id) = self.role_profiles.get(ROLE_CHAT) {
            return id.clone();
        }
        self.active_profile.clone()
    }

    /// Perfil por id, com fallback para o ativo e, por fim, para o sintetizado.
    pub fn profile(&self, id: &str) -> ModelProfile {
        self.profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|p| p.id == self.active_profile)
                    .cloned()
            })
            .unwrap_or_else(|| {
                ModelProfile::default_from(&self.active_provider, &self.active_model)
            })
    }

    /// Resolve o provider/modelo do chat para uma conversa, aplicando override e
    /// papel. É o que o loop LLM consome.
    pub fn chat_profile_for_session(&self, session_id: Option<&str>) -> ModelProfile {
        self.profile(&self.profile_id_for_session(session_id))
    }

    /// Perfil do papel de curadoria (fallback: o modelo de curadoria da config).
    pub fn curation_profile(&self) -> ModelProfile {
        let id = self.role_profiles.get(ROLE_CURATION);
        match id.and_then(|id| self.profiles.iter().find(|p| &p.id == id)) {
            Some(p) => p.clone(),
            None => ModelProfile::new(
                "curation",
                "Curadoria",
                &self.curation_provider,
                &self.curation_model,
            ),
        }
    }
}

impl Config {
    pub fn default_effective(&self) -> EffectiveConfig {
        EffectiveConfig {
            active_provider: self.active_provider.clone(),
            active_model: self.active_model.clone(),
            curation_provider: self.active_provider.clone(),
            curation_model: self.curation_model.clone(),
            profiles: vec![ModelProfile::default_from(
                &self.active_provider,
                &self.active_model,
            )],
            active_profile: "default".to_string(),
            role_profiles: BTreeMap::new(),
            session_overrides: BTreeMap::new(),
            instructions: String::new(),
            active_temperature: None,
            active_max_tokens: None,
            active_base_url: None,
            mcp_enabled: true,
            mutation_policy: self.mutation_policy,
            web_search: self.web_search,
            debug: self.debug,
            suggestions: self.suggestions,
            auto_routing: self.auto_routing,
            chat_history_turns: self.chat_history_turns,
            max_tool_steps: self.max_tool_steps,
            chat_upstream: self.chat_upstream.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_match_node_agent() {
        let e = BTreeMap::new();
        let c = Config::from_sources(&serde_json::Value::Null, &e).unwrap();
        assert_eq!(c.host, "127.0.0.1");
        assert_eq!(c.port, 8337);
        // `from_sources` é puro de propósito: o segredo do handshake só é
        // materializado por `Config::load()`, o único caminho que pode gravar em
        // `%APPDATA%`. Sem isso, um teste unitário criaria arquivo na casa do usuário.
        assert!(
            c.ws_secret.is_empty(),
            "from_sources não pode resolver o segredo"
        );
        assert_eq!(c.searxng_url, "http://127.0.0.1:8888");
        assert_eq!(c.max_tool_steps, 12);
        assert_eq!(c.chat_history_turns, 0);
        assert!(
            c.suggestions,
            "EUTERPE_SUGGESTIONS default é ligado no Node"
        );
        assert!(!c.auto_routing);
        assert!(!c.debug);
        assert_eq!(
            c.mutation_policy,
            MutationPolicy::Allow,
            "D3: allow por padrão"
        );
    }

    #[test]
    fn ws_secret_comes_from_env_when_present() {
        let c = Config::from_sources(&serde_json::Value::Null, &env(&[("WS_SECRET", "abc123")]))
            .unwrap();
        assert_eq!(c.ws_secret, "abc123");
    }

    #[test]
    fn port_and_flags_come_from_env() {
        let c = Config::from_sources(
            &serde_json::Value::Null,
            &env(&[
                ("PORT", "9000"),
                ("MAX_TOOL_STEPS", "3"),
                ("AUTO_ROUTING", "true"),
                ("EUTERPE_DEBUG", "1"),
                ("EUTERPE_SUGGESTIONS", "false"),
                ("CHAT_HISTORY", "6"),
            ]),
        )
        .unwrap();
        assert_eq!(c.port, 9000);
        assert_eq!(c.max_tool_steps, 3);
        assert!(c.auto_routing);
        assert!(c.debug);
        assert!(!c.suggestions);
        assert_eq!(c.chat_history_turns, 6);
    }

    #[test]
    fn config_json_is_lower_precedence_than_env() {
        let file = serde_json::json!({ "PORT": 9999, "activeProvider": "openai" });
        let c = Config::from_sources(&file, &env(&[("PORT", "8337")])).unwrap();
        assert_eq!(c.port, 8337);
        assert_eq!(c.active_provider, "openai");
    }

    #[test]
    fn provider_presets_cover_the_contracts() {
        assert_eq!(
            ProviderConfig::preset("anthropic").unwrap().kind,
            Wire::Anthropic
        );
        assert_eq!(ProviderConfig::preset("gemini").unwrap().kind, Wire::Gemini);
        assert_eq!(ProviderConfig::preset("ollama").unwrap().kind, Wire::Ollama);
        assert_eq!(
            ProviderConfig::preset("custom").unwrap().kind,
            Wire::OpenaiCompat
        );
        for id in ProviderConfig::preset_ids() {
            assert!(ProviderConfig::preset(id).is_some(), "preset {id} ausente");
        }
    }

    #[test]
    fn mutation_policy_parsing() {
        assert_eq!(MutationPolicy::parse("ALLOW"), Some(MutationPolicy::Allow));
        assert_eq!(
            MutationPolicy::parse(" confirm "),
            Some(MutationPolicy::Confirm)
        );
        assert_eq!(MutationPolicy::parse("deny"), Some(MutationPolicy::Deny));
        assert_eq!(MutationPolicy::parse("nope"), None);
    }
}
