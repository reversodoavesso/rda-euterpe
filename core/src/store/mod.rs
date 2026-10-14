//! Persistência (contrato C10) — mesmas tabelas, mesmas colunas e **mesmo
//! arquivo** do agente Node, para que o histórico sobreviva à migração.

pub mod cache;
pub mod db;
pub mod history;
pub mod settings;
pub mod snapshots;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;

/// Conexão SQLite serializada. As operações são curtas (KV + histórico), então um
/// `Mutex` sincrono é mais simples e mais rápido que um pool.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Abre (criando se necessário) o banco, aplica o schema e o índice de sessão.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            crate::paths::ensure_dir(parent)?;
        }
        let conn = db::open(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Abre em memória (testes).
    pub fn in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        db::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Acesso serializado à conexão.
    pub fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let guard = self.conn.lock();
        f(&guard)
    }

    /// Igual a [`Self::with`], mas engole erros devolvendo `None` (fail-soft, como
    /// os `try/catch` do `agent/src/db.ts`).
    pub fn try_with<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Option<R> {
        match self.with(f) {
            Ok(v) => Some(v),
            Err(err) => {
                tracing::warn!(error = %err, "operação de store falhou");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_idempotent_and_matches_contract() {
        let store = Store::in_memory().unwrap();
        // Aplicar o schema duas vezes não pode quebrar (§C10: CREATE IF NOT EXISTS).
        store.with(db::migrate).unwrap();
        let tables: Vec<String> = store
            .with(|c| {
                let mut stmt =
                    c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect()
            })
            .unwrap();
        for expected in ["cache", "conversations", "settings", "snapshots"] {
            assert!(
                tables.iter().any(|t| t == expected),
                "tabela {expected} ausente: {tables:?}"
            );
        }
    }

    #[test]
    fn schema_sql_matches_golden_fixture() {
        let golden = include_str!("../../tests/fixtures/schema.sql");
        // Normaliza espaços para comparar a *forma*, não a indentação.
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(norm(db::SCHEMA_SQL), norm(golden));
    }
}
