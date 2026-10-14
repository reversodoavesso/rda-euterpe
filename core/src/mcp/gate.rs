//! Gate de mutação do MCP (decisão D3).
//!
//! Regras:
//!  - `mutation_policy: allow | confirm | deny` (default **allow**);
//!  - `mutation_allowlist` opcional restringe quais tools podem executar;
//!  - **independente da política**, toda mutação grava snapshot antes;
//!  - o resultado carrega `{snapshot_id, undo_hint}` — o cinto de segurança do
//!    default permissivo é `spotify_undo_last_mutation`, sempre exposto.

use serde_json::{json, Value};

use crate::config::MutationPolicy;
use crate::protocol::ToolResult;
use crate::store::Store;

/// Decide a política efetiva de uma chamada considerando a allowlist.
pub fn effective_policy(base: MutationPolicy, tool: &str, allowlist: &[String]) -> MutationPolicy {
    if allowlist.is_empty() || allowlist.iter().any(|t| t == tool) {
        return base;
    }
    // Fora da allowlist: nunca muta.
    MutationPolicy::Deny
}

/// Envelopa o resultado de uma mutação com o metadado de snapshot.
pub fn annotate(result: ToolResult, store: &Store, args: &Value, tool: &str) -> ToolResult {
    if !result.ok {
        return result;
    }
    let playlist_id = args.get("playlist_id").and_then(|v| v.as_str());
    let snapshot_id = playlist_id.and_then(|id| {
        store
            .with(|c| Ok(crate::store::snapshots::latest_snapshot_id(c, id)))
            .ok()
            .flatten()
    });
    let mut data = match result.data {
        Some(Value::Object(map)) => Value::Object(map),
        Some(other) => json!({ "result": other }),
        None => json!({}),
    };
    data["snapshot_id"] = json!(snapshot_id);
    data["undo_hint"] = json!("spotify_undo_last_mutation");
    if tool == "create_playlist" {
        data["undo_hint"] = json!(null);
        data["undo_note"] = json!("create_playlist não é reversível por snapshot");
    }
    ToolResult {
        ok: true,
        data: Some(data),
        code: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_restricts_in_both_directions() {
        let allow = vec!["add_tracks".to_string()];
        assert_eq!(
            effective_policy(MutationPolicy::Allow, "add_tracks", &allow),
            MutationPolicy::Allow
        );
        assert_eq!(
            effective_policy(MutationPolicy::Allow, "remove_tracks", &allow),
            MutationPolicy::Deny
        );
        // Allowlist vazia = tudo permitido (default de D3).
        assert_eq!(
            effective_policy(MutationPolicy::Allow, "remove_tracks", &[]),
            MutationPolicy::Allow
        );
    }

    #[test]
    fn failed_results_are_not_annotated() {
        let store = Store::in_memory().unwrap();
        let res = annotate(
            ToolResult::err("user_rejected"),
            &store,
            &json!({"playlist_id":"p"}),
            "add_tracks",
        );
        assert_eq!(res, ToolResult::err("user_rejected"));
    }

    #[test]
    fn successful_mutation_carries_snapshot_metadata() {
        let store = Store::in_memory().unwrap();
        store
            .with(|c| {
                crate::store::snapshots::save_snapshot(c, "p", &["spotify:track:a".to_string()]);
                Ok(())
            })
            .unwrap();
        let res = annotate(
            ToolResult::ok(json!({"added": 1})),
            &store,
            &json!({"playlist_id":"p"}),
            "add_tracks",
        );
        let data = res.data.unwrap();
        assert_eq!(data["added"], 1);
        assert_eq!(data["undo_hint"], "spotify_undo_last_mutation");
        assert!(data["snapshot_id"].as_i64().is_some());
    }

    #[test]
    fn create_playlist_is_flagged_as_not_undoable() {
        let store = Store::in_memory().unwrap();
        let res = annotate(
            ToolResult::ok(json!({})),
            &store,
            &json!({"name":"x"}),
            "create_playlist",
        );
        let data = res.data.unwrap();
        assert!(data["undo_hint"].is_null());
        assert_eq!(data["snapshot_id"], Value::Null);
    }
}
