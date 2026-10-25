//! CLI do daemon.
//!
//! ```text
//! euterpe serve              # sobe o daemon (bridge WS + HTTP + MCP)
//! euterpe --ensure           # garante um daemon vivo (idempotente, exit 0)
//! euterpe mcp --stdio        # shim MCP por stdio (stdout = só protocolo)
//! euterpe install-startup    # inicialização nativa no logon do usuário
//! euterpe install-startup --remove
//! euterpe version
//! ```

use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    Serve,
    McpStdio,
    Ensure,
    InstallStartup { remove: bool },
    Version,
    Help,
}

impl Cmd {
    pub fn parse(args: &[String]) -> Self {
        let mut it = args.iter().peekable();
        let first = it.next().map(|s| s.as_str()).unwrap_or("");
        let remove = args.iter().any(|a| a == "--remove");
        match first {
            "" | "serve" => Cmd::Serve,
            "--ensure" | "ensure" => Cmd::Ensure,
            "version" | "--version" | "-v" => Cmd::Version,
            "help" | "--help" | "-h" => Cmd::Help,
            "install-startup" => Cmd::InstallStartup { remove },
            "mcp" => {
                if args.iter().any(|a| a == "--stdio") {
                    Cmd::McpStdio
                } else {
                    Cmd::Help
                }
            }
            _ => Cmd::Help,
        }
    }
}

const HELP: &str = "\
euterpe — daemon do mod Euterpe (bridge WS do Spotify + MCP + chat agentic)

USO:
  euterpe serve                 Sobe o daemon (porta 8337)
  euterpe --ensure              Garante um daemon vivo (exit 0 se já houver)
  euterpe mcp --stdio           Servidor MCP por stdio (proxy para o daemon)
  euterpe install-startup       Registra o início automático por usuário
  euterpe install-startup --remove
  euterpe version

VARIÁVEIS:
  PORT / HOST                   Endereço do bridge (default 127.0.0.1:8337)
  EUTERPE_DATA_DIR              Diretório de dados (default %APPDATA%\\euterpe)
  EUTERPE_PORTABLE=1            Dados ao lado do executável
  CHAT_UPSTREAM                 Ex.: ws://127.0.0.1:8338/ws (Fase 2 / D6)
  EUTERPE_MUTATION_POLICY       allow | confirm | deny
  EUTERPE_HEADLESS_URL          Serviço HTTP de tools (opcional; substitui a extensão)
";

/// Ponto de entrada.
pub async fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = Cmd::parse(&args);
    match cmd {
        Cmd::Help => {
            println!("{HELP}");
            Ok(())
        }
        Cmd::Version => {
            println!("euterpe {}", crate::VERSION);
            Ok(())
        }
        Cmd::InstallStartup { remove } => {
            crate::logging::init(false, &crate::paths::log_file());
            if remove {
                match crate::startup::uninstall_startup()? {
                    Some(path) => println!("atalho removido: {}", path.display()),
                    None => println!("nenhum atalho encontrado"),
                }
            } else {
                let path = crate::startup::install_startup()?;
                println!("início automático registrado: {}", path.display());
            }
            Ok(())
        }
        Cmd::Ensure => {
            crate::logging::init(false, &crate::paths::log_file());
            ensure_running().await
        }
        Cmd::McpStdio => {
            // `stdout` é exclusivo do protocolo: logs só em stderr.
            crate::logging::init(false, &crate::paths::log_file());
            let cfg = crate::config::Config::load()?;
            if crate::startup::probe_health(&cfg.host, cfg.port).await {
                crate::mcp::stdio::run_proxy(&cfg.host, cfg.port, Some(cfg.ws_secret.clone())).await
            } else {
                // Sem daemon: roda o MCP em processo (útil em teste e offline).
                let state = Arc::new(AppState::new(cfg)?);
                crate::mcp::stdio::run_in_process(state).await
            }
        }
        Cmd::Serve => serve().await,
    }
}

async fn serve() -> anyhow::Result<()> {
    let cfg = crate::config::Config::load()?;
    crate::logging::init(cfg.debug, &crate::paths::log_file());

    if crate::startup::port_is_busy(&cfg.host, cfg.port) {
        // Idempotência do autostart: se já existe um Euterpe, não brigamos pela porta.
        if crate::startup::probe_health(&cfg.host, cfg.port).await {
            tracing::info!(port = cfg.port, "já existe um Euterpe nesta porta; saindo");
            return Ok(());
        }
        anyhow::bail!("porta {} já está em uso por outro processo", cfg.port);
    }

    let host = cfg.host.clone();
    let port = cfg.port;
    let data_dir = cfg.data_dir.clone();
    let state = AppState::new(cfg)?;

    let app = crate::http::router(state.clone());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    tracing::info!(
        "{}",
        crate::i18n::t(
            "en",
            "status.agentListening",
            &[("host", &host), ("port", &port.to_string())]
        )
    );
    tracing::info!(dir = %data_dir.display(), "data dir");
    if state.upstream.enabled() {
        tracing::warn!(
            "CHAT_UPSTREAM definido: o chat está sendo espelhado para o agente Node (Fase 2 / D6)"
        );
    }

    let shutdown = async {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term.recv() => {},
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("encerrando daemon");
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

/// `--ensure`: se já houver daemon, sai 0; senão sobe um desanexado e espera o
/// `/health` confirmar (`app:"euterpe"`).
pub async fn ensure_running() -> anyhow::Result<()> {
    let cfg = crate::config::Config::load()?;
    if crate::startup::probe_health(&cfg.host, cfg.port).await {
        println!("euterpe já está rodando em {}:{}", cfg.host, cfg.port);
        return Ok(());
    }
    let exe = crate::startup::exe_path()?;
    #[cfg(windows)]
    {
        // ShellExecute via Start-Process não herda pipes do chamador. Um spawn
        // direto pode manter esses handles abertos mesmo com Stdio::null().
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let ps = std::path::PathBuf::from(
            std::env::var_os("SystemRoot")
                .ok_or_else(|| anyhow::anyhow!("SystemRoot unavailable"))?,
        )
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = std::process::Command::new(ps)
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; (Start-Process -FilePath $env:EUTERPE_DAEMON_EXE -ArgumentList 'serve' -WindowStyle Hidden -PassThru).Id"])
            .env("EUTERPE_DAEMON_EXE", exe)
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "falha ao iniciar daemon: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        println!(
            "euterpe iniciado (pid {})",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }
    #[cfg(unix)]
    let mut child = {
        // A instância permanece viva após o terminal/launcher encerrar.
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new(exe)
            .arg("serve")
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        println!("euterpe iniciado (pid {})", child.id());
        child
    };

    // A primeira chamada após idle sobe o motor: damos até 15 s.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if crate::startup::probe_health(&cfg.host, cfg.port).await {
            println!("euterpe pronto em {}:{}", cfg.host, cfg.port);
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("daemon encerrou antes de ficar pronto ({status}); consulte euterpe.log");
        }
    }
    anyhow::bail!("euterpe não respondeu em {}:{}", cfg.host, cfg.port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_every_command() {
        assert_eq!(Cmd::parse(&args(&[])), Cmd::Serve);
        assert_eq!(Cmd::parse(&args(&["serve"])), Cmd::Serve);
        assert_eq!(Cmd::parse(&args(&["--ensure"])), Cmd::Ensure);
        assert_eq!(Cmd::parse(&args(&["ensure"])), Cmd::Ensure);
        assert_eq!(Cmd::parse(&args(&["mcp", "--stdio"])), Cmd::McpStdio);
        assert_eq!(Cmd::parse(&args(&["mcp"])), Cmd::Help);
        assert_eq!(
            Cmd::parse(&args(&["install-startup"])),
            Cmd::InstallStartup { remove: false }
        );
        assert_eq!(
            Cmd::parse(&args(&["install-startup", "--remove"])),
            Cmd::InstallStartup { remove: true }
        );
        assert_eq!(Cmd::parse(&args(&["version"])), Cmd::Version);
        assert_eq!(Cmd::parse(&args(&["banana"])), Cmd::Help);
    }

    #[test]
    fn help_mentions_every_command() {
        for needle in [
            "serve",
            "--ensure",
            "mcp --stdio",
            "install-startup",
            "CHAT_UPSTREAM",
        ] {
            assert!(HELP.contains(needle), "help sem `{needle}`");
        }
    }
}
