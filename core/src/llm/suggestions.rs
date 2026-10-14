//! Sugestões dinâmicas (quick replies) — paridade com `generateSuggestions`.
//!
//! Nunca quebra o fluxo: qualquer falha devolve `[]` e a UI cai no fallback.
//! Usa JSON mode quando o provider declara suportar; onde não suporta (Anthropic,
//! Gemini sem `responseMimeType`), o parser tolerante do C8 salva o dia.

use crate::llm::canonical::{ChatRequest, Msg};

use super::prompts;
use super::r#loop::ChatDeps;

pub const SUGGESTIONS_TIMEOUT_MS: u64 = 10_000;
pub const SUGGESTIONS_MAX_TOKENS: u32 = 800;

pub async fn generate(
    deps: &ChatDeps<'_>,
    model: &str,
    history: &[Msg],
    user_text: &str,
    final_text: &str,
) -> Vec<String> {
    let adapter = match deps.adapter.clone() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let started = std::time::Instant::now();
    let mut messages: Vec<Msg> = vec![Msg::system(prompts::suggestions_prompt(Some(&deps.locale)))];
    // `history.slice(-8)` do Node.
    let start = history.len().saturating_sub(8);
    messages.extend(history[start..].iter().cloned());
    messages.push(Msg::user(user_text));
    messages.push(Msg::assistant_text(final_text));

    let mut req = ChatRequest::new(model.to_string(), messages);
    req.max_tokens = Some(SUGGESTIONS_MAX_TOKENS);
    req.temperature = Some(0.7);
    req.timeout_ms = SUGGESTIONS_TIMEOUT_MS;
    // JSON mode é capability: onde faltar, o parser tolerante resolve.
    req.json_mode = adapter.capabilities().json_mode;

    let result = adapter.complete(req).await;
    let suggestions = match result {
        Ok(completion) => prompts::parse_suggestions(completion.text.as_deref().unwrap_or("")),
        Err(err) => {
            crate::logging::log_session(
                &deps.cfg.sessions_dir,
                &deps.session_id,
                "suggestions",
                Some(serde_json::json!({
                    "count": 0,
                    "error": err.to_string(),
                    "latency_ms": started.elapsed().as_millis() as u64,
                })),
            );
            return Vec::new();
        }
    };
    crate::logging::log_session(
        &deps.cfg.sessions_dir,
        &deps.session_id,
        "suggestions",
        Some(serde_json::json!({
            "count": suggestions.len(),
            "latency_ms": started.elapsed().as_millis() as u64,
        })),
    );
    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_node_agent() {
        assert_eq!(SUGGESTIONS_TIMEOUT_MS, 10_000);
        assert_eq!(SUGGESTIONS_MAX_TOKENS, 800);
    }

    #[test]
    fn suggestions_prompt_mentions_json_and_limits() {
        let p = prompts::suggestions_prompt(Some("en"));
        assert!(p.contains("exactly 3 strings"));
        assert!(p.contains("Max 60 characters"));
        assert!(
            p.contains("NEVER send the {{spotify:...}} template")
                || p.contains("Never use the {{spotify:...}} template")
        );
    }
}
