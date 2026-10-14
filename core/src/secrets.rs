//! Segredos: `ws-secret` do bridge e chaves de API dos providers.
//!
//! `PLAN-REFACTOR.md` §F4 pede "keyring Windows + fallback arquivo com ACL".
//! Não há `keyring` aqui (evita puxar a árvore `windows-sys`) — ver
//! `core/README.md` §Desvios. O que existe:
//!
//!  - `ws-secret` em arquivo, com permissões restritas (ACL via `icacls` no
//!    Windows, `0o600` no resto), **idêntico** ao que o agente Node grava → a
//!    extensão não percebe a troca de daemon.
//!  - `secrets.json` (mesmo tratamento) com `{ "<provider-id>": "<api-key>" }`.
//!  - Fallback por variável de ambiente, que ganha precedência zero: o arquivo
//!    manda, o env só preenche o que falta.
//!
//! Nenhuma chave é jamais devolvida por HTTP: as rotas só expõem `has_key`.

use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{config::Wire, paths};

static SECRETS_LOCK: Mutex<()> = Mutex::new(());

/// Nome da variável de ambiente *legada* por provider.
fn env_keys(provider: &str) -> &'static [&'static str] {
    match provider {
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "gemini" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "groq" => &["GROQ_API_KEY"],
        "openrouter" => &["OPENROUTER_API_KEY"],
        "together" => &["TOGETHER_API_KEY"],
        "xai" => &["XAI_API_KEY"],
        "mistral" => &["MISTRAL_API_KEY"],
        "brave" => &["BRAVE_API_KEY"],
        "tavily" => &["TAVILY_API_KEY"],
        "lastfm" => &["LASTFM_API_KEY"],
        "tastedive" => &["TASTEDIVE_API_KEY"],
        _ => &[],
    }
}

fn normalize_env_name(provider: &str) -> String {
    let upper = provider.replace('-', "_").to_ascii_uppercase();
    format!("EUTERPE_{upper}_API_KEY")
}

fn load_file(path: &Path) -> BTreeMap<String, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or_default(),
        _ => BTreeMap::new(),
    }
}

fn save_file(path: &Path, map: &BTreeMap<String, String>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    let body = serde_json::to_string_pretty(map)?;
    // Escrita atômica: tmp + rename (senão um crash deixa o arquivo pela metade).
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.write_all(b"\n")?;
        f.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    restrict(path)?;
    Ok(())
}

/// Restringe o acesso ao arquivo. Melhor esforço — nunca falha o boot.
pub fn restrict(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| ".".to_string());
        let status = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("{user}:(R,W)"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            _ => {
                tracing::warn!(path = %path.display(), "icacls indisponível: ACL não restringida");
                Ok(())
            }
        }
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Segredo do handshake WS. Espelha `loadSecret()` de `agent/src/config.ts`.
pub fn ws_secret() -> anyhow::Result<String> {
    if let Ok(v) = std::env::var("WS_SECRET") {
        if !v.trim().is_empty() {
            return Ok(v.trim().to_string());
        }
    }
    let _guard = SECRETS_LOCK.lock();
    let file = paths::ws_secret_file();
    if let Ok(raw) = std::fs::read_to_string(&file) {
        let trimmed = raw.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if let Some(parent) = file.parent() {
        paths::ensure_dir(parent)?;
    }
    let mut bytes = [0u8; 32];
    rand::Rng::fill(&mut rand::thread_rng(), &mut bytes);
    let secret = hex(&bytes);
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&file)?;
    f.write_all(secret.as_bytes())?;
    f.flush()?;
    drop(f);
    restrict(&file)?;
    Ok(secret)
}

/// Chave de API do provider (`None` quando não configurada).
pub fn provider_key(provider: &str) -> Option<String> {
    {
        let _guard = SECRETS_LOCK.lock();
        let map = load_file(&paths::secrets_file());
        if let Some(v) = map.get(provider) {
            if !v.trim().is_empty() {
                return Some(v.clone());
            }
        }
    }
    if let Ok(v) = std::env::var(normalize_env_name(provider)) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    for key in env_keys(provider) {
        if let Ok(v) = std::env::var(key) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

pub fn has_provider_key(provider: &str) -> bool {
    provider_key(provider).is_some()
}

pub fn set_provider_key(provider: &str, key: &str) -> anyhow::Result<()> {
    let _guard = SECRETS_LOCK.lock();
    let path = paths::secrets_file();
    let mut map = load_file(&path);
    let trimmed = key.trim();
    if trimmed.is_empty() {
        map.remove(provider);
    } else {
        map.insert(provider.to_string(), trimmed.to_string());
    }
    save_file(&path, &map)
}

pub fn delete_provider_key(provider: &str) -> anyhow::Result<()> {
    let _guard = SECRETS_LOCK.lock();
    let path = paths::secrets_file();
    let mut map = load_file(&path);
    map.remove(provider);
    save_file(&path, &map)
}

/// Chave de busca na web, respeitando o backend escolhido.
pub fn web_search_key(backend: &str) -> Option<String> {
    provider_key(backend)
}

/// Providers que *não* precisam de chave (locais).
pub fn key_optional(wire: Wire) -> bool {
    matches!(wire, Wire::Ollama)
}

/// Caminho do arquivo de segredos (para diagnóstico).
///
/// A localização é o diretório de dados global (`%APPDATA%\euterpe` ou
/// `EUTERPE_DATA_DIR`) de propósito: uma chave de API não deve depender de qual
/// banco o processo abriu. Os testes de integração que exercitam escrita de chave
/// limpam atrás de si.
pub fn secrets_path() -> PathBuf {
    paths::secrets_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_lowercase_and_fixed_width() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn env_name_normalization() {
        assert_eq!(
            normalize_env_name("openai-compat"),
            "EUTERPE_OPENAI_COMPAT_API_KEY"
        );
    }

    #[test]
    fn local_wires_do_not_need_keys() {
        assert!(key_optional(Wire::Ollama));
        assert!(!key_optional(Wire::Anthropic));
    }
}
