//! Busca na web — cadeia resiliente (Fase 5).
//!
//! Ordem (`WebSearchBackend::Auto`): **SearXNG** (se houver URL configurada) →
//! **Brave** (se houver chave) → **Tavily** (se houver chave) → **DuckDuckGo HTML**
//! (sem chave, sempre disponível). O backend explícito ignora os anteriores.
//!
//! Resultado normalizado: `{ ok, data: { query, source, results: [{title,url,content}] } }`
//! — o campo `source` é **aditivo** (o Node devolvia só `{query,results}`); o
//! prompt manda declarar a fonte, então é informação útil para o modelo.

use super::{http, ServerToolContext};
use crate::config::WebSearchBackend;
use crate::protocol::ToolResult;
use serde_json::json;
use std::time::Duration;

const MAX_RESULTS: usize = 8;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub content: String,
}

pub async fn web_search(
    ctx: &ServerToolContext<'_>,
    query: &str,
    categories: &str,
    time_range: Option<&str>,
) -> ToolResult {
    if query.trim().is_empty() {
        return ToolResult::err("empty_query");
    }
    let backend = if let Some(store) = ctx.store {
        if let Ok(cache) = crate::store::settings::SettingsCache::load(store) {
            cache.effective(ctx.cfg).web_search
        } else {
            ctx.cfg.web_search
        }
    } else {
        ctx.cfg.web_search
    };
    if backend == WebSearchBackend::Off {
        return ToolResult::err("web_search_disabled");
    }

    let mut attempts: Vec<WebSearchBackend> = Vec::new();
    match backend {
        WebSearchBackend::Auto => {
            if !ctx.cfg.searxng_url.trim().is_empty() {
                attempts.push(WebSearchBackend::Searxng);
            }
            if ctx.cfg.brave_api_key.is_some() {
                attempts.push(WebSearchBackend::Brave);
            }
            if ctx.cfg.tavily_api_key.is_some() {
                attempts.push(WebSearchBackend::Tavily);
            }
            attempts.push(WebSearchBackend::Duckduckgo);
        }
        explicit => attempts.push(explicit),
    }

    let mut last_error = String::from("no_backend");
    for candidate in attempts {
        let outcome = match candidate {
            WebSearchBackend::Searxng => {
                searxng(&ctx.cfg.searxng_url, query, categories, time_range).await
            }
            WebSearchBackend::Brave => {
                brave(ctx.cfg.brave_api_key.as_deref().unwrap_or(""), query).await
            }
            WebSearchBackend::Tavily => {
                tavily(ctx.cfg.tavily_api_key.as_deref().unwrap_or(""), query).await
            }
            WebSearchBackend::Duckduckgo => duckduckgo(query).await,
            WebSearchBackend::Off | WebSearchBackend::Auto => unreachable!("resolvido acima"),
        };
        match outcome {
            Ok(hits) if !hits.is_empty() => {
                return ToolResult::ok(json!({
                    "query": query,
                    "source": source_name(candidate),
                    "results": hits,
                }));
            }
            Ok(_) => last_error = format!("{}_empty", source_name(candidate)),
            Err(code) => last_error = code,
        }
    }
    ToolResult::err(last_error)
}

fn source_name(backend: WebSearchBackend) -> &'static str {
    match backend {
        WebSearchBackend::Searxng => "searxng",
        WebSearchBackend::Brave => "brave",
        WebSearchBackend::Tavily => "tavily",
        WebSearchBackend::Duckduckgo => "duckduckgo",
        _ => "unknown",
    }
}

/* ------------------------------------------------------------------ SearXNG */

async fn searxng(
    base: &str,
    query: &str,
    categories: &str,
    time_range: Option<&str>,
) -> Result<Vec<SearchHit>, String> {
    let mut url = match reqwest::Url::parse(base.trim_end_matches('/')) {
        Ok(u) => u.join("search").map_err(|e| e.to_string())?,
        Err(e) => return Err(format!("searxng_url:{e}")),
    };
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("q", query);
        qp.append_pair("format", "json");
        qp.append_pair("categories", categories);
        if let Some(range) = time_range {
            qp.append_pair("time_range", range);
        }
    }
    let res = http()
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("searxng:{e}"))?;
    if !res.status().is_success() {
        return Err(format!("searxng_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| format!("searxng_json:{e}"))?;
    let hits = body
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(MAX_RESULTS)
                .map(|r| SearchHit {
                    title: r
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    url: r
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    content: r
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(hits)
}

/* -------------------------------------------------------------------- Brave */

async fn brave(api_key: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    if api_key.trim().is_empty() {
        return Err("brave_no_key".into());
    }
    let res = http()
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", &MAX_RESULTS.to_string())])
        .header("X-Subscription-Token", api_key)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("brave:{e}"))?;
    if !res.status().is_success() {
        return Err(format!("brave_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| format!("brave_json:{e}"))?;
    let hits = body
        .pointer("/web/results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(MAX_RESULTS)
                .map(|r| SearchHit {
                    title: r
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    url: r
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    content: r
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

/* ------------------------------------------------------------------- Tavily */

async fn tavily(api_key: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    if api_key.trim().is_empty() {
        return Err("tavily_no_key".into());
    }
    let res = http()
        .post("https://api.tavily.com/search")
        .json(&json!({ "api_key": api_key, "query": query, "max_results": MAX_RESULTS }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("tavily:{e}"))?;
    if !res.status().is_success() {
        return Err(format!("tavily_http_{}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| format!("tavily_json:{e}"))?;
    let hits = body
        .get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .take(MAX_RESULTS)
                .map(|r| SearchHit {
                    title: r
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    url: r
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    content: r
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

/* -------------------------------------------------------------- DuckDuckGo */

/// DuckDuckGo HTML: sem chave, sem SDK. Parse tolerante por varredura de
/// marcadores (`result__a`, `result__snippet`) — nada de regex dinâmica.
pub async fn duckduckgo(query: &str) -> Result<Vec<SearchHit>, String> {
    let res = http()
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("ddg:{e}"))?;
    if !res.status().is_success() {
        return Err(format!("ddg_http_{}", res.status().as_u16()));
    }
    let html = res.text().await.map_err(|e| format!("ddg_body:{e}"))?;
    Ok(parse_ddg(&html, MAX_RESULTS))
}

/// Parse do HTML do DDG. Exportado para teste com fixture local.
pub fn parse_ddg(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut out: Vec<SearchHit> = Vec::new();
    let mut cursor = 0usize;
    while out.len() < limit {
        let Some(anchor) = html[cursor..].find("result__a\"") else {
            break;
        };
        let start = cursor + anchor;
        let Some(href_pos) = html[start..].find("href=\"") else {
            break;
        };
        let href_start = start + href_pos + 6;
        let Some(href_end_rel) = html[href_start..].find('"') else {
            break;
        };
        let href = &html[href_start..href_start + href_end_rel];
        let Some(gt) = html[href_start..].find('>') else {
            break;
        };
        let title_start = href_start + gt + 1;
        let Some(title_end_rel) = html[title_start..].find("</a>") else {
            break;
        };
        let title_raw = &html[title_start..title_start + title_end_rel];

        let url = decode_ddg_url(href);
        let title = strip_tags(title_raw);
        if !url.is_empty() && !title.is_empty() {
            out.push(SearchHit {
                title,
                url,
                content: String::new(),
            });
        }
        cursor = title_start + title_end_rel + 4;
    }

    // Snippets (`result__snippet`) na ordem em que aparecem.
    let mut snippet_cursor = 0usize;
    for hit in out.iter_mut() {
        let Some(pos) = html[snippet_cursor..].find("result__snippet") else {
            break;
        };
        let start = snippet_cursor + pos;
        let Some(gt) = html[start..].find('>') else {
            break;
        };
        let text_start = start + gt + 1;
        let Some(end_rel) = html[text_start..].find("</a>") else {
            break;
        };
        hit.content = strip_tags(&html[text_start..text_start + end_rel]);
        snippet_cursor = text_start + end_rel + 4;
    }
    out
}

/// `//duckduckgo.com/l/?uddg=<urlencoded>` → URL real.
fn decode_ddg_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(pos) = trimmed.find("uddg=") {
        let encoded = &trimmed[pos + 5..];
        let encoded = encoded.split('&').next().unwrap_or(encoded);
        return urlencoding::decode(encoded)
            .map(|c| c.to_string())
            .unwrap_or_else(|_| encoded.to_string());
    }
    if trimmed.starts_with("http") {
        return trimmed.to_string();
    }
    String::new()
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut inside = false;
    for ch in html.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            c if !inside => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">First &amp; Best</a>
      <a class="result__snippet">Snippet one about the first result</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://second.example/b">Second <b>bold</b></a>
      <a class="result__snippet">Snippet two</a>
    </div>
    "#;

    #[test]
    fn duckduckgo_parser_extracts_hits() {
        let hits = parse_ddg(FIXTURE, 8);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.com/a");
        assert_eq!(hits[0].title, "First & Best");
        assert_eq!(hits[0].content, "Snippet one about the first result");
        assert_eq!(hits[1].url, "https://second.example/b");
        assert_eq!(hits[1].title, "Second bold");
    }

    #[test]
    fn parser_respects_limit_and_empty_html() {
        assert_eq!(parse_ddg(FIXTURE, 1).len(), 1);
        assert!(parse_ddg("", 8).is_empty());
        assert!(parse_ddg("<html>no results</html>", 8).is_empty());
    }

    #[test]
    fn url_decoding_handles_direct_and_wrapped() {
        assert_eq!(decode_ddg_url("https://x.y/z"), "https://x.y/z");
        assert_eq!(
            decode_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.y%2Fz&rut=a"),
            "https://x.y/z"
        );
        assert_eq!(decode_ddg_url("javascript:void(0)"), "");
    }
}
