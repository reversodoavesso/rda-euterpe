//! Persistent, conversation-scoped datasets, selections and resumable operations.
mod data;
mod jobs;

use super::{Annotations, Side, ToolDef};
use crate::{config::Config, protocol::ToolResult, store::Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub use data::{capture_result, document, page, selection_preview};
pub use jobs::{list_operations, recover, start, status};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_sessions(id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS workspace_documents(id TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_documents_session ON workspace_documents(session,kind,created);
CREATE TABLE IF NOT EXISTS workspace_operations(id TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,args TEXT NOT NULL,checkpoint TEXT NOT NULL,result TEXT,error TEXT,updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_operations_session ON workspace_operations(session,updated);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_apply_preview ON workspace_operations(session,json_extract(args,'$.preview_id')) WHERE kind='apply';
CREATE UNIQUE INDEX IF NOT EXISTS workspace_workflow_child ON workspace_operations(session,kind,json_extract(args,'$._workflow_id'),json_extract(args,'$._workflow_stage')) WHERE json_extract(args,'$._workflow_id') IS NOT NULL;
CREATE TABLE IF NOT EXISTS workspace_notes(session TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_chunks(operation_id TEXT NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,position INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(operation_id,kind,position));
"#;

pub const MAX_TOOL_BYTES: usize = 12_000;
pub const MAX_CONTEXT_BYTES: usize = 72_000;
pub const MAX_ROWS: usize = 50_000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub playlist_id: Option<String>,
    pub revision: Option<String>,
    pub complete: bool,
    pub total_items: usize,
    pub rows: Vec<Value>,
    pub source: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Selection {
    pub dataset_id: String,
    pub positions: Vec<usize>,
    pub rules: Value,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub session: String,
    pub kind: String,
    pub status: String,
    pub args: Value,
    pub checkpoint: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub updated: i64,
}

pub fn ensure_session(store: &Store, session: &str) -> anyhow::Result<()> {
    store.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO workspace_sessions(id) VALUES (?)",
            [session],
        )?;
        let active: bool = c.query_row(
            "SELECT active FROM workspace_sessions WHERE id=?",
            [session],
            |r| r.get(0),
        )?;
        if !active {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(())
    })?;
    Ok(())
}

pub fn erase_session(store: &Store, session: &str) -> rusqlite::Result<()> {
    store.with(|c| {
        c.execute("INSERT INTO workspace_sessions(id,active) VALUES (?,0) ON CONFLICT(id) DO UPDATE SET active=0", [session])?;
        for table in ["workspace_documents", "workspace_operations", "workspace_notes","workspace_chunks"] {
            c.execute(&format!("DELETE FROM {table} WHERE session=?"), [session])?;
        }
        Ok(())
    })
}

pub fn put_document<T: Serialize>(
    store: &Store,
    session: &str,
    kind: &str,
    value: &T,
) -> anyhow::Result<String> {
    ensure_session(store, session)?;
    let id = uuid::Uuid::new_v4().to_string();
    let value = serde_json::to_string(value)?;
    anyhow::ensure!(value.len() <= 32 * 1024 * 1024, "dataset_too_large");
    store.with(|c| {
        let changed=c.execute("INSERT INTO workspace_documents SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspace_sessions WHERE id=? AND active=1)", rusqlite::params![id,session,kind,value,chrono::Utc::now().timestamp_millis(),session])?;
        if changed==0 {return Err(rusqlite::Error::InvalidQuery);}
        Ok(())
    })?;
    Ok(id)
}

pub fn load<T: for<'de> Deserialize<'de>>(
    store: &Store,
    session: &str,
    id: &str,
    kind: &str,
) -> anyhow::Result<T> {
    let value: String = store.with(|c| {
        c.query_row(
            "SELECT value FROM workspace_documents WHERE id=? AND session=? AND kind=?",
            rusqlite::params![id, session, kind],
            |r| r.get(0),
        )
    })?;
    Ok(serde_json::from_str(&value)?)
}

pub fn arg<'a>(args: &'a Value, name: &str) -> &'a str {
    args.get(name).and_then(Value::as_str).unwrap_or("")
}

pub fn fail(error: anyhow::Error) -> ToolResult {
    // Do not expose database paths, provider bodies or credentials.
    let message = error.to_string();
    let code = if message.chars().all(|c| c.is_ascii_lowercase() || c == '_') && message.len() < 80
    {
        message.as_str()
    } else {
        "workspace_reference_unavailable"
    };
    ToolResult::err(code)
}

pub fn note(store: &Store, session: &str, value: &Value) -> anyhow::Result<Value> {
    ensure_session(store, session)?;
    let text = serde_json::to_string(value)?;
    anyhow::ensure!(text.len() <= 6000, "context_note_too_large");
    store.with(|c| { c.execute("INSERT INTO workspace_notes VALUES (?,?) ON CONFLICT(session) DO UPDATE SET value=excluded.value", rusqlite::params![session,text])?; Ok(()) })?;
    Ok(json!({"saved":true}))
}

pub fn context_state(store: &Store, session: &str) -> Value {
    let notes: Value = store
        .with(|c| {
            c.query_row(
                "SELECT value FROM workspace_notes WHERE session=?",
                [session],
                |r| r.get::<_, String>(0),
            )
        })
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    let docs: Vec<Value> = store.with(|c| {
        let mut stmt=c.prepare("SELECT id,kind FROM workspace_documents WHERE session=? AND kind IN ('dataset','selection') ORDER BY created DESC LIMIT 16")?;
        let rows=stmt.query_map([session], |r| Ok(json!({"id":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?})))?;
        rows.collect()
    }).unwrap_or_default();
    let operations:Vec<Value>=list_operations(store,session).iter().map(|o|json!({"operation_id":o["operation_id"],"kind":o["kind"],"status":o["status"],"items_processed":o["items_processed"],"total_items":o["total_items"],"error":o["error"]})).collect();
    json!({"notes":notes,"references":docs,"operations":operations})
}

pub fn definitions() -> &'static [ToolDef] {
    static TOOLS: OnceLock<Vec<ToolDef>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let text = || json!({"type":"string","minLength":1});
        let integer = |max| json!({"type":"integer","minimum":0,"maximum":max});
        let mut tools=Vec::new();
        let mut add=|name: &str, description: &str, properties: Value, required: &[&str], destructive: bool| tools.push(ToolDef {
            name:name.into(),description:description.into(),parameters:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),side:Side::Server,
            annotations:Annotations{read_only:["playlist_inspect","dataset_page","context_get"].contains(&name), destructive, idempotent:["playlist_inspect","dataset_page","dataset_query","operation_status","context_get","context_note"].contains(&name), open_world:true},
        });
        add("playlist_inspect", "Inspect playlist version, size and read completeness without loading track metadata into context. Start here for large playlists.", json!({"playlist_id":text()}), &["playlist_id"],false);
        add("playlist_dataset_create", "Start a persistent paginated capture of an entire playlist. Returns operation_id; poll operation_status with wait_ms=1500. Never assume a page is the whole playlist.", json!({"playlist_id":text(),"refresh":{"type":"boolean"}}), &["playlist_id"],false);
        add("playlist_workflow_start", "Run a complete persistent playlist workflow without repeated model polling: capture, optional batched criteria analysis, deterministic selection, global review, preview and optionally user-approved verified application. Default apply=false prepares a preview. Resumes read/analysis checkpoints; uncertain writes are never repeated.", json!({"playlist_id":text(),"criteria":text(),"apply":{"type":"boolean"},"selection_rules":{"type":"object","properties":{"deduplicate":{"type":"boolean"},"sort_by":{"enum":["original","name","artist","album","duration_ms","score"]},"query":text(),"max_tracks":integer(10000),"max_per_artist":integer(10000),"min_score":{"type":"number","minimum":0,"maximum":1}},"additionalProperties":false}}), &["playlist_id","selection_rules"],false);
        add("dataset_page", "Read a bounded page of a stored dataset or archived tool result. Only supplied fields are known; omitted musical traits remain unknown. Cursor belongs to this dataset. format=text returns lossless JSON text chunks for large single records.", json!({"dataset_id":text(),"cursor":text(),"format":{"enum":["compact","text"]},"limit":integer(50),"fields":{"type":"array","items":text(),"maxItems":8}}), &["dataset_id"],false);
        add("dataset_query", "Compute exact statistics, groups, duplicate URIs or text filters on ALL rows in a complete dataset. Result states coverage; filtered large results return a new dataset_id.", json!({"dataset_id":text(),"action":{"enum":["summary","duplicates","group","filter","intersection","difference"]},"field":{"enum":["artists","album","name","explicit"]},"query":text(),"other_dataset_id":text()}), &["dataset_id","action"],false);
        add("selection_build", "Build an immutable selection using deterministic rules. Deduplication preserves first occurrence. Artist limits and ordering are explicit. Analysis results can rank candidates. No Spotify writes.", json!({"dataset_id":text(),"deduplicate":{"type":"boolean"},"sort_by":{"enum":["original","name","artist","album","duration_ms","score"]},"query":text(),"max_tracks":integer(50000),"max_per_artist":integer(50000),"positions":{"type":"array","items":integer(50000),"maxItems":50000},"analysis_id":text(),"min_score":{"type":"number","minimum":0,"maximum":1}}), &["dataset_id"],false);
        add("selection_preview", "Review exact added/removed occurrences, order, counts, rule validation and a bounded sample. A preview_id is required by selection_apply. No writes.", json!({"selection_id":text()}), &["selection_id"],false);
        add("selection_review", "Start a persistent final curatorial review of complete diversity/count statistics plus a bounded sequence sample. Required after a scored analysis selection. Review states missing evidence and sample coverage; it never approves or edits Spotify.", json!({"selection_id":text(),"criteria":text()}), &["selection_id"],false);
        add("selection_apply", "Start applying a previewed selection to its source playlist. Runtime requests real user approval, then checks playlist revision atomically and verifies the exact resulting order. Idempotent by preview_id; never retry an uncertain write.", json!({"preview_id":text()}), &["preview_id"],true);
        add("analysis_start", "Analyze metadata in persisted batches (max 20 tracks) using identical user criteria. Returns operation_id. Scores are subjective; missing musical attributes must be marked unknown. Analysis never changes Spotify.", json!({"dataset_id":text(),"criteria":text(),"batch_size":integer(20)}), &["dataset_id","criteria"],false);
        add("operation_status", "Get persisted progress and result. wait_ms<=1500 avoids busy polling. Interrupted writes are reconciled against Spotify, not repeated. Completed analysis returns coverage and global review.", json!({"operation_id":text(),"wait_ms":integer(1500)}), &["operation_id"],false);
        add("operation_cancel", "Request cancellation. Writes already sent may be uncertain and require reconciliation; cancellation never promises rollback.", json!({"operation_id":text()}), &["operation_id"],false);
        add("operation_resume", "Resume a paused/failed read or analysis from its last checkpoint. A write is never repeated until status reconciliation confirms it was not applied; fresh approval is required.", json!({"operation_id":text()}), &["operation_id"],false);
        add("context_note", "Persist structured conversation goals, criteria, decisions, references and pending approvals. Do not store raw playlist contents or secrets. Replaces the note, maximum 6000 bytes.", json!({"goal":text(),"criteria":{"type":"array","items":text(),"maxItems":20},"decisions":{"type":"array","items":text(),"maxItems":20},"pending":{"type":"array","items":text(),"maxItems":20}}), &["goal"],false);
        add("context_get", "Recover persisted conversation notes, dataset/selection references and operation checkpoints.", json!({}), &[],false);
        tools
    })
}

pub async fn run(
    name: &str,
    args: &Value,
    ctx: &super::server::ServerToolContext<'_>,
) -> ToolResult {
    let Some(store) = ctx.store else {
        return ToolResult::err("workspace_store_required");
    };
    if let Err(e) = ensure_session(store, &ctx.session_id) {
        return fail(e);
    }
    if name == "selection_apply"
        && crate::store::settings::SettingsCache::load(store).is_ok_and(|s| {
            s.effective(ctx.cfg).mutation_policy == crate::config::MutationPolicy::Deny
        })
    {
        return ToolResult::err("mutation_denied");
    }
    let result: anyhow::Result<Value> = match name {
        "playlist_inspect" => data::inspect(ctx, arg(args, "playlist_id")).await,
        "playlist_dataset_create" => jobs::create_dataset(ctx, args).await,
        "playlist_workflow_start" => jobs::create_workflow(ctx,args).await,
        "dataset_page" => data::page(store, &ctx.session_id, args),
        "dataset_query" => data::query(store, &ctx.session_id, args),
        "selection_build" => data::build_selection(store, &ctx.session_id, args),
        "selection_preview" => {
            data::selection_preview(store, &ctx.session_id, arg(args, "selection_id"))
        }
        "selection_review" => jobs::create_review(ctx,args).await,
        "selection_apply" => jobs::create_apply(ctx, args).await,
        "analysis_start" => jobs::create_analysis(ctx, args).await,
        "operation_status" => jobs::wait_status(ctx, args).await,
        "operation_cancel" => jobs::cancel(store, &ctx.session_id, arg(args, "operation_id")),
        "operation_resume" => jobs::resume(ctx, arg(args, "operation_id")).await,
        "context_note" => note(store, &ctx.session_id, args),
        "context_get" => Ok(context_state(store, &ctx.session_id)),
        _ => return ToolResult::err("unknown_workspace_tool"),
    };
    match result {
        Ok(v) => ToolResult::ok(v),
        Err(e) => fail(e),
    }
}

pub fn log(cfg: &Config, session: &str, event: &str, payload: Value) {
    crate::logging::log_session(&cfg.sessions_dir, session, event, Some(payload));
}
