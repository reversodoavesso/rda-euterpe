//! Snapshots de playlist (base do `undo_last_mutation` e do cinto de segurança de
//! D3: **toda** mutação grava snapshot antes de executar).

use rusqlite::Connection;

/// Grava `uris` como snapshot da playlist.
pub fn save_snapshot(conn: &Connection, playlist_id: &str, uris: &[String]) {
    if let Err(err) = try_save_snapshot(conn, playlist_id, uris) {
        tracing::error!(error = %err, "falha ao salvar snapshot");
    }
}

/// Variante que permite ao backend headless interromper uma escrita sem backup.
pub fn try_save_snapshot(
    conn: &Connection,
    playlist_id: &str,
    uris: &[String],
) -> rusqlite::Result<()> {
    let body = serde_json::to_string(uris).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO snapshots (playlist_id, snapshot, created_at) VALUES (?, ?, ?)",
        rusqlite::params![playlist_id, body, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

/// Snapshot mais recente ainda não desfeito.
pub fn get_latest_snapshot(conn: &Connection, playlist_id: &str) -> Option<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT snapshot FROM snapshots WHERE playlist_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
        .ok()?;
    let raw: String = stmt.query_row([playlist_id], |r| r.get(0)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Marca o snapshot pendente como desfeito.
pub fn mark_snapshot_undone(conn: &Connection, playlist_id: &str) {
    if let Err(err) = conn.execute(
        "UPDATE snapshots SET undone_at = ? WHERE playlist_id = ? AND undone_at IS NULL",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), playlist_id],
    ) {
        tracing::error!(error = %err, "falha ao marcar snapshot como desfeito");
    }
}

/// Id do snapshot mais recente (usado no `undo_hint` do MCP).
pub fn latest_snapshot_id(conn: &Connection, playlist_id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM snapshots WHERE playlist_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1",
        [playlist_id],
        |r| r.get(0),
    )
    .ok()
}

/// Registra um delta incremental na tabela `playlist_diffs`.
pub fn record_diff(
    conn: &Connection,
    playlist_id: &str,
    hash: &str,
    delta: &crate::tools::server::diff::PlaylistDelta,
) -> rusqlite::Result<i64> {
    let parent_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM playlist_diffs WHERE playlist_id = ? ORDER BY id DESC LIMIT 1",
            [playlist_id],
            |r| r.get(0),
        )
        .ok();

    let delta_json = serde_json::to_string(delta).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "INSERT INTO playlist_diffs (playlist_id, parent_diff_id, created_at, hash, added_count, removed_count, reordered, delta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            playlist_id,
            parent_id,
            chrono::Utc::now().timestamp_millis(),
            hash,
            delta.added.len(),
            delta.removed.len(),
            if delta.reordered { 1 } else { 0 },
            delta_json,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Obtém o hash mais recente gravado para a playlist.
pub fn get_latest_hash(conn: &Connection, playlist_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT hash FROM playlist_diffs WHERE playlist_id = ? ORDER BY id DESC LIMIT 1",
        [playlist_id],
        |r| r.get(0),
    )
    .ok()
}

/// Consulta o histórico de diffs de uma playlist.
pub fn get_diff_history(
    conn: &Connection,
    playlist_id: &str,
    limit: usize,
) -> Vec<serde_json::Value> {
    let mut stmt = match conn.prepare(
        "SELECT id, parent_diff_id, created_at, hash, added_count, removed_count, reordered, delta FROM playlist_diffs WHERE playlist_id = ? ORDER BY id DESC LIMIT ?"
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = stmt.query_map(rusqlite::params![playlist_id, limit as i64], |row| {
        let delta_str: String = row.get(7)?;
        let delta_val: serde_json::Value =
            serde_json::from_str(&delta_str).unwrap_or(serde_json::Value::Null);
        Ok(serde_json::json!({
            "id": row.get::<_, i64>(0)?,
            "parent_id": row.get::<_, Option<i64>>(1)?,
            "created_at": row.get::<_, i64>(2)?,
            "hash": row.get::<_, String>(3)?,
            "added_count": row.get::<_, i64>(4)?,
            "removed_count": row.get::<_, i64>(5)?,
            "reordered": row.get::<_, i64>(6)? == 1,
            "delta": delta_val,
        }))
    });

    match rows {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_snapshot_wins_and_undo_hides_it() {
        let store = crate::store::Store::in_memory().unwrap();
        store
            .with(|c| {
                save_snapshot(c, "p", &["a".into(), "b".into()]);
                save_snapshot(c, "p", &["c".into()]);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.with(|c| Ok(get_latest_snapshot(c, "p"))).unwrap(),
            Some(vec!["c".to_string()])
        );
        store
            .with(|c| {
                mark_snapshot_undone(c, "p");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.with(|c| Ok(get_latest_snapshot(c, "p"))).unwrap(),
            None
        );
        // O snapshot anterior também é marcado (mesma semântica do Node).
        assert_eq!(
            store.with(|c| Ok(latest_snapshot_id(c, "p"))).unwrap(),
            None
        );
    }

    #[test]
    fn unknown_playlist_has_no_snapshot() {
        let store = crate::store::Store::in_memory().unwrap();
        assert_eq!(
            store.with(|c| Ok(get_latest_snapshot(c, "nope"))).unwrap(),
            None
        );
    }
}
