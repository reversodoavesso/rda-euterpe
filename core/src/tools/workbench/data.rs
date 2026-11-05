use super::*;
use crate::tools::server::ServerToolContext;
use std::collections::{BTreeMap, HashMap, HashSet};

pub fn uri(row: &Value) -> &str {
    row.get("uri").and_then(Value::as_str).unwrap_or("")
}
pub fn uris(dataset: &Dataset) -> anyhow::Result<Vec<String>> {
    anyhow::ensure!(
        dataset.complete && dataset.rows.len() == dataset.total_items,
        "incomplete_dataset"
    );
    let values: Vec<String> = dataset.rows.iter().map(|r| uri(r).to_string()).collect();
    anyhow::ensure!(
        values.iter().all(|u| u.starts_with("spotify:") && u.len()>8 && u.len()<=2048),
        "invalid_track_reference"
    );
    Ok(values)
}

pub fn summary(dataset: &Dataset) -> Value {
    let mut seen = HashSet::new();
    let mut duplicates = 0;
    let mut duration = 0u64;
    for row in &dataset.rows {
        let u = uri(row);
        if !u.is_empty() && !seen.insert(u) {
            duplicates += 1;
        }
        duration += row.get("duration_ms").and_then(Value::as_u64).unwrap_or(0);
    }
    json!({"playlist_id":dataset.playlist_id,"revision":dataset.revision,"complete":dataset.complete,
        "items_processed":dataset.rows.len(),"total_items":dataset.total_items,"duplicate_occurrences":duplicates,
        "duration_ms_known":duration,"source":dataset.source})
}

pub fn document(store: &Store, session: &str, dataset: Dataset) -> anyhow::Result<Value> {
    anyhow::ensure!(dataset.rows.len() <= MAX_ROWS, "dataset_too_large");
    let id = put_document(store, session, "dataset", &dataset)?;
    let mut info = summary(&dataset);
    info["dataset_id"] = json!(id);
    info["next_action"]=json!("Use dataset_query for whole-dataset calculations, or dataset_page for bounded details. Only items_processed counts as examined.");
    Ok(info)
}

pub fn capture_result(
    store: &Store,
    session: &str,
    name: &str,
    args: &Value,
    value: &Value,
) -> anyhow::Result<Value> {
    let rows = if let Some(rows) = value.as_array() {
        rows.clone()
    } else {
        ["items", "tracks", "playlists", "results"]
            .iter()
            .find_map(|k| value.get(*k).and_then(Value::as_array).cloned())
            .unwrap_or_else(|| vec![value.clone()])
    };
    let rows_len = rows.len();
    let total = value
        .get("total")
        .or_else(|| value.get("total_items"))
        .and_then(Value::as_u64)
        .unwrap_or(rows_len as u64) as usize;
    let complete = value.get("complete") != Some(&Value::Bool(false))
        && total == rows_len
        && value.get("offset").and_then(Value::as_u64).unwrap_or(0) == 0;
    let mut info = document(
        store,
        session,
        Dataset {
            playlist_id: args
                .get("playlist_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            revision: None,
            complete,
            total_items: total,
            rows,
            source: name.into(),
        },
    )?;
    info["archived"] = json!(true);
    info["inline_items"] = json!(0);
    Ok(info)
}

pub async fn manifest(ctx: &ServerToolContext<'_>, playlist: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(!playlist.is_empty(), "playlist_id_required");
    let res = ctx
        .request_client_tool(
            &format!("manifest_{}", uuid::Uuid::new_v4()),
            "get_playlist_tracks",
            json!({"playlist_id":playlist,"response_format":"manifest"}),
        )
        .await;
    anyhow::ensure!(
        res.ok,
        "{}",
        res.code.unwrap_or_else(|| "playlist_read_failed".into())
    );
    let value = res.data.unwrap_or(Value::Null);
    anyhow::ensure!(
        value["complete"] == true
            && value["revision"].as_str().is_some_and(|v| !v.is_empty())
            && value["uris"].is_array(),
        "versioned_backend_required"
    );
    Ok(value)
}

pub async fn inspect(ctx: &ServerToolContext<'_>, playlist: &str) -> anyhow::Result<Value> {
    let m = manifest(ctx, playlist).await?;
    Ok(
        json!({"playlist_id":playlist,"revision":m["revision"],"total_items":m["total"],"complete":true,"metadata_loaded":false,"next_action":"playlist_dataset_create"}),
    )
}

fn cursor_offset(args: &Value, id: &str) -> anyhow::Result<usize> {
    let cursor = arg(args, "cursor");
    if cursor.is_empty() {
        return Ok(0);
    }
    let (owner, offset) = cursor
        .rsplit_once(':')
        .ok_or_else(|| anyhow::anyhow!("invalid_cursor"))?;
    anyhow::ensure!(owner == id, "invalid_cursor");
    offset
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid_cursor"))
}

pub fn page(store: &Store, session: &str, args: &Value) -> anyhow::Result<Value> {
    let id = arg(args, "dataset_id");
    let d: Dataset = load(store, session, id, "dataset")?;
    if arg(args, "format") == "text" {
        let text = serde_json::to_string(&d.rows)?;
        let offset = cursor_offset(args, id)?;
        anyhow::ensure!(
            offset <= text.len() && text.is_char_boundary(offset),
            "invalid_cursor"
        );
        let chunk = (crate::llm::context::limits().1.saturating_sub(800) / 2).clamp(100, 8000);
        let mut end = (offset + chunk).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(
            json!({"dataset_id":id,"text":&text[offset..end],"offset_bytes":offset,"total_bytes":text.len(),"has_more":end<text.len(),"next_cursor":if end<text.len(){Some(format!("{id}:{end}"))}else{None},"coverage":"text_chunk_only"}),
        );
    }
    let offset = cursor_offset(args, id)?;
    anyhow::ensure!(offset <= d.rows.len(), "invalid_cursor");
    let limit = args["limit"].as_u64().unwrap_or(25).clamp(1, 50) as usize;
    let fields: Vec<&str> = args["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).take(8).collect())
        .unwrap_or_else(|| {
            if d.source.starts_with("analysis:") {
                vec!["uri", "name", "score", "reason", "unknowns"]
            } else {
                vec!["uri", "name", "artists", "album", "duration_ms", "explicit"]
            }
        });
    let mut items = Vec::new();
    let mut bytes = 0;
    for (position, row) in d.rows.iter().enumerate().skip(offset).take(limit) {
        let mut item = serde_json::Map::new();
        item.insert("position".into(), json!(position));
        for field in &fields {
            if let Some(value) = row.get(*field) {
                item.insert((*field).into(), value.clone());
            }
        }
        if item.len() == 1 {
            item.insert("value".into(), row.clone());
        }
        let value = Value::Object(item);
        let size = serde_json::to_vec(&value)?.len();
        if bytes + size
            > crate::llm::context::limits()
                .1
                .saturating_sub(1200)
                .max(200)
        {
            anyhow::ensure!(!items.is_empty(), "row_too_large_select_fewer_fields");
            break;
        }
        bytes += size;
        items.push(value);
    }
    let next = offset + items.len();
    Ok(
        json!({"dataset_id":id,"offset":offset,"items":items,"items_returned":next-offset,"items_processed":d.rows.len(),"total_items":d.total_items,
        "complete":d.complete,"has_more":next<d.rows.len(),"next_cursor":if next<d.rows.len(){Some(format!("{id}:{next}"))}else{None},"coverage":"page_only"}),
    )
}

fn searchable(row: &Value) -> String {
    ["name", "artists", "album", "uri"]
        .iter()
        .filter_map(|k| row.get(*k))
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn query(store: &Store, session: &str, args: &Value) -> anyhow::Result<Value> {
    let id = arg(args, "dataset_id");
    let d: Dataset = load(store, session, id, "dataset")?;
    anyhow::ensure!(
        d.complete && d.rows.len() == d.total_items,
        "incomplete_dataset"
    );
    match arg(args, "action") {
        "summary" => {
            let mut s = summary(&d);
            s["dataset_id"] = json!(id);
            Ok(s)
        }
        "group" => {
            let field = arg(args, "field");
            anyhow::ensure!(
                ["artists", "album", "name", "explicit"].contains(&field),
                "invalid_group_field"
            );
            let mut groups: BTreeMap<String, usize> = BTreeMap::new();
            let mut unknown = 0;
            for row in &d.rows {
                match row.get(field).filter(|v| !v.is_null()) {
                    Some(v) => *groups.entry(v.to_string()).or_default() += 1,
                    None => unknown += 1,
                }
            }
            let total = groups.len();
            let mut rows: Vec<Value> = groups
                .into_iter()
                .map(|(value, count)| json!({"value":value,"count":count}))
                .collect();
            rows.sort_by_key(|r| std::cmp::Reverse(r["count"].as_u64().unwrap_or(0)));
            let grouped = document(
                store,
                session,
                Dataset {
                    playlist_id: None,
                    revision: None,
                    complete: true,
                    total_items: rows.len(),
                    rows,
                    source: format!("group:{id}:{field}"),
                },
            )?;
            Ok(
                json!({"dataset_id":grouped["dataset_id"],"group_count":total,"unknown":unknown,"items_processed":d.total_items,"total_items":d.total_items,"complete":true}),
            )
        }
        action => {
            let mut rows = Vec::new();
            let mut seen = HashSet::new();
            let other = if ["intersection", "difference"].contains(&action) {
                let other: Dataset =
                    load(store, session, arg(args, "other_dataset_id"), "dataset")?;
                uris(&other)?.into_iter().collect::<HashSet<_>>()
            } else {
                HashSet::new()
            };
            let q = arg(args, "query").to_lowercase();
            for row in &d.rows {
                let keep = match action {
                    "duplicates" => !uri(row).is_empty() && !seen.insert(uri(row).to_string()),
                    "filter" => searchable(row).contains(&q),
                    "intersection" => other.contains(uri(row)),
                    "difference" => !other.contains(uri(row)),
                    _ => anyhow::bail!("invalid_dataset_action"),
                };
                if keep {
                    rows.push(row.clone());
                }
            }
            let count = rows.len();
            let result = document(
                store,
                session,
                Dataset {
                    playlist_id: d.playlist_id,
                    revision: d.revision,
                    complete: true,
                    total_items: count,
                    rows,
                    source: format!("query:{action}:{id}"),
                },
            )?;
            Ok(
                json!({"dataset_id":result["dataset_id"],"matched":count,"items_processed":d.total_items,"total_items":d.total_items,"complete":true}),
            )
        }
    }
}

pub fn build_selection(store: &Store, session: &str, args: &Value) -> anyhow::Result<Value> {
    let id = arg(args, "dataset_id");
    let d: Dataset = load(store, session, id, "dataset")?;
    uris(&d)?;
    let analysis = arg(args, "analysis_id");
    let mut scores: HashMap<usize, f64> = HashMap::new();
    if !analysis.is_empty() {
        let op = jobs::get(store, session, analysis)?;
        anyhow::ensure!(
            op.status == "completed" && arg(&op.args, "dataset_id") == id && op.kind == "analysis",
            "analysis_incomplete_or_wrong_dataset"
        );
        {
            for row in jobs::analysis_scores(store,session,analysis)? {
                if let (Some(p), Some(score)) = (row["position"].as_u64(), row["score"].as_f64()) {
                    scores.insert(p as usize, score);
                }
            }
        }
        anyhow::ensure!(
            scores.len() == d.rows.len(),
            "analysis_incomplete_or_wrong_dataset"
        );
    }
    let mut positions: Vec<usize> = if let Some(p) = args["positions"].as_array() {
        p.iter()
            .map(|v| {
                v.as_u64()
                    .filter(|p| (*p as usize) < d.rows.len())
                    .map(|p| p as usize)
                    .ok_or_else(|| anyhow::anyhow!("invalid_selection_position"))
            })
            .collect::<anyhow::Result<_>>()?
    } else {
        (0..d.rows.len()).collect()
    };
    let mut unique = HashSet::new();
    anyhow::ensure!(
        positions.iter().all(|p| unique.insert(*p)),
        "duplicate_selection_position"
    );
    let q = arg(args, "query").to_lowercase();
    positions.retain(|p| q.is_empty() || searchable(&d.rows[*p]).contains(&q));
    if args.get("min_score").is_some() {
        anyhow::ensure!(!analysis.is_empty(), "analysis_required");
        let threshold = args["min_score"]
            .as_f64()
            .filter(|n| (0.0..=1.0).contains(n))
            .ok_or_else(|| anyhow::anyhow!("invalid_min_score"))?;
        positions.retain(|p| scores.get(p).copied().unwrap_or(0.0) >= threshold);
    }
    let sort = arg(args, "sort_by");
    if sort == "score" {
        anyhow::ensure!(!analysis.is_empty(), "analysis_required");
        positions.sort_by(|a, b| scores[b].total_cmp(&scores[a]).then(a.cmp(b)));
    } else if !sort.is_empty() && sort != "original" {
        let field = match sort {
            "artist" => "artists",
            "name" => "name",
            "album" => "album",
            "duration_ms" => "duration_ms",
            _ => anyhow::bail!("invalid_sort_field"),
        };
        positions.sort_by(|a, b| {
            if field == "duration_ms" {
                d.rows[*a][field]
                    .as_u64()
                    .cmp(&d.rows[*b][field].as_u64())
                    .then(a.cmp(b))
            } else {
                d.rows[*a][field]
                    .to_string()
                    .to_lowercase()
                    .cmp(&d.rows[*b][field].to_string().to_lowercase())
                    .then(a.cmp(b))
            }
        });
    }
    let mut seen = HashSet::new();
    if args["deduplicate"] == true {
        positions.retain(|p| seen.insert(uri(&d.rows[*p]).to_string()));
    }
    let artist_limit = args["max_per_artist"].as_u64().unwrap_or(u64::MAX) as usize;
    let mut artists: HashMap<String, usize> = HashMap::new();
    if args.get("max_per_artist").is_some() {
        anyhow::ensure!(
            positions.iter().all(|p| d.rows[*p]["artists"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .is_some()),
            "artist_metadata_required_for_diversity"
        );
    }
    positions.retain(|p| {
        let keys: HashSet<String> = d.rows[*p]["artists"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if keys
            .iter()
            .any(|key| artists.get(key).copied().unwrap_or(0) >= artist_limit)
        {
            return false;
        }
        for key in keys {
            *artists.entry(key).or_default() += 1;
        }
        true
    });
    if let Some(max) = args["max_tracks"].as_u64() {
        positions.truncate(max.min(MAX_ROWS as u64) as usize);
    }
    let count = positions.len();
    let selection = Selection {
        dataset_id: id.into(),
        positions,
        rules: args.clone(),
    };
    let selection_id = put_document(store, session, "selection", &selection)?;
    Ok(
        json!({"selection_id":selection_id,"dataset_id":id,"selected":count,"items_processed":d.rows.len(),"total_items":d.total_items,"complete":true,"next_action":"selection_preview"}),
    )
}

pub fn selection_preview(store: &Store, session: &str, id: &str) -> anyhow::Result<Value> {
    let s: Selection = load(store, session, id, "selection")?;
    let d: Dataset = load(store, session, &s.dataset_id, "dataset")?;
    let before = uris(&d)?;
    let after: Vec<String> = s
        .positions
        .iter()
        .map(|p| {
            before
                .get(*p)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("invalid_selection_position"))
        })
        .collect::<anyhow::Result<_>>()?;
    let mut old: HashMap<&str, usize> = HashMap::new();
    let mut new: HashMap<&str, usize> = HashMap::new();
    for u in &before {
        *old.entry(u).or_default() += 1;
    }
    for u in &after {
        *new.entry(u).or_default() += 1;
    }
    let removed: usize = old
        .iter()
        .map(|(u, n)| n.saturating_sub(*new.get(u).unwrap_or(&0)))
        .sum();
    let added: usize = new
        .iter()
        .map(|(u, n)| n.saturating_sub(*old.get(u).unwrap_or(&0)))
        .sum();
    let reordered = s.positions.windows(2).any(|p| p[0] > p[1]);
    let preview = json!({"selection_id":id,"dataset_id":s.dataset_id,"playlist_id":d.playlist_id,"revision":d.revision,
        "before":before.len(),"after":after.len(),"removed_occurrences":removed,"added_occurrences":added,"reordered":reordered,
        "sample":s.positions.iter().take(8).map(|p|json!({"position":p,"uri":before[*p],"name":d.rows[*p]["name"],"artists":d.rows[*p]["artists"]})).collect::<Vec<_>>(),
        "rules":s.rules,"complete":true,"items_processed":before.len(),"validation":{"all_references_valid":true,"order_and_repetitions_preserved":true},
        "approval_required":true,"review_required":!arg(&s.rules,"analysis_id").is_empty()});
    let preview_id = put_document(store, session, "preview", &preview)?;
    let mut out = preview;
    out["preview_id"] = json!(preview_id);
    Ok(out)
}
