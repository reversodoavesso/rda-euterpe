//! `GET/PUT /settings` (Fase 4/6) — tudo que a UI pode mudar sem reiniciar.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::config::{MutationPolicy, WebSearchBackend};
use crate::store::settings as keys;
use crate::AppState;

/// Papel que o perfil serve hoje (`chat` / `curation`), para a UI rotular o chip.
fn role_of(eff: &crate::config::EffectiveConfig, profile_id: &str) -> Option<&'static str> {
    use crate::config::{ROLE_CHAT, ROLE_CURATION};
    if eff.role_profiles.get(ROLE_CHAT).map(String::as_str) == Some(profile_id) {
        return Some(ROLE_CHAT);
    }
    if eff.role_profiles.get(ROLE_CURATION).map(String::as_str) == Some(profile_id) {
        return Some(ROLE_CURATION);
    }
    None
}

fn snapshot(state: &AppState) -> Value {
    let eff = state.effective();
    let profiles: Vec<Value> = eff
        .profiles
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "provider": p.provider,
                "model": p.model,
                "role": role_of(&eff, &p.id),
                "temperature": p.temperature,
                "maxTokens": p.max_tokens,
                "baseUrl": p.base_url,
                // Último teste OBSERVADO: `{ok, latencyMs, at}`; `null` enquanto
                // não houver (a UI mostra "sem teste"). Nunca estimamos.
                "lastTest": state.settings.last_test(&p.id).map(|(ok, ms, at)| json!({
                    "ok": ok,
                    "latencyMs": ms,
                    "at": at,
                })),
            })
        })
        .collect();
    json!({
        "app": "euterpe",
        "version": crate::VERSION,
        "settings": {
            "activeProvider": eff.active_provider,
            "activeModel": eff.active_model,
            "activeProfile": eff.active_profile,
            "curationProvider": eff.curation_provider,
            "curationModel": eff.curation_model,
            "profiles": profiles,
            "roleProfiles": eff.role_profiles,
            "sessionOverrides": eff.session_overrides,
            "instructions": eff.instructions,
            "mcpEnabled": eff.mcp_enabled,
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
    // --- perfis / papéis / override / instruções / MCP ---
    #[serde(default)]
    pub profiles: Option<Vec<crate::config::ModelProfile>>,
    #[serde(default, rename = "activeProfile")]
    pub active_profile: Option<String>,
    #[serde(default, rename = "roleProfiles")]
    pub role_profiles: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "sessionOverrides")]
    pub session_overrides: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default, rename = "mcpEnabled")]
    pub mcp_enabled: Option<bool>,
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

    if let Some(v) = patch.active_provider.clone() {
        write(keys::KEY_ACTIVE_PROVIDER, v, &mut applied);
    }
    if let Some(v) = patch.active_model.clone() {
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
    if patch.profiles.is_none() && (patch.active_provider.is_some() || patch.active_model.is_some())
    {
        if let Some(mut list) = state
            .settings
            .get_json::<Vec<crate::config::ModelProfile>>(keys::KEY_PROFILES)
        {
            let active_id = patch
                .active_profile
                .clone()
                .or_else(|| state.settings.get(keys::KEY_ACTIVE_PROFILE))
                .unwrap_or_else(|| "default".to_string());
            if let Some(p) = list.iter_mut().find(|p| p.id == active_id) {
                if let Some(ref prov) = patch.active_provider {
                    p.provider = prov.clone();
                }
                if let Some(ref model) = patch.active_model {
                    p.model = model.clone();
                }
                if let Ok(json) = serde_json::to_value(&list) {
                    let _ = state
                        .settings
                        .put_json(&state.store, keys::KEY_PROFILES, &json);
                }
            }
        }
    }
    if let Some(v) = patch.chat_upstream {
        state.upstream.set_url(&v);
        write(keys::KEY_CHAT_UPSTREAM, v, &mut applied);
    }
    // Perfis: lista vazia **reseta** (volta ao perfil sintetizado), o que evita
    // o usuário ficar preso num estado sem perfil.
    if let Some(v) = patch.profiles {
        if v.is_empty() {
            if state
                .settings
                .remove(&state.store, keys::KEY_PROFILES)
                .is_ok()
            {
                applied.push(keys::KEY_PROFILES);
            }
        } else {
            match serde_json::to_value(&v) {
                Ok(json) => {
                    if state
                        .settings
                        .put_json(&state.store, keys::KEY_PROFILES, &json)
                        .is_ok()
                    {
                        applied.push(keys::KEY_PROFILES);
                    }
                }
                Err(err) => tracing::warn!(error = %err, "profiles não serializaram"),
            }
        }
    }
    if let Some(v) = patch.active_profile {
        write(keys::KEY_ACTIVE_PROFILE, v, &mut applied);
    }
    if let Some(v) = patch.role_profiles {
        if v.is_empty() {
            if state
                .settings
                .remove(&state.store, keys::KEY_ROLE_PROFILES)
                .is_ok()
            {
                applied.push(keys::KEY_ROLE_PROFILES);
            }
        } else if let Ok(json) = serde_json::to_value(&v) {
            if state
                .settings
                .put_json(&state.store, keys::KEY_ROLE_PROFILES, &json)
                .is_ok()
            {
                applied.push(keys::KEY_ROLE_PROFILES);
            }
        }
    }
    if let Some(v) = patch.session_overrides {
        if v.is_empty() {
            if state
                .settings
                .remove(&state.store, keys::KEY_SESSION_OVERRIDES)
                .is_ok()
            {
                applied.push(keys::KEY_SESSION_OVERRIDES);
            }
        } else if let Ok(json) = serde_json::to_value(&v) {
            if state
                .settings
                .put_json(&state.store, keys::KEY_SESSION_OVERRIDES, &json)
                .is_ok()
            {
                applied.push(keys::KEY_SESSION_OVERRIDES);
            }
        }
    }
    if let Some(v) = patch.instructions {
        write(keys::KEY_INSTRUCTIONS, v, &mut applied);
    }
    if let Some(v) = patch.mcp_enabled {
        write(keys::KEY_MCP_ENABLED, v.to_string(), &mut applied);
    }

    let mut body = snapshot(&state);
    body["applied"] = json!(applied);
    Json(body)
}

/// `POST /profiles/:id/test` — mede a latência do perfil e **persiste a medida**
/// (a UI só mostra latência observada; sem teste, mostra "—").
pub async fn test_profile(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let profile = state.effective().profiles.into_iter().find(|p| p.id == id);
    let Some(profile) = profile else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "unknown_profile", "profile": id })),
        )
            .into_response();
    };
    let adapter = match crate::providers::registry::for_profile(&state.cfg, &profile) {
        Ok(adapter) => adapter,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "ok": false, "profile": profile.id, "error": err.to_string() })),
            )
                .into_response()
        }
    };
    let started = std::time::Instant::now();
    match adapter.test().await {
        Ok(mut report) => {
            let latency = started.elapsed().as_millis() as u64;
            report.latency_ms = latency;
            // Registra o teste (ok ou falho) — é dado observado, não estimado.
            let _ =
                state
                    .settings
                    .set_last_test(&state.store, &profile.id, report.ok, latency as u32);
            Json(json!({
                "ok": report.ok,
                "profile": profile.id,
                "provider": profile.provider,
                "model": profile.model,
                "latencyMs": latency,
                "report": report,
            }))
            .into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "ok": false,
                "profile": profile.id,
                "error": "test_failed",
                "detail": err.to_string(),
            })),
        )
            .into_response(),
    }
}
