//! Busca de imagens (Openverse, licença comercial) — para capa de playlist.

use super::http;
use crate::protocol::ToolResult;
use serde_json::json;
use std::time::Duration;

pub const MAX_PER_PAGE: usize = 20;

pub async fn image_search(query: &str, per_page: usize) -> ToolResult {
    let res = http()
        .get("https://api.openverse.org/v1/images/")
        .query(&[
            ("q", query),
            ("license_type", "commercial"),
            ("page_size", &per_page.min(MAX_PER_PAGE).to_string()),
        ])
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return ToolResult::err(format!("openverse:{e}")),
    };
    if !res.status().is_success() {
        return ToolResult::err(format!("openverse_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = match res.json().await {
        Ok(b) => b,
        Err(e) => return ToolResult::err(format!("openverse_json:{e}")),
    };
    let results: Vec<serde_json::Value> = body
        .get("results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    json!({
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "thumbnail": r.get("thumbnail"),
                        "license": r.get("license"),
                        "creator": r.get("creator"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ToolResult::ok(json!({ "q": query, "results": results }))
}
