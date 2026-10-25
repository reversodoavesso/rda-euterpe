//! Transporte privado entre o daemon e um serviço de ferramentas headless.
//! Não recebe tokens Spotify e nunca repete automaticamente uma escrita.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::{protocol::ToolResult, tools::catalog};

pub struct Headless {
    base: reqwest::Url,
    client: reqwest::Client,
}

#[derive(Debug, thiserror::Error)]
#[error("headless authentication service unavailable")]
pub struct AuthUnavailable;

/// Whitelist dos campos de pareamento. Credenciais/tokens nunca atravessam a rota.
#[derive(Serialize, Deserialize)]
pub struct AuthStatus {
    pub status: String,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Headless {
    pub async fn auth(&self, action: &str) -> Result<(u16, AuthStatus), AuthUnavailable> {
        let (method, path) = match action {
            "status" => (reqwest::Method::GET, "auth"),
            "start" => (reqwest::Method::POST, "auth/start"),
            "cancel" => (reqwest::Method::DELETE, "auth"),
            _ => return Err(AuthUnavailable),
        };
        let url = self.base.join(path).map_err(|_| AuthUnavailable)?;
        let response = self
            .client
            .request(method, url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| AuthUnavailable)?;
        let status = response.status().as_u16();
        let body = response
            .json::<AuthStatus>()
            .await
            .map_err(|_| AuthUnavailable)?;
        Ok((status, body))
    }
    pub fn new(base: &str) -> anyhow::Result<Self> {
        Self::with_secret(base, "")
    }

    pub fn with_secret(base: &str, secret: &str) -> anyhow::Result<Self> {
        let base = reqwest::Url::parse(&format!("{}/", base.trim_end_matches('/')))?;
        anyhow::ensure!(
            matches!(base.scheme(), "http" | "https"),
            "headless URL must use HTTP(S)"
        );
        anyhow::ensure!(
            base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "headless URL cannot contain credentials, query or fragment"
        );
        let mut headers = reqwest::header::HeaderMap::new();
        if !secret.is_empty() {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {secret}").parse()?,
            );
        }
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Self { base, client })
    }

    pub async fn call(&self, name: &str, args: Value, timeout_ms: u64) -> ToolResult {
        let url = self.base.join("tools/call").expect("validated base URL");
        let response = self
            .client
            .post(url)
            .timeout(Duration::from_millis(timeout_ms))
            .json(&json!({"name": name, "args": args}))
            .send()
            .await;
        // Uma conexão perdida pode ocorrer após o commit no Spotify. Nunca
        // afirmar que a escrita falhou, nem sugerir repetir sem leitura.
        let uncertain = || {
            ToolResult::err(if catalog::is_mutating(name) {
                "headless_outcome_unknown"
            } else {
                "headless_unavailable"
            })
        };
        let response = match response {
            Ok(r) if r.status().is_success() => r,
            _ => return uncertain(),
        };
        response
            .json::<ToolResult>()
            .await
            .unwrap_or_else(|_| uncertain())
    }
}
