//! Resolução de diretórios de dados (PLAN-REFACTOR.md §2.2).
//!
//! Regras:
//!  - `EUTERPE_DATA_DIR` manda em tudo (usado pelos testes de integração e pelo dev).
//!  - `EUTERPE_PORTABLE=1` → dados ao lado do executável (instalação portátil).
//!  - default → `%APPDATA%\euterpe` (Windows) / `$XDG_DATA_HOME/euterpe`.
//!
//! O layout interno é o mesmo do agente Node (`data/sessions`, `data/probes`,
//! `euterpe.db`, `ws-secret`) para que a migração one-time do `install.mjs` seja
//! apenas um `copy`.

use std::path::{Path, PathBuf};

/// Diretório raiz de dados do daemon.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = non_empty_env("EUTERPE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if portable() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                return parent.join("data");
            }
        }
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = non_empty_env("APPDATA") {
            return PathBuf::from(appdata).join("euterpe");
        }
    }
    if let Some(xdg) = non_empty_env("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join("euterpe");
    }
    if let Some(home) = non_empty_env("HOME") {
        return PathBuf::from(home).join(".local/share/euterpe");
    }
    PathBuf::from("data")
}

/// Instalação portátil: tudo ao lado do executável.
pub fn portable() -> bool {
    matches!(
        non_empty_env("EUTERPE_PORTABLE").as_deref(),
        Some("1") | Some("true") | Some("yes")
    )
}

pub fn sessions_dir() -> PathBuf {
    data_dir().join("sessions")
}

pub fn probes_dir() -> PathBuf {
    data_dir().join("probes")
}

pub fn db_path() -> PathBuf {
    data_dir().join("euterpe.db")
}

pub fn ws_secret_file() -> PathBuf {
    data_dir().join("ws-secret")
}

pub fn secrets_file() -> PathBuf {
    data_dir().join("secrets.json")
}

pub fn config_file() -> PathBuf {
    data_dir().join("config.json")
}

pub fn models_cache_file() -> PathBuf {
    data_dir().join("models-cache.json")
}

pub fn log_file() -> PathBuf {
    data_dir().join("euterpe.log")
}

/// Garante que o diretório existe (idempotente).
pub fn ensure_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

fn non_empty_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_respects_env_override() {
        // Serializado por ser o único teste que toca env global de diretório.
        let previous = std::env::var("EUTERPE_DATA_DIR").ok();
        std::env::set_var("EUTERPE_DATA_DIR", "C:/tmp/euterpe-test-dir");
        assert_eq!(data_dir(), PathBuf::from("C:/tmp/euterpe-test-dir"));
        assert_eq!(
            db_path(),
            PathBuf::from("C:/tmp/euterpe-test-dir/euterpe.db")
        );
        match previous {
            Some(v) => std::env::set_var("EUTERPE_DATA_DIR", v),
            None => std::env::remove_var("EUTERPE_DATA_DIR"),
        }
    }
}
