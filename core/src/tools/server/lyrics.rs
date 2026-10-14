//! Letras: LRCLIB → Lyrics.ovh (mesma ordem do Node) e o lote com concorrência
//! limitada (`mapLimit(tracks, 4)`).

use super::{http, map_limit};
use crate::protocol::ToolResult;
use serde_json::json;
use std::time::Duration;

pub const MAX_LYRICS_CHARS: usize = 8000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct LyricsRequest {
    pub uri: String,
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
}

/// Limpa sufixos de crédito ("- feat X", "- with Y", "- prod Z").
pub fn clean_title(title: &str) -> String {
    let lower = title.to_ascii_lowercase();
    for marker in ["- feat", "- feat.", "- with", "- prod"] {
        if let Some(pos) = lower.find(marker) {
            // Só corta se o marcador vier precedido de espaço/hífen (evita
            // mutilar títulos como "With You").
            if pos > 0 {
                return title[..pos].trim().to_string();
            }
        }
    }
    title.trim().to_string()
}

pub async fn lyrics_lookup(
    artist: &str,
    title: &str,
    album: Option<&str>,
    duration_ms: Option<i64>,
) -> ToolResult {
    let clean = clean_title(title);
    let first = lrclib(artist, &clean, album, duration_ms).await;
    if first.ok {
        return first;
    }
    let second = ovh(artist, &clean).await;
    if second.ok {
        return second;
    }
    ToolResult::err("lyrics_not_found")
}

async fn lrclib(
    artist: &str,
    title: &str,
    album: Option<&str>,
    duration_ms: Option<i64>,
) -> ToolResult {
    let mut url = match reqwest::Url::parse("https://lrclib.net/api/get") {
        Ok(u) => u,
        Err(e) => return ToolResult::err(format!("lrclib_url:{e}")),
    };
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("artist_name", artist);
        qp.append_pair("track_name", title);
        if let Some(album) = album {
            qp.append_pair("album_name", album);
        }
        if let Some(ms) = duration_ms {
            qp.append_pair("duration", &(ms / 1000).to_string());
        }
    }
    let res = http()
        .get(url)
        .header("x-user-agent", "euterpe (https://github.com/local/euterpe)")
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("lrclib:{e}")),
    };
    if res.status().as_u16() == 404 {
        return ToolResult::err("lrclib_404");
    }
    if !res.status().is_success() {
        return ToolResult::err(format!("lrclib_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = match res.json().await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("lrclib_json:{e}")),
    };
    if body
        .get("instrumental")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return ToolResult::err("instrumental");
    }
    let text = body
        .get("plainLyrics")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| body.get("syncedLyrics").and_then(|v| v.as_str()));
    match text {
        Some(t) if !t.is_empty() => {
            let truncated: String = t.chars().take(MAX_LYRICS_CHARS).collect();
            ToolResult::ok(json!({ "source": "lrclib", "text": truncated }))
        }
        _ => ToolResult::err("lrclib_empty"),
    }
}

async fn ovh(artist: &str, title: &str) -> ToolResult {
    let url = format!(
        "https://api.lyrics.ovh/v1/{}/{}",
        urlencoding::encode(artist),
        urlencoding::encode(title)
    );
    let res = http()
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("ovh:{e}")),
    };
    if res.status().as_u16() == 404 {
        return ToolResult::err("ovh_404");
    }
    if !res.status().is_success() {
        return ToolResult::err(format!("ovh_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = match res.json().await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("ovh_json:{e}")),
    };
    match body
        .get("lyrics")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        Some(text) => {
            let truncated: String = text.chars().take(MAX_LYRICS_CHARS).collect();
            ToolResult::ok(json!({ "source": "ovh", "text": truncated }))
        }
        None => ToolResult::err("ovh_empty"),
    }
}

/// Lote com fan-out limitado (4, como no Node).
pub async fn lyrics_bulk(tracks: Vec<LyricsRequest>) -> ToolResult {
    if tracks.is_empty() {
        return ToolResult::err("no_tracks");
    }
    let results = map_limit(tracks, 4, |t| async move {
        let res = lyrics_lookup(&t.artist, &t.title, t.album.as_deref(), t.duration_ms).await;
        match res.data {
            Some(data) if res.ok => json!({
                "uri": t.uri,
                "text": data.get("text").cloned().unwrap_or(serde_json::Value::Null),
                "source": data.get("source").cloned().unwrap_or(serde_json::Value::Null),
            }),
            _ => json!({ "uri": t.uri, "text": null, "source": null }),
        }
    })
    .await;
    ToolResult::ok(serde_json::Value::Array(results))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_cleanup_matches_node_behavior() {
        assert_eq!(clean_title("Song - feat. Someone"), "Song");
        assert_eq!(clean_title("Song - with Band"), "Song");
        assert_eq!(clean_title("Song - prod. X"), "Song");
        assert_eq!(clean_title("  Song  "), "Song");
        // Não pode cortar por engano quando não há crédito.
        assert_eq!(clean_title("With You"), "With You");
        assert_eq!(clean_title("Stand By Me"), "Stand By Me");
    }

    #[tokio::test]
    async fn empty_bulk_is_an_error() {
        assert_eq!(lyrics_bulk(Vec::new()).await, ToolResult::err("no_tracks"));
    }
}
