//! Autostart e `--ensure` (Fase 5).
//!
//! D2: se o renderer do Spotify expõe Node, a extensão pode dar spawn no daemon
//! (com guarda de porta); senão, usamos um atalho na pasta `Startup` do usuário e
//! o próprio daemon é idempotente via `euterpe --ensure`.

use std::path::PathBuf;

/// Nome do atalho criado na pasta de inicialização.
pub const SHORTCUT_NAME: &str = "Euterpe.lnk";

/// Caminho da pasta `Startup` do usuário (Windows) ou `~/.config/autostart`.
pub fn startup_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return Some(
                PathBuf::from(appdata)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Startup"),
            );
        }
        None
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".config/autostart"))
    }
}

/// Alvo do atalho: o executável atual com `serve`.
pub fn exe_path() -> anyhow::Result<PathBuf> {
    Ok(std::env::current_exe()?)
}

/// Cria (ou recria) o atalho de inicialização.
///
/// Usa PowerShell/WScript para gerar um `.lnk` — sem dependência de crate
/// `windows`. Idempotente: sobrescreve.
pub fn install_startup() -> anyhow::Result<PathBuf> {
    let dir = startup_dir().ok_or_else(|| anyhow::anyhow!("startup_dir_unavailable"))?;
    std::fs::create_dir_all(&dir)?;
    let exe = exe_path()?;
    let target = dir.join(SHORTCUT_NAME);

    #[cfg(windows)]
    {
        let script = format!(
            "$ws = New-Object -ComObject WScript.Shell; \
             $s = $ws.CreateShortcut('{}'); \
             $s.TargetPath = '{}'; \
             $s.Arguments = 'serve'; \
             $s.WorkingDirectory = '{}'; \
             $s.Save()",
            target.display(),
            exe.display(),
            exe.parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()?;
        if !status.success() {
            anyhow::bail!("startup_shortcut_failed");
        }
        tracing::info!(path = %target.display(), "atalho de inicialização criado");
        Ok(target)
    }
    #[cfg(not(windows))]
    {
        let desktop = dir.join("euterpe.desktop");
        let body = format!(
            "[Desktop Entry]\nType=Application\nName=Euterpe\nExec={} serve\nTerminal=false\n",
            exe.display()
        );
        std::fs::write(&desktop, body)?;
        Ok(desktop)
    }
}

/// Remove o atalho de inicialização (usado por `euterpe install-startup --remove`).
pub fn uninstall_startup() -> anyhow::Result<Option<PathBuf>> {
    let Some(dir) = startup_dir() else {
        return Ok(None);
    };
    let target = dir.join(if cfg!(windows) {
        SHORTCUT_NAME
    } else {
        "euterpe.desktop"
    });
    if target.exists() {
        std::fs::remove_file(&target)?;
        return Ok(Some(target));
    }
    Ok(None)
}

/// `GET /health` e verifica quem responde. `true` só quando é o Euterpe
/// (compara `app:"euterpe"`), não qualquer coisa na porta.
pub async fn probe_health(host: &str, port: u16) -> bool {
    let url = format!("http://{host}:{port}/health");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(res) if res.status().is_success() => match res.json::<serde_json::Value>().await {
            Ok(body) => body.get("app").and_then(|v| v.as_str()) == Some("euterpe"),
            Err(_) => false,
        },
        _ => false,
    }
}

/// Porta já ocupada (bind falharia)? Usado pela guarda de porta do autostart.
pub fn port_is_busy(host: &str, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    let addr = format!("{host}:{port}");
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sock) = addrs.next() else {
        return false;
    };
    std::net::TcpListener::bind(sock).is_err()
}

/// Migração one-time do banco do agente Node para o diretório de dados do daemon.
/// Idempotente: não sobrescreve um banco já existente.
pub fn migrate_legacy_db(legacy: &std::path::Path) -> anyhow::Result<bool> {
    let target = crate::paths::db_path();
    if target.exists() || !legacy.exists() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    std::fs::copy(legacy, &target)?;
    tracing::info!(from = %legacy.display(), to = %target.display(), "banco migrado do agente Node");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_probe_detects_a_listening_socket() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_is_busy("127.0.0.1", port));
        drop(listener);
    }

    #[test]
    fn migration_is_idempotent_and_non_destructive() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy.db");
        std::fs::write(&legacy, b"legacy").unwrap();
        let target = dir.path().join("target.db");

        // Simula o destino já existente: não pode sobrescrever.
        std::fs::write(&target, b"keep").unwrap();
        assert!(!migrate_legacy_db_into(&legacy, &target).unwrap());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }

    /// Variante de `migrate_legacy_db` com destino explícito (testável).
    fn migrate_legacy_db_into(
        legacy: &std::path::Path,
        target: &std::path::Path,
    ) -> anyhow::Result<bool> {
        if target.exists() || !legacy.exists() {
            return Ok(false);
        }
        if let Some(parent) = target.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        std::fs::copy(legacy, target)?;
        Ok(true)
    }

    #[tokio::test]
    async fn health_probe_requires_app_euterpe() {
        // Sem servidor: false (não pode entrar em pânico).
        assert!(!probe_health("127.0.0.1", 1).await);
    }
}
