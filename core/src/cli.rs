//! CLI do daemon.
//!
//! ```text
//! euterpe serve              # sobe o daemon (bridge WS + HTTP + MCP)
//! euterpe --ensure           # garante um daemon vivo (idempotente, exit 0)
//! euterpe mcp --stdio        # shim MCP por stdio (stdout = só protocolo)
//! euterpe install-startup    # atalho na pasta Startup (D2, plano B)
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
  euterpe install-startup       Instala o atalho de inicialização
  euterpe install-startup --remove
  euterpe version

VARIÁVEIS:
  PORT / HOST                   Endereço do bridge (default 127.0.0.1:8337)
  EUTERPE_DATA_DIR              Diretório de dados (default %APPDATA%\\euterpe)
  EUTERPE_PORTABLE=1            Dados ao lado do executável
  CHAT_UPSTREAM                 Ex.: ws://127.0.0.1:8338/ws (Fase 2 / D6)
  EUTERPE_MUTATION_POLICY       allow | confirm | deny
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
                println!("atalho criado: {}", path.display());
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
                crate::mcp::stdio::run_proxy(&cfg.host, cfg.port, None).await
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
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("encerrando (ctrl-c)");
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
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn()?;
    println!("euterpe iniciado (pid {})", child.id());

    // A primeira chamada após idle sobe o motor: damos até 15 s.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if crate::startup::probe_health(&cfg.host, cfg.port).await {
            println!("euterpe pronto em {}:{}", cfg.host, cfg.port);
            return Ok(());
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
