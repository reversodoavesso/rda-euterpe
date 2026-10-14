//! Adapters de provider. Cada arquivo traduz o canônico (`canonical.rs`) para um
//! wire concreto. Nenhum adapter é escolhido por nome de provider: quem monta é
//! `providers/registry.rs`, a partir de `config::Wire`.

pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai_compat;

use std::sync::OnceLock;
use std::time::Duration;

/// Cliente HTTP dos adapters (keep-alive; timeout por request).
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("euterpe/0.2 (+local)")
            .connect_timeout(Duration::from_secs(10))
            // 429 com `Retry-After` longo: **falhar rápido**, nunca dormir o
            // Retry-After inteiro (regra de portabilidade do PLAN-REFACTOR §F4).
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}
