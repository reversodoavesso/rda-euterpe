//! Diff Engine de playlists (PLAN-DIFF-ENGINE.md §3.4).
//!
//! Calcula deltas estruturados entre duas listas ordenadas de URIs:
//! - Faixas adicionadas
//! - Faixas removidas
//! - Faixas reordenadas com posições anterior e atual
//! - Hashing FNV-1a para comparação rápida de estados.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackMove {
    pub uri: String,
    pub from_index: usize,
    pub to_index: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaylistDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub moved: Vec<TrackMove>,
    pub reordered: bool,
    pub previous_count: usize,
    pub current_count: usize,
}

/// Calcula o hash FNV-1a de 64 bits de uma sequência de URIs na ordem exata.
pub fn compute_playlist_hash(uris: &[String]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for (i, uri) in uris.iter().enumerate() {
        if i > 0 {
            hash ^= b',' as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        for byte in uri.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

/// Calcula a diferença estruturada entre duas listas ordenadas de URIs.
pub fn calculate_diff(previous: &[String], current: &[String]) -> PlaylistDelta {
    let prev_set: HashSet<&str> = previous.iter().map(|s| s.as_str()).collect();
    let curr_set: HashSet<&str> = current.iter().map(|s| s.as_str()).collect();

    // 1. Adicionados (no current que não estavam no previous)
    let mut added = Vec::new();
    for uri in current {
        if !prev_set.contains(uri.as_str()) && !added.contains(uri) {
            added.push(uri.clone());
        }
    }

    // 2. Removidos (no previous que não estão mais no current)
    let mut removed = Vec::new();
    for uri in previous {
        if !curr_set.contains(uri.as_str()) && !removed.contains(uri) {
            removed.push(uri.clone());
        }
    }

    // 3. Reordenações
    let mut prev_positions: HashMap<&str, usize> = HashMap::new();
    for (idx, uri) in previous.iter().enumerate() {
        prev_positions.entry(uri.as_str()).or_insert(idx);
    }

    let mut moved = Vec::new();
    for (curr_idx, uri) in current.iter().enumerate() {
        if let Some(&prev_idx) = prev_positions.get(uri.as_str()) {
            if prev_idx != curr_idx {
                moved.push(TrackMove {
                    uri: uri.clone(),
                    from_index: prev_idx,
                    to_index: curr_idx,
                });
            }
        }
    }

    let reordered = !moved.is_empty();

    PlaylistDelta {
        added,
        removed,
        moved,
        reordered,
        previous_count: previous.len(),
        current_count: current.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_order_sensitive() {
        let list1 = vec!["spotify:track:1".into(), "spotify:track:2".into()];
        let list2 = vec!["spotify:track:1".into(), "spotify:track:2".into()];
        let list3 = vec!["spotify:track:2".into(), "spotify:track:1".into()];

        assert_eq!(compute_playlist_hash(&list1), compute_playlist_hash(&list2));
        assert_ne!(compute_playlist_hash(&list1), compute_playlist_hash(&list3));
    }

    #[test]
    fn detects_addition_and_removal() {
        let prev = vec!["a".into(), "b".into(), "c".into()];
        let curr = vec!["b".into(), "c".into(), "d".into()];

        let diff = calculate_diff(&prev, &curr);
        assert_eq!(diff.added, vec!["d".to_string()]);
        assert_eq!(diff.removed, vec!["a".to_string()]);
        assert_eq!(diff.previous_count, 3);
        assert_eq!(diff.current_count, 3);
    }

    #[test]
    fn detects_reordering_positions() {
        let prev = vec!["a".into(), "b".into(), "c".into()];
        let curr = vec!["c".into(), "a".into(), "b".into()];

        let diff = calculate_diff(&prev, &curr);
        assert!(diff.reordered);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert_eq!(diff.moved.len(), 3);
        assert_eq!(
            diff.moved[0],
            TrackMove {
                uri: "c".into(),
                from_index: 2,
                to_index: 0
            }
        );
    }
}
