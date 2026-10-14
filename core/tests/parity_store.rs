//! Paridade do banco (contrato C10): o mesmo arquivo, as mesmas colunas.
//!
//! Se `agent/data/euterpe.db` existir (o banco escrito pelo agente Node), este
//! teste **abre e lê** — a prova de que o histórico sobrevive à migração. É o
//! teste que cobre o risco "better-sqlite3 → rusqlite corromper histórico".
//!
//! Em clone limpo (sem o banco) ele cria um arquivo com o schema do Node e valida
//! o caminho de leitura — continua verde, mas com mensagem explícita.

use euterpe::store::{self, Store};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Caminho do banco legado do agente Node (relativo ao crate `core`).
fn legacy_db() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("raiz do repo")
        .join("agent")
        .join("data")
        .join("euterpe.db")
}

/// Cria um banco com o schema e os dados que o Node produziria.
fn node_shaped_db(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(store::db::SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, id)",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversations (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![
            "sess-node",
            "user",
            "crie uma playlist de foco",
            1_700_000_000_000i64
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversations (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        rusqlite::params!["sess-node", "assistant", "Prontinho!", 1_700_000_000_001i64],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO snapshots (playlist_id, snapshot, created_at) VALUES (?, ?, ?)",
        rusqlite::params![
            "p-legado",
            r#"["spotify:track:a","spotify:track:b"]"#,
            1_700_000_000_002i64
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
        rusqlite::params!["charts:global", "[]", Option::<i64>::None],
    )
    .unwrap();
    conn
}

#[test]
fn schema_sql_matches_the_node_fixture_byte_for_byte_shape() {
    let golden = include_str!("fixtures/schema.sql");
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    assert_eq!(norm(store::db::SCHEMA_SQL), norm(golden));
}

#[test]
fn reads_a_database_written_in_the_node_shape() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("euterpe.db");
    {
        let conn = node_shaped_db(&path);
        drop(conn);
    }

    let store = Store::open(&path).expect("abrir o banco do Node");
    let history = store
        .with(|c| Ok(store::history::get_history(c, "sess-node", 20)))
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].role, "user");
    assert_eq!(history[1].content, "Prontinho!");

    let snapshot = store
        .with(|c| Ok(store::snapshots::get_latest_snapshot(c, "p-legado")))
        .unwrap();
    assert_eq!(
        snapshot,
        Some(vec![
            "spotify:track:a".to_string(),
            "spotify:track:b".to_string()
        ])
    );

    let cached = store
        .with(|c| Ok(store::cache::get_cache(c, "charts:global")))
        .unwrap();
    assert_eq!(cached.as_deref(), Some("[]"));
}

#[test]
fn migration_adds_session_id_to_a_legacy_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    {
        // Tabela no formato *pré* session_id (como o Node migra em db.ts).
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (role, content, created_at) VALUES ('user', 'antigo', 1)",
            [],
        )
        .unwrap();
    }
    let conn = store::db::open(&path).expect("migrar");
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(conversations)")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert!(
        columns.contains(&"session_id".to_string()),
        "colunas: {columns:?}"
    );
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "a migração não pode perder dados");
}

#[test]
fn opens_the_real_legacy_database_when_present() {
    let path = legacy_db();
    if !path.exists() {
        eprintln!(
            "[parity_store] banco legado do Node ausente em {} — pulando a prova de migração real \
             (rode o mod no Spotify para gerá-lo)",
            path.display()
        );
        return;
    }
    let store = Store::open(&path).expect("abrir o banco real do agente Node");
    let sessions: Vec<String> = store
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT DISTINCT session_id FROM conversations WHERE session_id IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.filter_map(Result::ok).collect::<Vec<String>>())
        })
        .unwrap();
    eprintln!(
        "[parity_store] banco legado legível: {} sessões ({})",
        sessions.len(),
        sessions.join(", ")
    );
    // O que importa: o arquivo do Node abre com o schema do Rust sem erro.
    let total: i64 = store
        .with(|c| c.query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0)))
        .unwrap();
    assert!(total >= 0);
}
