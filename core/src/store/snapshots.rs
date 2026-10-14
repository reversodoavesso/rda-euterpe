//! Snapshots de playlist (base do `undo_last_mutation` e do cinto de segurança de
//! D3: **toda** mutação grava snapshot antes de executar).

use rusqlite::Connection;

/// Grava `uris` como snapshot da playlist.
pub fn save_snapshot(conn: &Connection, playlist_id: &str, uris: &[String]) {
    let body = serde_json::to_string(uris).unwrap_or_else(|_| "[]".to_string());
    if let Err(err) = conn.execute(
        "INSERT INTO snapshots (playlist_id, snapshot, created_at) VALUES (?, ?, ?)",
        rusqlite::params![playlist_id, body, chrono::Utc::now().timestamp_millis()],
    ) {
        tracing::error!(error = %err, "falha ao salvar snapshot");
    }
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
