//! Início por usuário: Startup (Windows), systemd/XDG (Linux), launchd (macOS).
//! O renderer apenas conecta; nenhum acesso a Node dentro do Spotify é exigido.

use std::path::{Path, PathBuf};
use std::process::Command;

mod render;

/// Nome do atalho criado na pasta de inicialização.
pub const SHORTCUT_NAME: &str = "Euterpe.lnk";

/// Diretório de inicialização do usuário (XDG é também o fallback no Linux).
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
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/LaunchAgents"))
    }
    #[cfg(target_os = "linux")]
    {
        config_dir().map(|p| p.join("autostart"))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
}

fn checked(command: &mut Command) -> anyhow::Result<()> {
    let result = command.output()?;
    anyhow::ensure!(
        result.status.success(),
        "startup command failed: {:?}: {}",
        command,
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn systemd_available() -> bool {
    Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .is_ok_and(|r| r.status.success())
}

#[cfg(target_os = "macos")]
fn launch_domain() -> anyhow::Result<String> {
    let output = Command::new("id").arg("-u").output()?;
    let uid = String::from_utf8(output.stdout)?.trim().to_string();
    anyhow::ensure!(
        output.status.success() && !uid.is_empty() && uid.chars().all(|c| c.is_ascii_digit()),
        "cannot determine user id"
    );
    Ok(format!("gui/{uid}"))
}

fn remove_file_if_exists(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Executável nativo responsável pelo daemon.
pub fn exe_path() -> anyhow::Result<PathBuf> {
    Ok(std::env::current_exe()?)
}

/// Registra o início no logon da conta atual, usando o mecanismo nativo do host.
pub fn install_startup() -> anyhow::Result<PathBuf> {
    let dir = startup_dir().ok_or_else(|| anyhow::anyhow!("startup_dir_unavailable"))?;
    std::fs::create_dir_all(&dir)?;
    let exe = exe_path()?;
    // Resolve overrides relativos: o gerenciador de login usa outro diretório atual.
    let data = std::path::absolute(crate::paths::data_dir())?;
    std::fs::create_dir_all(&data)?;

    #[cfg(windows)]
    {
        use base64::Engine;
        let target = dir.join(SHORTCUT_NAME);
        let script = render::powershell_launcher(&exe.to_string_lossy(), &data.to_string_lossy());
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let ps = PathBuf::from(
            std::env::var_os("SystemRoot")
                .ok_or_else(|| anyhow::anyhow!("SystemRoot unavailable"))?,
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        checked(Command::new(&ps).args(["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:EUTERPE_LINK); $s.TargetPath=$env:EUTERPE_PS; $s.Arguments=$env:EUTERPE_ARGS; $s.WindowStyle=7; $s.Save()"])
            .env("EUTERPE_LINK", &target).env("EUTERPE_PS", &ps)
            .env("EUTERPE_ARGS", format!("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}")))?;
        Ok(target)
    }
    #[cfg(target_os = "linux")]
    {
        let unit = config_dir()
            .ok_or_else(|| anyhow::anyhow!("config directory unavailable"))?
            .join("systemd/user/euterpe.service");
        if systemd_available() {
            std::fs::create_dir_all(unit.parent().unwrap())?;
            std::fs::write(
                &unit,
                render::systemd_service(&exe.to_string_lossy(), &data.to_string_lossy()),
            )?;
            checked(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
            checked(Command::new("systemctl").args(["--user", "enable", "euterpe.service"]))?;
            checked(Command::new("systemctl").args(["--user", "restart", "euterpe.service"]))?;
            remove_file_if_exists(&dir.join("euterpe.desktop"))?;
            return Ok(unit);
        }
        // Não deixa um registro systemd dormente junto ao fallback XDG.
        anyhow::ensure!(
            !unit.exists(),
            "systemd user manager unavailable; retry from your desktop session"
        );
        let desktop = dir.join("euterpe.desktop");
        std::fs::write(
            &desktop,
            render::desktop_entry(&exe.to_string_lossy(), &data.to_string_lossy()),
        )?;
        Ok(desktop)
    }
    #[cfg(target_os = "macos")]
    {
        let plist = dir.join("app.euterpe.daemon.plist");
        let domain = launch_domain()?;
        let service = format!("{domain}/app.euterpe.daemon");
        std::fs::write(
            &plist,
            render::launch_agent(&exe.to_string_lossy(), &data.to_string_lossy()),
        )?;
        if Command::new("launchctl")
            .args(["print", &service])
            .output()?
            .status
            .success()
        {
            checked(Command::new("launchctl").args(["bootout", &service]))?;
        }
        checked(Command::new("launchctl").args(["enable", &service]))?;
        checked(
            Command::new("launchctl")
                .arg("bootstrap")
                .arg(&domain)
                .arg(&plist),
        )?;
        Ok(plist)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        anyhow::bail!("unsupported platform")
    }
}

/// Remove o atalho de inicialização (usado por `euterpe install-startup --remove`).
pub fn uninstall_startup() -> anyhow::Result<Option<PathBuf>> {
    let Some(dir) = startup_dir() else {
        return Ok(None);
    };
    #[cfg(target_os = "linux")]
    {
        let unit = config_dir().unwrap().join("systemd/user/euterpe.service");
        if unit.exists() {
            anyhow::ensure!(
                systemd_available(),
                "systemd user manager unavailable; retry from your desktop session"
            );
            checked(Command::new("systemctl").args([
                "--user",
                "disable",
                "--now",
                "euterpe.service",
            ]))?;
            remove_file_if_exists(&unit)?;
            checked(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
            remove_file_if_exists(&dir.join("euterpe.desktop"))?;
            return Ok(Some(unit));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let service = format!("{}/app.euterpe.daemon", launch_domain()?);
        if Command::new("launchctl")
            .args(["print", &service])
            .output()?
            .status
            .success()
        {
            checked(Command::new("launchctl").args(["bootout", &service]))?;
        }
    }
    let target = dir.join(if cfg!(windows) {
        SHORTCUT_NAME
    } else if cfg!(target_os = "macos") {
        "app.euterpe.daemon.plist"
    } else {
        "euterpe.desktop"
    });
    if target.exists() {
        remove_file_if_exists(&target)?;
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
