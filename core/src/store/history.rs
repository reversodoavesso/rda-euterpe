//! Histórico de conversa — paridade com `getHistory`/`saveMessage`/`clearHistory`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub const DEFAULT_HISTORY_LIMIT: u32 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

/// Insere uma mensagem. Falhas são logadas, nunca propagadas (como no Node).
pub fn save_message(conn: &Connection, session_id: &str, role: &str, content: &str) {
    let res = conn.execute(
        "INSERT INTO conversations (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![session_id, role, content, now_ms()],
    );
    if let Err(err) = res {
        tracing::error!(error = %err, "falha ao salvar conversa");
    }
}

/// Últimas `limit` mensagens de usuário/assistente, em ordem cronológica.
pub fn get_history(conn: &Connection, session_id: &str, limit: u32) -> Vec<HistoryMessage> {
    let mut stmt = match conn.prepare(
        "SELECT role, content FROM conversations WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?",
    ) {
        Ok(s) => s,
        Err(err) => {
            tracing::error!(error = %err, "falha ao ler histórico");
            return Vec::new();
        }
    };
    let rows = stmt.query_map(rusqlite::params![session_id, limit], |r| {
        Ok(HistoryMessage {
            role: r.get(0)?,
            content: r.get(1)?,
        })
    });
    match rows {
        Ok(iter) => {
            let mut out: Vec<HistoryMessage> = iter.filter_map(Result::ok).collect();
            out.reverse(); // `ORDER BY id DESC` + reverse = cronológico
            out
        }
        Err(err) => {
            tracing::error!(error = %err, "falha ao ler histórico");
            Vec::new()
        }
    }
}

pub fn clear_history(conn: &Connection, session_id: &str) {
    if let Err(err) = conn.execute(
        "DELETE FROM conversations WHERE session_id = ?",
        [session_id],
    ) {
        tracing::error!(error = %err, "falha ao limpar histórico");
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_is_chronological() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                save_message(c, "s1", "user", "primeiro");
                save_message(c, "s1", "assistant", "segundo");
                save_message(c, "s1", "tool", "ignorado");
                save_message(c, "s2", "user", "outra sessão");
                Ok(())
            })
            .unwrap();
        let hist = store.with(|c| Ok(get_history(c, "s1", 20))).unwrap();
        assert_eq!(
            hist,
            vec![
                HistoryMessage {
                    role: "user".into(),
                    content: "primeiro".into()
                },
                HistoryMessage {
                    role: "assistant".into(),
                    content: "segundo".into()
                },
            ]
        );
    }

    #[test]
    fn limit_keeps_the_most_recent_then_reverses() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                for i in 0..5 {
                    save_message(c, "s", "user", &format!("m{i}"));
                }
                Ok(())
            })
            .unwrap();
        let hist = store.with(|c| Ok(get_history(c, "s", 2))).unwrap();
        assert_eq!(
            hist.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["m3", "m4"]
        );
    }

    #[test]
    fn clear_removes_only_that_session() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                save_message(c, "a", "user", "x");
                save_message(c, "b", "user", "y");
                clear_history(c, "a");
                Ok(())
            })
            .unwrap();
        assert!(store
            .with(|c| Ok(get_history(c, "a", 10)))
            .unwrap()
            .is_empty());
        assert_eq!(
            store.with(|c| Ok(get_history(c, "b", 10))).unwrap().len(),
            1
        );
    }
}
