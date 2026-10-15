//! Governança e auditoria de bibliotecas e playlists (PLAN-IMPROVEMENTS.md §2.6).

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use super::ServerToolContext;
use crate::paths;
use crate::protocol::ToolResult;

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupPayload {
    pub timestamp: String,
    pub backup_id: String,
    pub library: Value,
}

/// Identifica faixas que estavam nas playlists de origem mas não estão nas playlists de destino.
pub async fn find_orphans(
    source_ids: Vec<String>,
    target_ids: Vec<String>,
    ctx: &ServerToolContext<'_>,
) -> ToolResult {
    if source_ids.is_empty() {
        return ToolResult::err("find_orphans: source_playlist_ids must not be empty");
    }

    // 1. Coleta faixas das playlists de destino
    let mut target_track_uris = HashSet::new();
    for tid in &target_ids {
        let res = ctx
            .request_client_tool(
                &format!("orphans_t_{tid}"),
                "get_playlist_tracks",
                json!({ "playlist_id": tid }),
            )
            .await;
        if res.ok {
            if let Some(arr) = res.data.as_ref().and_then(|d| d.as_array()) {
                for t in arr {
                    if let Some(uri) = t.get("uri").and_then(|u| u.as_str()) {
                        target_track_uris.insert(uri.to_string());
                    }
                }
            }
        }
    }

    // 2. Compara com playlists de origem
    let mut orphans = Vec::new();
    let mut seen_orphans = HashSet::new();

    for sid in &source_ids {
        let res = ctx
            .request_client_tool(
                &format!("orphans_s_{sid}"),
                "get_playlist_tracks",
                json!({ "playlist_id": sid }),
            )
            .await;
        if res.ok {
            if let Some(arr) = res.data.as_ref().and_then(|d| d.as_array()) {
                for t in arr {
                    if let Some(uri) = t.get("uri").and_then(|u| u.as_str()) {
                        if !target_track_uris.contains(uri) && seen_orphans.insert(uri.to_string())
                        {
                            orphans.push(json!({
                                "uri": uri,
                                "name": t.get("name").cloned().unwrap_or(Value::Null),
                                "artists": t.get("artists").cloned().unwrap_or(Value::Null),
                                "original_playlist": sid,
                            }));
                        }
                    }
                }
            }
        }
    }

    ToolResult::ok(json!({
        "orphans_count": orphans.len(),
        "orphans": orphans,
    }))
}

/// Calcula a sobreposição (interseção e Jaccard similarity) entre playlists.
pub async fn analyze_overlap(playlist_ids: Vec<String>, ctx: &ServerToolContext<'_>) -> ToolResult {
    if playlist_ids.len() < 2 {
        return ToolResult::err("analyze_overlap: at least 2 playlist_ids required");
    }

    // Coleta faixas de cada playlist
    let mut pl_tracks: HashMap<String, HashSet<String>> = HashMap::new();
    for pid in &playlist_ids {
        let res = ctx
            .request_client_tool(
                &format!("overlap_{pid}"),
                "get_playlist_tracks",
                json!({ "playlist_id": pid }),
            )
            .await;
        let mut uris = HashSet::new();
        if res.ok {
            if let Some(arr) = res.data.as_ref().and_then(|d| d.as_array()) {
                for t in arr {
                    if let Some(uri) = t.get("uri").and_then(|u| u.as_str()) {
                        uris.insert(uri.to_string());
                    }
                }
            }
        }
        pl_tracks.insert(pid.clone(), uris);
    }

    let mut matrix = Vec::new();
    for i in 0..playlist_ids.len() {
        for j in (i + 1)..playlist_ids.len() {
            let p1 = &playlist_ids[i];
            let p2 = &playlist_ids[j];
            let set1 = pl_tracks.get(p1).unwrap();
            let set2 = pl_tracks.get(p2).unwrap();

            let intersection = set1.intersection(set2).count();
            let union = set1.union(set2).count();
            let jaccard = if union == 0 {
                0.0
            } else {
                (intersection as f64 / union as f64 * 1000.0).round() / 1000.0
            };

            matrix.push(json!({
                "playlist_a": p1,
                "playlist_b": p2,
                "shared_tracks": intersection,
                "total_unique": union,
                "jaccard_similarity": jaccard,
            }));
        }
    }

    ToolResult::ok(json!({
        "comparisons_count": matrix.len(),
        "overlaps": matrix,
    }))
}

/// Realiza backup estruturado da biblioteca em disco.
pub async fn backup_library(ctx: &ServerToolContext<'_>) -> ToolResult {
    let res = ctx
        .request_client_tool(
            "backup_dump",
            "dump_library",
            json!({ "include_tracks": true, "include_saved_tracks": true }),
        )
        .await;

    if !res.ok {
        return ToolResult::err(res.code.unwrap_or_else(|| "backup_dump_failed".to_string()));
    }

    let lib_data = res.data.unwrap_or(Value::Null);
    let now = Utc::now();
    let backup_id = format!("snapshot-{}", now.format("%Y%m%d-%H%M%S"));
    let backup_dir = paths::backups_dir();

    if let Err(e) = paths::ensure_dir(&backup_dir) {
        return ToolResult::err(format!("backup_create_dir_failed:{e}"));
    }

    let file_path = backup_dir.join(format!("{backup_id}.json"));
    let payload = BackupPayload {
        timestamp: now.to_rfc3339(),
        backup_id: backup_id.clone(),
        library: lib_data,
    };

    let json_bytes = match serde_json::to_vec_pretty(&payload) {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("backup_serialize_failed:{e}")),
    };

    if let Err(e) = tokio::fs::write(&file_path, json_bytes).await {
        return ToolResult::err(format!("backup_write_failed:{e}"));
    }

    ToolResult::ok(json!({
        "ok": true,
        "backup_id": backup_id,
        "file": file_path.to_string_lossy(),
    }))
}

/// Restaura o estado da biblioteca a partir de um backup prévio em disco.
pub async fn restore_library(backup_id: &str, ctx: &ServerToolContext<'_>) -> ToolResult {
    let backup_dir = paths::backups_dir();
    let file_name = if backup_id.ends_with(".json") {
        backup_id.to_string()
    } else {
        format!("{backup_id}.json")
    };
    let file_path = backup_dir.join(file_name);

    let bytes = match tokio::fs::read(&file_path).await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("backup_not_found:{e}")),
    };

    let payload: BackupPayload = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => return ToolResult::err(format!("backup_corrupted:{e}")),
    };

    // Recria ou restaura cada playlist constante no backup
    let playlists = payload
        .library
        .get("playlists")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut restored = 0;
    for pl in playlists {
        if let (Some(name), Some(tracks)) = (
            pl.get("name").and_then(|n| n.as_str()),
            pl.get("tracks").and_then(|t| t.as_array()),
        ) {
            let uris: Vec<String> = tracks
                .iter()
                .filter_map(|t| t.get("uri").and_then(|u| u.as_str()).map(str::to_string))
                .collect();

            let res = ctx
                .request_client_tool(
                    &format!("restore_{restored}"),
                    "create_playlist",
                    json!({
                        "name": format!("{name} (Restaurada)"),
                        "description": format!("Restaurada do backup {}", payload.backup_id),
                        "tracks": uris,
                    }),
                )
                .await;
            if res.ok {
                restored += 1;
            }
        }
    }

    ToolResult::ok(json!({
        "ok": true,
        "backup_id": payload.backup_id,
        "playlists_restored": restored,
    }))
}

/// Consulta a timeline de alterações e diffs incrementais de uma playlist.
pub async fn get_playlist_history(
    playlist_id: &str,
    limit: usize,
    ctx: &ServerToolContext<'_>,
) -> ToolResult {
    let store = match ctx.store {
        Some(s) => s,
        None => return ToolResult::err("no_store"),
    };

    let history = store
        .with(|c| {
            Ok(crate::store::snapshots::get_diff_history(
                c,
                playlist_id,
                limit,
            ))
        })
        .unwrap_or_default();

    ToolResult::ok(json!({
        "playlist_id": playlist_id,
        "versions_count": history.len(),
        "history": history,
    }))
}
