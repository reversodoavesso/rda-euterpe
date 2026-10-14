//! Logging do daemon: `tracing` → arquivo rotativo simples + stderr, e os logs
//! de sessão em JSONL (contrato C5 `/sessions`), **byte-compatíveis** com
//! `agent/src/logging.ts` para que a UI e a extensão não percebam a troca.

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// `MakeWriter` simples que abre o arquivo em modo append a cada evento.
/// Sem dependência extra (`tracing-appender`) e sem thread de fundo: o volume do
/// daemon é baixo e a correção importa mais que o último microssegundo.
#[derive(Clone)]
pub struct FileWriter {
    path: PathBuf,
}

impl FileWriter {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

pub struct FileHandle(Option<std::fs::File>);

impl Write for FileHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.0.as_mut() {
            Some(f) => f.write(buf),
            None => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.0.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileWriter {
    type Writer = FileHandle;
    fn make_writer(&'a self) -> Self::Writer {
        if let Some(parent) = self.path.parent() {
            let _ = crate::paths::ensure_dir(parent);
        }
        FileHandle(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .ok(),
        )
    }
}

/// Inicializa o subscriber global. Idempotente (ignora o segundo `init`).
pub fn init(debug: bool, log_path: &Path) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = match std::env::var("RUST_LOG") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => {
            if debug {
                "euterpe=debug,tower_http=debug,info".to_string()
            } else {
                "euterpe=info,warn".to_string()
            }
        }
    };
    let env_filter = tracing_subscriber::EnvFilter::try_new(&filter)
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(io::stderr);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(FileWriter::new(log_path));

    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init();
}

/* ------------------------------------------------------------------ sessões */

/// Sanitiza o id da sessão como `sanitize()` em `agent/src/logging.ts`.
pub fn sanitize_session(id: &str) -> String {
    let mut out: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if out.is_empty() {
        out.push_str("session");
    }
    out
}

fn session_file(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{}.log", sanitize_session(session_id)))
}

/// Append de um evento JSONL `{ts, session, event, payload?}`.
pub fn log_session(dir: &Path, session_id: &str, event: &str, payload: Option<serde_json::Value>) {
    if let Err(err) = try_log_session(dir, session_id, event, payload) {
        tracing::warn!(error = %err, "falha ao escrever log de sessão");
    }
}

fn try_log_session(
    dir: &Path,
    session_id: &str,
    event: &str,
    payload: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    crate::paths::ensure_dir(dir)?;
    let mut line = serde_json::Map::new();
    line.insert("ts".into(), serde_json::Value::String(now_iso()));
    line.insert(
        "session".into(),
        serde_json::Value::String(session_id.to_string()),
    );
    line.insert("event".into(), serde_json::Value::String(event.to_string()));
    if let Some(p) = payload {
        line.insert("payload".into(), p);
    }
    let body = serde_json::to_string(&serde_json::Value::Object(line))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(session_file(dir, session_id))?;
    f.write_all(body.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

/// Timestamp ISO-8601 com milissegundos em UTC (`Date.toISOString()`).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub file: String,
    pub size: u64,
    pub modified: String,
    pub events: u64,
}

/// Lista as sessões, mais recentes primeiro (contrato `/sessions`).
pub fn list_sessions(dir: &Path) -> Vec<SessionSummary> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<SessionSummary> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let path = entry.path();
        let events = std::fs::read_to_string(&path)
            .map(|raw| raw.lines().filter(|l| !l.trim().is_empty()).count() as u64)
            .unwrap_or(0);
        let modified = meta
            .modified()
            .ok()
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(now_iso);
        out.push(SessionSummary {
            id: name.trim_end_matches(".log").to_string(),
            file: name,
            size: meta.len(),
            modified,
            events,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// Lê os eventos de uma sessão (contrato `/sessions/:id`).
pub fn read_session(dir: &Path, session_id: &str) -> Vec<serde_json::Value> {
    let path = session_file(dir, session_id);
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(
            |line| match serde_json::from_str::<serde_json::Value>(line) {
                Ok(v) => v,
                Err(_) => serde_json::json!({
                    "ts": "",
                    "session": session_id,
                    "event": "unparseable",
                    "payload": line,
                }),
            },
        )
        .collect()
}

/// `logToolCall()` de `agent/src/logging.ts` — mesma forma de payload.
pub fn log_tool_call(
    dir: &Path,
    session_id: &str,
    name: &str,
    args: &serde_json::Value,
    ok: Option<bool>,
    code: Option<&str>,
    duration_ms: Option<u128>,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("name".into(), serde_json::Value::String(name.to_string()));
    payload.insert(
        "args".into(),
        if args.is_object() {
            args.clone()
        } else {
            serde_json::Value::String(args.to_string())
        },
    );
    if let Some(ok) = ok {
        payload.insert("ok".into(), serde_json::Value::Bool(ok));
    }
    if let Some(code) = code {
        payload.insert("code".into(), serde_json::Value::String(code.to_string()));
    }
    if let Some(ms) = duration_ms {
        payload.insert(
            "duration_ms".into(),
            serde_json::Value::Number((ms as u64).into()),
        );
    }
    log_session(
        dir,
        session_id,
        "tool.call",
        Some(serde_json::Value::Object(payload)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_matches_node_rules() {
        assert_eq!(sanitize_session("sess-1.A"), "sess-1_A");
        assert_eq!(sanitize_session("///"), "___");
        assert_eq!(sanitize_session(""), "session");
        assert_eq!(sanitize_session(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn session_round_trip_and_listing() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        log_session(
            d,
            "s1",
            "session.start",
            Some(serde_json::json!({"text":"oi"})),
        );
        log_session(d, "s1", "session.end", None);
        let events = read_session(d, "s1");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "session.start");
        assert_eq!(events[0]["payload"]["text"], "oi");
        assert!(events[0]["ts"].as_str().unwrap().ends_with('Z'));
        let list = list_sessions(d);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[0].events, 2);
    }

    #[test]
    fn missing_session_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_session(dir.path(), "nope").is_empty());
        assert!(list_sessions(&dir.path().join("does-not-exist")).is_empty());
    }
}
