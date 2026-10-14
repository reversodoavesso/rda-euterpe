//! `/providers`, `/models`, `/providers/test` (Fase 4).
//!
//! Regra travada: **nenhuma chave sai daqui** — a API pública só devolve
//! `hasKey: true|false`.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{ProviderConfig, Wire};
use crate::AppState;

pub async fn list(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "app": "euterpe",
        "active": {
            "provider": state.effective().active_provider,
            "model": state.effective().active_model,
            "curationModel": state.effective().curation_model,
        },
        "providers": crate::providers::registry::public_listing(&state.cfg),
    }))
}

#[derive(Debug, Deserialize)]
pub struct ProviderUpsert {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default, rename = "baseUrl")]
    pub base_url: Option<String>,
    /// Chave em claro **apenas** no corpo do request; nunca é devolvida.
    #[serde(default, rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, rename = "extraBody")]
    pub extra_body: Option<Value>,
    #[serde(default, rename = "defaultModel")]
    pub default_model: Option<String>,
    #[serde(default, rename = "curationModel")]
    pub curation_model: Option<String>,
}

pub async fn upsert(State(state): State<AppState>, Json(body): Json<ProviderUpsert>) -> Response {
    let mut provider = match state
        .cfg
        .provider(&body.id)
        .cloned()
        .or_else(|| ProviderConfig::preset(&body.id))
    {
        Some(p) => p,
        None => {
            // Provider desconhecido: cria como `custom` (contrato tradicional).
            let mut custom = ProviderConfig::preset("custom").expect("preset custom");
            custom.id = body.id.clone();
            custom.name = body.id.clone();
            custom
        }
    };
    if let Some(name) = body.name {
        provider.name = name;
    }
    if let Some(kind) = body.kind.as_deref().and_then(Wire::parse) {
        provider.kind = kind;
    }
    if let Some(base_url) = body.base_url {
        provider.base_url = base_url;
    }
    if let Some(headers) = body.headers {
        provider.headers = headers;
    }
    if let Some(extra) = body.extra_body {
        provider.extra_body = extra;
    }
    if body.default_model.is_some() {
        provider.default_model = body.default_model;
    }
    if body.curation_model.is_some() {
        provider.curation_model = body.curation_model;
    }

    if let Some(key) = body.api_key.as_deref() {
        if let Err(err) = crate::secrets::set_provider_key(&provider.id, key) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "secret_write_failed", "detail": err.to_string() })),
            )
                .into_response();
        }
    }
    if let Err(err) = persist_provider(&state, &provider) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "config_write_failed", "detail": err.to_string() })),
        )
            .into_response();
    }
    if body.api_key.is_some() {
        // Ativar imediatamente o provider testado é o comportamento que a UI espera.
        let _ = state.settings.put(
            &state.store,
            crate::store::settings::KEY_ACTIVE_PROVIDER,
            &provider.id,
        );
    }
    Json(json!({
        "ok": true,
        "provider": {
            "id": provider.id,
            "name": provider.name,
            "kind": provider.kind,
            "baseUrl": provider.base_url,
            "hasKey": crate::secrets::has_provider_key(&provider.id),
        }
    }))
    .into_response()
}

pub async fn remove(State(_state): State<AppState>, Path(id): Path<String>) -> Response {
    if let Err(err) = crate::secrets::delete_provider_key(&id) {
        tracing::warn!(error = %err, "falha ao remover a chave do provider");
    }
    Json(json!({ "ok": true, "id": id, "hasKey": false })).into_response()
}

/// Persiste a lista de providers em `config.json` **do diretório de dados em uso**
/// (não no global `paths::config_file()`: isso mantinha os testes de integração
/// escrevendo na casa do usuário).
fn persist_provider(state: &AppState, provider: &ProviderConfig) -> anyhow::Result<()> {
    let mut providers = state.cfg.providers.clone();
    match providers.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => *existing = provider.clone(),
        None => providers.push(provider.clone()),
    }
    let payload = json!({ "providers": providers });
    let path = state.cfg.data_dir.join("config.json");
    let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut root: Value = serde_json::from_str(&existing).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    root["providers"] = payload["providers"].clone();
    if let Some(parent) = path.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub async fn models(State(state): State<AppState>, Query(q): Query<ModelsQuery>) -> Response {
    let provider_id = q
        .provider
        .unwrap_or_else(|| state.effective().active_provider);
    let (base_url, kind, model) = match state.cfg.provider(&provider_id) {
        Some(p) => (
            p.base_url.clone(),
            p.kind,
            q.model
                .clone()
                .unwrap_or_else(|| state.effective().active_model),
        ),
        None => match ProviderConfig::preset(&provider_id) {
            Some(p) => (
                p.base_url.clone(),
                p.kind,
                q.model.clone().unwrap_or_default(),
            ),
            None => return (
                StatusCode::NOT_FOUND,
                Json(json!({ "ok": false, "error": "unknown_provider", "provider": provider_id })),
            )
                .into_response(),
        },
    };
    let base_url = q.base_url.unwrap_or(base_url);
    let key = q
        .api_key
        .or_else(|| crate::secrets::provider_key(&provider_id));
    let spec = ProviderConfig {
        id: provider_id.clone(),
        name: provider_id.clone(),
        kind,
        base_url,
        headers: Default::default(),
        extra_body: Value::Null,
        models: vec![],
        default_model: None,
        curation_model: None,
    };
    match crate::providers::registry::build(&spec, key, &model) {
        Ok(adapter) => match adapter.list_models().await {
            Ok(models) => Json(json!({ "ok": true, "provider": provider_id, "models": models })).into_response(),
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "provider": provider_id, "error": "models_unavailable", "detail": err.to_string() })),
            )
                .into_response(),
        },
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "provider": provider_id, "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct TestRequest {
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    /// Chave avulsa de teste: **não** é persistida.
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub async fn test(State(state): State<AppState>, Json(body): Json<TestRequest>) -> Response {
    let provider_id = body
        .provider
        .unwrap_or_else(|| state.effective().active_provider);
    let preset = state
        .cfg
        .provider(&provider_id)
        .cloned()
        .or_else(|| ProviderConfig::preset(&provider_id));
    let Some(preset) = preset else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "unknown_provider", "provider": provider_id })),
        )
            .into_response();
    };
    let model = body.model.unwrap_or_else(|| state.effective().active_model);
    let base_url = body.base_url.unwrap_or_else(|| preset.base_url.clone());
    let key = body
        .api_key
        .clone()
        .or_else(|| crate::secrets::provider_key(&provider_id));
    let spec = ProviderConfig { base_url, ..preset };
    let started = std::time::Instant::now();
    match crate::providers::registry::build(&spec, key, &model) {
        Ok(adapter) => match adapter.test().await {
            Ok(mut report) => {
                if body.api_key.is_some() && report.ok {
                    // Só persiste a chave depois de ela provar que funciona.
                    let _ = crate::secrets::set_provider_key(&provider_id, body.api_key.as_deref().unwrap_or(""));
                }
                report.latency_ms = started.elapsed().as_millis() as u64;
                Json(json!({ "ok": report.ok, "provider": provider_id, "report": report })).into_response()
            }
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "provider": provider_id, "error": "test_failed", "detail": err.to_string() })),
            )
                .into_response(),
        },
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "provider": provider_id, "error": err.to_string() })),
        )
            .into_response(),
    }
}
