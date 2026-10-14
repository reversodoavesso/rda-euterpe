//! Relatório semanal: junta os dados que o modelo precisa para escrever o resumo.

use super::ServerToolContext;
use crate::protocol::ToolResult;
use serde_json::json;

pub async fn weekly_report(ctx: &ServerToolContext<'_>) -> ToolResult {
    let recents = ctx
        .request_client_tool(
            "weekly_recents",
            "get_listening_recents",
            json!({ "limit": 50, "time_range": "long_term" }),
        )
        .await;
    let saved = ctx
        .request_client_tool("weekly_saved", "get_saved_tracks", json!({}))
        .await;
    ToolResult::ok(json!({
        "recent_tracks": if recents.ok { recents.data.unwrap_or(serde_json::Value::Null) } else { serde_json::Value::Null },
        "saved_tracks": if saved.ok { saved.data.as_ref().and_then(|d| d.as_array()).map(|a| a.len()) } else { None },
    }))
}
