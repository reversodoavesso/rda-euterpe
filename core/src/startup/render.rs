//! Renderizadores puros: testáveis em qualquer host, sem registrar autostart.
#![allow(dead_code)] // Cada host usa um subconjunto dos formatos.

pub fn powershell_launcher(exe: &str, data: &str) -> String {
    let literal = |s: &str| format!("'{}'", s.replace('\'', "''"));
    format!("$ErrorActionPreference='Stop'; $env:EUTERPE_DATA_DIR={}; & {} --ensure; exit $LASTEXITCODE",
        literal(data), literal(exe))
}

fn systemd_quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('%', "%%")
    )
}

pub fn systemd_service(exe: &str, data: &str) -> String {
    format!("[Unit]\nDescription=Euterpe Spotify companion\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart={} serve\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(exe).replace('$', "$$"), systemd_quote(&format!("EUTERPE_DATA_DIR={data}")))
}

fn desktop_quote(s: &str) -> String {
    let mut result = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => result.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                result.push_str("\\\\");
                result.push(c);
            }
            '%' => result.push_str("%%"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            _ => result.push(c),
        }
    }
    result.push('"');
    result
}

pub fn desktop_entry(exe: &str, data: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName=Euterpe\nExec=/usr/bin/env {} {} --ensure\nTerminal=false\n",
        desktop_quote(&format!("EUTERPE_DATA_DIR={data}")), desktop_quote(exe))
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn launch_agent(exe: &str, data: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>app.euterpe.daemon</string>\n<key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>\n<key>EnvironmentVariables</key><dict><key>EUTERPE_DATA_DIR</key><string>{}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n", xml(exe), xml(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_cannot_inject_commands_or_configuration() {
        assert!(powershell_launcher("C:\\O'Brien\\euterpe.exe", "C:\\$data")
            .contains("& 'C:\\O''Brien\\euterpe.exe' --ensure"));
        let unit = systemd_service("/a %h/$bin/euterpe", "/a\nInjected=yes");
        assert!(unit.contains("ExecStart=\"/a %%h/$$bin/euterpe\" serve"));
        assert!(unit.contains("/a\\nInjected=yes"));
        assert!(!unit.contains("\nInjected=yes"));
        let desktop = desktop_entry("/a b/$x`y\\z%/euterpe", "/data space");
        assert!(desktop.contains("\"EUTERPE_DATA_DIR=/data space\""));
        assert!(desktop.contains("\\\\$x\\\\`y\\\\\\\\z%%"));
        let plist = launch_agent("/a & <b>/euterpe", "/Users/João's data");
        assert!(plist.contains("/a &amp; &lt;b&gt;/euterpe"));
        assert!(plist.contains("João&apos;s data"));
    }

    #[test]
    fn supervised_services_stay_in_foreground_and_restart_only_on_failure() {
        let unit = systemd_service("/euterpe", "/data");
        assert!(unit.contains("Restart=on-failure"));
        assert!(!unit.contains("--ensure"));
        let plist = launch_agent("/euterpe", "/data");
        assert!(plist.contains("<string>serve</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key><false/>"));
        assert!(desktop_entry("/euterpe", "/data").contains("--ensure"));
    }
}
