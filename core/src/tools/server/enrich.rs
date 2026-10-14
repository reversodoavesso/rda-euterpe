//! Enriquecimento cruzado, artistas similares e info de artista
//! (paridade com `enrichTracks`/`similarArtists`/`artistInfo`).

use super::{http, lyrics, ServerToolContext};
use crate::protocol::ToolResult;
use crate::store::Store;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

/// Orquestrador central: metadata + artistas + gêneros + letras.
pub async fn enrich_tracks(ids: Vec<String>, ctx: &ServerToolContext<'_>) -> ToolResult {
    let ids: Vec<String> = ids.into_iter().filter(|s| !s.trim().is_empty()).collect();
    if ids.is_empty() {
        return ToolResult::err("no_ids");
    }

    let tracks_res = ctx
        .request_client_tool("enrich_tracks", "get_several_tracks", json!({ "ids": ids }))
        .await;
    if !tracks_res.ok {
        return tracks_res;
    }
    let tracks: Vec<Value> = tracks_res
        .data
        .as_ref()
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let artist_ids: Vec<String> = tracks
        .iter()
        .flat_map(|t| {
            t.get("artist_ids")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let mut artists_by_id: BTreeMap<String, Value> = BTreeMap::new();
    if !artist_ids.is_empty() {
        let take: Vec<String> = artist_ids.into_iter().take(50).collect();
        let artists_res = ctx
            .request_client_tool(
                "enrich_artists",
                "get_several_artists",
                json!({ "ids": take }),
            )
            .await;
        if artists_res.ok {
            if let Some(arr) = artists_res.data.as_ref().and_then(|d| d.as_array()) {
                for a in arr {
                    if let Some(id) = a.get("id").and_then(|v| v.as_str()) {
                        artists_by_id.insert(id.to_string(), a.clone());
                    }
                }
            }
        }
    }

    let lyrics_requests: Vec<lyrics::LyricsRequest> = tracks
        .iter()
        .take(15)
        .map(|t| lyrics::LyricsRequest {
            uri: t
                .get("uri")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            artist: t
                .get("artists")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: t
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            album: t.get("album").and_then(|v| v.as_str()).map(str::to_string),
            duration_ms: t.get("duration_ms").and_then(|v| v.as_i64()),
        })
        .collect();
    let lyrics_res = lyrics::lyrics_bulk(lyrics_requests).await;
    let mut lyrics_by_uri: BTreeMap<String, Value> = BTreeMap::new();
    if lyrics_res.ok {
        if let Some(arr) = lyrics_res.data.as_ref().and_then(|d| d.as_array()) {
            for l in arr {
                if let Some(uri) = l.get("uri").and_then(|v| v.as_str()) {
                    lyrics_by_uri.insert(uri.to_string(), l.clone());
                }
            }
        }
    }

    let enriched: Vec<Value> = tracks
        .iter()
        .map(|t| {
            let uri = t
                .get("uri")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut genres: BTreeSet<String> = BTreeSet::new();
            if let Some(aids) = t.get("artist_ids").and_then(|v| v.as_array()) {
                for aid in aids.iter().filter_map(|v| v.as_str()) {
                    if let Some(artist) = artists_by_id.get(aid) {
                        if let Some(g) = artist.get("genres").and_then(|v| v.as_array()) {
                            for item in g.iter().filter_map(|v| v.as_str()) {
                                genres.insert(item.to_string());
                            }
                        }
                    }
                }
            }
            let lyric = lyrics_by_uri.get(&uri).and_then(|l| {
                let text = l
                    .get("text")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                let source = l.get("source").and_then(|v| v.as_str());
                text.map(|t| json!({ "text": t, "source": source }))
            });
            json!({
                "uri": uri,
                "name": t.get("name").cloned().unwrap_or(Value::Null),
                "album": t.get("album").cloned().unwrap_or(Value::Null),
                "duration_ms": t.get("duration_ms").cloned().unwrap_or(Value::Null),
                "artists": t.get("artists").cloned().unwrap_or(json!([])),
                "genres": genres.into_iter().collect::<Vec<_>>(),
                "lyrics": lyric,
            })
        })
        .collect();

    ToolResult::ok(json!({ "count": enriched.len(), "tracks": enriched }))
}

/* ------------------------------------------------------- artistas similares */

/// Deezer (+ Last.fm quando configurado), ranqueados por número de fontes.
pub async fn similar_artists(
    artist: &str,
    limit: usize,
    ctx: &ServerToolContext<'_>,
) -> ToolResult {
    let mut sources: BTreeMap<String, Vec<String>> = BTreeMap::new();

    if let Ok(names) = similar_from_deezer(artist, limit).await {
        sources.insert("deezer".to_string(), names);
    }
    if let Some(key) = ctx
        .cfg
        .lastfm_api_key
        .as_deref()
        .filter(|k| !k.trim().is_empty())
    {
        if let Ok(names) = similar_from_lastfm(artist, limit, key).await {
            sources.insert("lastfm".to_string(), names);
        }
    }
    if sources.is_empty() {
        return ToolResult::err("no_similar_source");
    }

    let mut ranked: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (src, names) in &sources {
        for name in names {
            ranked.entry(name.clone()).or_default().push(src.clone());
        }
    }
    let mut list: Vec<(String, Vec<String>)> = ranked.into_iter().collect();
    list.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
    let list: Vec<Value> = list
        .into_iter()
        .take(limit)
        .map(|(name, sources)| json!({ "name": name, "sources": sources }))
        .collect();

    ToolResult::ok(json!({ "artist": artist, "similar": list }))
}

pub async fn similar_from_deezer(artist: &str, limit: usize) -> Result<Vec<String>, String> {
    let search = http()
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", artist), ("limit", "1")])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("deezer:{e}"))?;
    if !search.status().is_success() {
        return Err("deezer_search".into());
    }
    let found: Value = search
        .json()
        .await
        .map_err(|e| format!("deezer_json:{e}"))?;
    let id = found
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.get("id"))
        .and_then(|v| v.as_i64())
        .ok_or("deezer_not_found")?;
    let rel = http()
        .get(format!("https://api.deezer.com/artist/{id}/related"))
        .query(&[("limit", limit.to_string())])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("deezer_related:{e}"))?;
    if !rel.status().is_success() {
        return Err("deezer_related".into());
    }
    let body: Value = rel.json().await.map_err(|e| format!("deezer_json:{e}"))?;
    Ok(body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

pub async fn similar_from_lastfm(
    artist: &str,
    limit: usize,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let res = http()
        .get("https://ws.audioscrobbler.com/2.0/")
        .query(&[
            ("method", "artist.getsimilar"),
            ("artist", artist),
            ("api_key", api_key),
            ("format", "json"),
            ("limit", &limit.to_string()),
        ])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("lastfm:{e}"))?;
    if !res.status().is_success() {
        return Err("lastfm_http".into());
    }
    let body: Value = res.json().await.map_err(|e| format!("lastfm_json:{e}"))?;
    let list: Vec<String> = body
        .pointer("/similarartists/artist")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|x| {
                    x.get("match")
                        .and_then(|m| m.as_str())
                        .and_then(|m| m.parse::<f64>().ok())
                        .unwrap_or(0.0)
                        >= 0.1
                })
                .take(limit)
                .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        Err("lastfm_empty".into())
    } else {
        Ok(list)
    }
}

/* ---------------------------------------------------------- info de artista */

/// Last.fm quando houver chave; senão cai no `web_search` (fonte declarada).
pub async fn artist_info(artist: &str, limit: usize, ctx: &ServerToolContext<'_>) -> ToolResult {
    if let Some(key) = ctx
        .cfg
        .lastfm_api_key
        .as_deref()
        .filter(|k| !k.trim().is_empty())
    {
        if let Some(info) = lastfm_artist_info(artist, limit, key).await {
            return ToolResult::ok(info);
        }
    }
    let search =
        super::web_search::web_search(ctx, &format!("{artist} artist biography"), "music", None)
            .await;
    if !search.ok {
        return ToolResult::err("artist_info_unavailable");
    }
    let results = search
        .data
        .as_ref()
        .and_then(|d| d.get("results"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let bio = results
        .first()
        .and_then(|r| {
            r.get("content")
                .and_then(|v| v.as_str())
                .or_else(|| r.get("title").and_then(|v| v.as_str()))
        })
        .map(str::to_string);
    let links: Vec<Value> = results
        .iter()
        .take(5)
        .map(|r| json!({ "title": r.get("title"), "url": r.get("url") }))
        .collect();
    ToolResult::ok(json!({
        "source": "web_search",
        "artist": artist,
        "bio": bio,
        "links": links,
    }))
}

pub async fn lastfm_artist_info(artist: &str, limit: usize, api_key: &str) -> Option<Value> {
    let res = http()
        .get("https://ws.audioscrobbler.com/2.0/")
        .query(&[
            ("method", "artist.getinfo"),
            ("artist", artist),
            ("api_key", api_key),
            ("format", "json"),
        ])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body: Value = res.json().await.ok()?;
    let a = body.get("artist")?;
    let name = a.get("name").and_then(|v| v.as_str())?;

    let summary = a
        .pointer("/bio/summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let bio = strip_html(&summary);
    let tags: Vec<String> = a
        .pointer("/tags/tag")
        .and_then(|v| v.as_array())
        .map(|t| {
            t.iter()
                .take(15)
                .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let similar: Vec<String> = a
        .pointer("/similar/artist")
        .and_then(|v| v.as_array())
        .map(|s| {
            s.iter()
                .filter(|x| {
                    x.get("match")
                        .and_then(|m| m.as_str())
                        .and_then(|m| m.parse::<f64>().ok())
                        .unwrap_or(0.0)
                        >= 0.1
                })
                .take(limit)
                .filter_map(|x| x.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    Some(json!({
        "source": "lastfm",
        "artist": name,
        "bio": if bio.is_empty() { Value::Null } else { Value::String(bio) },
        "tags": tags,
        "similar": similar,
    }))
}

fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside = false;
    for ch in input.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Reexportado para o teste de `undo_last_mutation` usar um store em memória.
pub fn memory_store() -> Store {
    Store::in_memory().expect("store em memória")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_html_removes_tags() {
        assert_eq!(strip_html("<a href=\"x\">Bio</a> text"), "Bio text");
    }

    #[tokio::test]
    async fn enrich_without_ids_is_an_error() {
        let cfg =
            crate::config::Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-enrich"));
        let store = memory_store();
        let ctx = ServerToolContext {
            cfg: &cfg,
            store: Some(&store),
            bridge: std::sync::Arc::new(crate::bridge::Bridge::new()),
            locale: "en".into(),
            session_id: "s".into(),
        };
        let res = enrich_tracks(vec![], &ctx).await;
        assert_eq!(res, ToolResult::err("no_ids"));
    }
}
