use crate::{
    tools::{server::ServerToolContext, workbench},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};

pub async fn get(
    State(state): State<AppState>,
    Path(session): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    uuid::Uuid::parse_str(&session).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(
        json!({"state":workbench::context_state(&state.store,&session),"operations":workbench::list_operations(&state.store,&session)}),
    ))
}

pub async fn action(
    State(state): State<AppState>,
    Path(session): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    uuid::Uuid::parse_str(&session).map_err(|_| StatusCode::BAD_REQUEST)?;
    let name = body["name"].as_str().ok_or(StatusCode::BAD_REQUEST)?;
    if !workbench::definitions().iter().any(|t| t.name == name) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let ctx = ServerToolContext {
        cfg: &state.cfg,
        store: Some(&state.store),
        bridge: state.bridge.clone(),
        session_id: session,
        locale: "pt-br".into(),
    };
    let result = workbench::run(
        name,
        &body.get("arguments").cloned().unwrap_or(json!({})),
        &ctx,
    )
    .await;
    Ok(Json(
        json!({"ok":result.ok,"data":result.data,"code":result.code}),
    ))
}
