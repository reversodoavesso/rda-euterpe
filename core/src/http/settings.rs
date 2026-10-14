//! `GET/PUT /settings` (Fase 4/6) — tudo que a UI pode mudar sem reiniciar.

use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{MutationPolicy, WebSearchBackend};
use crate::store::settings as keys;
use crate::AppState;

fn snapshot(state: &AppState) -> Value {
    let eff = state.effective();
    json!({
        "app": "euterpe",
        "version": crate::VERSION,
        "settings": {
            "activeProvider": eff.active_provider,
            "activeModel": eff.active_model,
            "curationModel": eff.curation_model,
            "mutationPolicy": eff.mutation_policy,
            "mutationAllowlist": state.settings.mutation_allowlist(),
            "webSearch": eff.web_search,
            "debug": eff.debug,
            "suggestions": eff.suggestions,
            "autoRouting": eff.auto_routing,
            "chatHistoryTurns": eff.chat_history_turns,
            "maxToolSteps": eff.max_tool_steps,
            "chatUpstream": eff.chat_upstream,
        },
        "runtime": {
            "clients": state.bridge.client_count(),
            "upstream": state.upstream.enabled(),
            "dataDir": state.cfg.data_dir.display().to_string(),
            "port": state.cfg.port,
        },
    })
}

pub async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    Json(snapshot(&state))
}

#[derive(Debug, Deserialize, Default)]
pub struct SettingsPatch {
    #[serde(default, rename = "activeProvider")]
    pub active_provider: Option<String>,
    #[serde(default, rename = "activeModel")]
    pub active_model: Option<String>,
    #[serde(default, rename = "curationModel")]
    pub curation_model: Option<String>,
    #[serde(default, rename = "mutationPolicy")]
    pub mutation_policy: Option<String>,
    #[serde(default, rename = "mutationAllowlist")]
    pub mutation_allowlist: Option<Vec<String>>,
    #[serde(default, rename = "webSearch")]
    pub web_search: Option<String>,
    #[serde(default)]
    pub debug: Option<bool>,
    #[serde(default)]
    pub suggestions: Option<bool>,
    #[serde(default, rename = "autoRouting")]
    pub auto_routing: Option<bool>,
    #[serde(default, rename = "chatHistoryTurns")]
    pub chat_history_turns: Option<u32>,
    #[serde(default, rename = "maxToolSteps")]
    pub max_tool_steps: Option<u32>,
    #[serde(default, rename = "chatUpstream")]
    pub chat_upstream: Option<String>,
}

pub async fn put_settings(
    State(state): State<AppState>,
    Json(patch): Json<SettingsPatch>,
) -> Json<Value> {
    let mut applied: Vec<&'static str> = Vec::new();
    let write = |key: &'static str, value: String, applied: &mut Vec<&'static str>| {
        if let Err(err) = state.settings.put(&state.store, key, &value) {
            tracing::warn!(error = %err, key, "falha ao gravar setting");
        } else {
            applied.push(key);
        }
    };

    if let Some(v) = patch.active_provider {
        write(keys::KEY_ACTIVE_PROVIDER, v, &mut applied);
    }
    if let Some(v) = patch.active_model {
        write(keys::KEY_ACTIVE_MODEL, v, &mut applied);
    }
    if let Some(v) = patch.curation_model {
        write(keys::KEY_CURATION_MODEL, v, &mut applied);
    }
    if let Some(v) = patch.mutation_policy {
        match MutationPolicy::parse(&v) {
            Some(_) => write(keys::KEY_MUTATION_POLICY, v, &mut applied),
            None => tracing::warn!(value = %v, "mutationPolicy inválida ignorada"),
        }
    }
    if let Some(v) = patch.mutation_allowlist {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
        write(keys::KEY_MUTATION_ALLOWLIST, json, &mut applied);
    }
    if let Some(v) = patch.web_search {
        match WebSearchBackend::parse(&v) {
            Some(_) => write(keys::KEY_WEB_SEARCH, v, &mut applied),
            None => tracing::warn!(value = %v, "webSearch inválido ignorado"),
        }
    }
    if let Some(v) = patch.debug {
        write(keys::KEY_DEBUG, v.to_string(), &mut applied);
    }
    if let Some(v) = patch.suggestions {
        write(keys::KEY_SUGGESTIONS, v.to_string(), &mut applied);
    }
    if let Some(v) = patch.auto_routing {
        write(keys::KEY_AUTO_ROUTING, v.to_string(), &mut applied);
    }
    if let Some(v) = patch.chat_history_turns {
        write(keys::KEY_CHAT_HISTORY, v.to_string(), &mut applied);
    }
    if let Some(v) = patch.max_tool_steps {
        write(keys::KEY_MAX_TOOL_STEPS, v.to_string(), &mut applied);
    }
    if let Some(v) = patch.chat_upstream {
        write(keys::KEY_CHAT_UPSTREAM, v, &mut applied);
    }

    let mut body = snapshot(&state);
    body["applied"] = json!(applied);
    Json(body)
}
