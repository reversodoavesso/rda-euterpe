//! Registry de providers: escolhe o adapter a partir de `config::Wire`.
//!
//! Único ponto onde nome de provider vira implementação. Adicionar um provider
//! novo é adicionar um preset em `config.rs`, nunca um `if` no loop.

use std::sync::Arc;

use crate::config::{Config, EffectiveConfig, ProviderConfig, Wire};
use crate::llm::adapters::{
    anthropic::Anthropic, gemini::Gemini, ollama::Ollama, openai_compat::OpenAiCompat,
};
use crate::llm::canonical::LlmAdapter;
use crate::secrets;

/// Monta o adapter para um provider concreto.
pub fn build(
    provider: &ProviderConfig,
    key: Option<String>,
    model: &str,
) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    let model = if model.trim().is_empty() {
        provider
            .default_model
            .clone()
            .unwrap_or_else(|| "default".to_string())
    } else {
        model.to_string()
    };
    if !secrets::key_optional(provider.kind) {
        match key.as_deref() {
            Some(k) if !k.trim().is_empty() => {}
            _ => anyhow::bail!("missing_api_key:{}", provider.id),
        }
    }
    let adapter: Arc<dyn LlmAdapter> = match provider.kind {
        Wire::OpenaiCompat => Arc::new(OpenAiCompat::new(
            provider.base_url.clone(),
            key,
            model,
            provider.headers.clone(),
            provider.extra_body.clone(),
        )),
        Wire::Anthropic => Arc::new(Anthropic::new(
            provider.base_url.clone(),
            key.unwrap_or_default(),
            model,
        )),
        Wire::Gemini => Arc::new(Gemini::new(
            provider.base_url.clone(),
            key.unwrap_or_default(),
            model,
        )),
        Wire::Ollama => Arc::new(Ollama::new(provider.base_url.clone(), model)),
    };
    Ok(adapter)
}

/// Resolve o adapter de curadoria (papel `curation`; default: o modelo forte do
/// mesmo provider — ver `EffectiveConfig::curation_profile`).
pub fn curation(cfg: &Config, eff: &EffectiveConfig) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    resolve(cfg, &eff.curation_provider, &eff.curation_model)
}

/// Resolve o adapter de um perfil explícito (teste de conexão da UI), honrando
/// o `base_url` do próprio perfil.
pub fn for_profile(
    cfg: &Config,
    profile: &crate::config::ModelProfile,
) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    resolve_with(
        cfg,
        &profile.provider,
        &profile.model,
        profile.base_url.as_deref(),
    )
}

/// Resolve o adapter ativo, honrando o `base_url` do perfil ativo.
pub fn active(cfg: &Config, eff: &EffectiveConfig) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    resolve_with(
        cfg,
        &eff.active_provider,
        &eff.active_model,
        eff.active_base_url.as_deref(),
    )
}

/// Resolve `provider_id` + `model` explícitos.
pub fn resolve(
    cfg: &Config,
    provider_id: &str,
    model: &str,
) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    resolve_with(cfg, provider_id, model, None)
}

/// Igual a [`resolve`], mas permite trocar o `base_url` (perfil local/custom).
pub fn resolve_with(
    cfg: &Config,
    provider_id: &str,
    model: &str,
    base_url: Option<&str>,
) -> anyhow::Result<Arc<dyn LlmAdapter>> {
    let provider = cfg
        .provider(provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown_provider:{provider_id}"))?;
    let key = secrets::provider_key_at(&cfg.data_dir, provider_id);
    match base_url.map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => {
            let spec = crate::config::ProviderConfig {
                base_url: url.to_string(),
                ..provider.clone()
            };
            build(&spec, key, model)
        }
        None => build(provider, key, model),
    }
}

/// Catálogo de providers visível para a UI (`GET /providers`).
///
/// **Nunca** devolve a chave — só `has_key` (regra do PLAN-REFACTOR §F4).
pub fn public_listing(cfg: &Config) -> Vec<serde_json::Value> {
    // `true` = está salvo em config.json (o usuário adicionou esse provider).
    // Os presets entram com `false` só para alimentar o seletor "adicionar".
    let mut known: Vec<(&ProviderConfig, bool)> = cfg.providers.iter().map(|p| (p, true)).collect();
    for id in ProviderConfig::preset_ids() {
        let already = known.iter().any(|(p, _)| p.id == *id);
        if !already {
            if let Some(p) = ProviderConfig::preset(id) {
                known.push((Box::leak(Box::new(p)), false));
            }
        }
    }
    known
        .into_iter()
        .map(|(p, configured)| {
            serde_json::json!({
                "id": p.id,
                "name": if p.name.is_empty() { p.id.clone() } else { p.name.clone() },
                "kind": p.kind,
                "baseUrl": p.base_url,
                "configured": configured,
                "hasKey": secrets::has_provider_key_at(&cfg.data_dir, &p.id),
                "needsKey": !secrets::key_optional(p.kind),
                "models": p.models,
                "defaultModel": p.default_model,
                "curationModel": p.curation_model,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn provider(id: &str, key_present: bool) -> ProviderConfig {
        let mut p = ProviderConfig::preset(id).unwrap();
        if key_present {
            p.headers.insert("__test".into(), "1".into());
        }
        p
    }

    #[test]
    fn local_providers_do_not_require_keys() {
        let p = provider("ollama", false);
        let adapter = build(&p, None, "llama3.2").unwrap();
        assert_eq!(adapter.wire(), Wire::Ollama);
    }

    #[test]
    fn remote_providers_require_a_key() {
        let p = provider("openai", false);
        let err = build(&p, None, "gpt-4o-mini")
            .map(|_| ())
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("missing_api_key:"), "{err}");
        assert!(build(&p, Some("sk-x".into()), "gpt-4o-mini").is_ok());
    }

    #[test]
    fn each_preset_maps_to_the_expected_wire() {
        let cases = [
            ("deepseek", Wire::OpenaiCompat),
            ("openai", Wire::OpenaiCompat),
            ("groq", Wire::OpenaiCompat),
            ("anonymous-custom", Wire::OpenaiCompat),
            ("gemini", Wire::Gemini),
            ("ollama", Wire::Ollama),
        ];
        for (id, wire) in cases {
            let p = if id == "anonymous-custom" {
                ProviderConfig::preset("custom").unwrap()
            } else {
                ProviderConfig::preset(id).unwrap()
            };
            let adapter = build(&p, Some("k".into()), "m").unwrap();
            assert_eq!(adapter.wire(), wire, "provider {id}");
        }
    }

    #[test]
    fn missing_provider_is_an_explicit_error() {
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-registry"));
        let err = resolve(&cfg, "nope", "m")
            .map(|_| ())
            .unwrap_err()
            .to_string();
        assert_eq!(err, "unknown_provider:nope");
    }

    #[test]
    fn public_listing_never_leaks_keys() {
        let cfg = Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-registry"));
        let listing = public_listing(&cfg);
        assert!(listing.len() >= ProviderConfig::preset_ids().len());
        for entry in &listing {
            assert!(entry.get("apiKey").is_none());
            assert!(entry.get("hasKey").is_some());
            let serialized = entry.to_string();
            assert!(!serialized.contains("sk-"), "vazou chave: {serialized}");
        }
        let map: BTreeMap<String, &serde_json::Value> = listing
            .iter()
            .map(|e| (e["id"].as_str().unwrap().to_string(), e))
            .collect();
        assert_eq!(map["ollama"]["needsKey"], false);
        assert_eq!(map["openai"]["needsKey"], true);
    }
}
