//! Spotify Charts com cache de 6 h (a mesma TTL do Node).

use super::http;
use crate::protocol::ToolResult;
use crate::store::Store;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

pub const CACHE_TTL_MS: i64 = 6 * 3600 * 1000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ChartEntry {
    pub uri: String,
    pub rank: i64,
}

/// Baixa (ou lê do cache) os charts de uma região.
pub async fn fetch_charts(store: Option<&Store>, region: &str) -> Option<Vec<ChartEntry>> {
    let cache_key = format!("charts:{region}");
    if let Some(store) = store {
        if let Some(raw) = store
            .with(|c| Ok(crate::store::cache::get_cache(c, &cache_key)))
            .ok()
            .flatten()
        {
            if let Ok(entries) = serde_json::from_str::<Vec<ChartEntry>>(&raw) {
                return Some(entries);
            }
        }
    }

    let res = http()
        .get("https://charts-spotify-com-service.spotify.com/public/v0/charts")
        .query(&[("region", region)])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body: Value = res.json().await.ok()?;
    let entries: Vec<ChartEntry> = body
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let uri = e
                        .pointer("/trackMetadata/trackUri")
                        .and_then(|v| v.as_str())?
                        .to_string();
                    let rank = e
                        .pointer("/chartEntryData/currentRank")
                        .and_then(|v| v.as_i64())?;
                    Some(ChartEntry { uri, rank })
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(store) = store {
        if let Ok(raw) = serde_json::to_string(&entries) {
            store
                .with(|c| {
                    crate::store::cache::set_cache(c, &cache_key, &raw, CACHE_TTL_MS);
                    Ok(())
                })
                .ok();
        }
    }
    Some(entries)
}

pub async fn chart_lookup(store: Option<&Store>, uris: Vec<String>, region: &str) -> ToolResult {
    let entries = match fetch_charts(store, region).await {
        Some(e) => e,
        None => return ToolResult::err("charts_unavailable"),
    };
    let rank_by_uri: BTreeMap<String, i64> = entries.into_iter().map(|e| (e.uri, e.rank)).collect();
    let matches: Vec<Value> = uris
        .iter()
        .filter_map(|uri| {
            rank_by_uri
                .get(uri)
                .map(|rank| json!({ "uri": uri, "position": rank }))
        })
        .collect();
    ToolResult::ok(json!({ "region": region, "matches": matches }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip_avoids_network() {
        let store = Store::in_memory().unwrap();
        let entries = vec![
            ChartEntry {
                uri: "spotify:track:a".into(),
                rank: 1,
            },
            ChartEntry {
                uri: "spotify:track:b".into(),
                rank: 2,
            },
        ];
        let raw = serde_json::to_string(&entries).unwrap();
        store
            .with(|c| {
                crate::store::cache::set_cache(c, "charts:global", &raw, CACHE_TTL_MS);
                Ok(())
            })
            .unwrap();
        let got = store
            .with(|c| Ok(crate::store::cache::get_cache(c, "charts:global")))
            .unwrap()
            .and_then(|raw| serde_json::from_str::<Vec<ChartEntry>>(&raw).ok())
            .unwrap();
        assert_eq!(got, entries);
    }

    #[test]
    fn ttl_is_six_hours() {
        assert_eq!(CACHE_TTL_MS, 21_600_000);
    }
}
