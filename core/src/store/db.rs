//! Schema do banco — espelho literal de `agent/src/db.ts` (contrato C10).

use rusqlite::Connection;
use std::path::Path;

/// Texto do schema. O teste em `store/mod.rs` compara com
/// `core/tests/fixtures/schema.sql` (gerado por `agent/tools/export-goldens.mjs`).
pub const SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  "#;

const INDEX_SQL: &str =
    "CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, id)";

const DIFFS_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS playlist_diffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      parent_diff_id INTEGER,
      created_at INTEGER NOT NULL,
      hash TEXT NOT NULL,
      added_count INTEGER NOT NULL,
      removed_count INTEGER NOT NULL,
      reordered INTEGER NOT NULL,
      delta TEXT NOT NULL,
      FOREIGN KEY (parent_diff_id) REFERENCES playlist_diffs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_diffs_pid ON playlist_diffs(playlist_id, id);
"#;

/// Aplica schema + migrações aditivas (idempotente).
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    // Migração para bancos criados antes da coluna `session_id` existir.
    let has_session_id: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(conversations)")?;
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();
        names.iter().any(|n| n == "session_id")
    };
    if !has_session_id {
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN session_id TEXT")?;
    }
    conn.execute_batch(INDEX_SQL)?;
    conn.execute_batch(DIFFS_SQL)?;
    Ok(())
}

/// Abre o banco em modo WAL (como o Node) e aplica as migrações.
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&conn)?;
    Ok(conn)
}
