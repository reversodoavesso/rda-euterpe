mod common;
use common::*;
use euterpe::{
    llm::{canonical::Msg, context},
    protocol::Decision,
    store::Store,
    tools::{server::ServerToolContext, workbench as wb},
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn rows(n: usize) -> Vec<Value> {
    (0..n).map(|i|json!({"uri":format!("spotify:track:{}",i%1000),"name":format!("Faixa {i}"),"artists":[format!("Artista {}",i%10)],"album":format!("Álbum {}",i/10),"duration_ms":180000,"explicit":false})).collect()
}
struct Backend {
    rows: Vec<Value>,
    revision: String,
    offsets: Vec<usize>,
    writes: usize,
    fail_offset: Option<usize>,
    lost_write: bool,
    delay_ms: u64,
}
#[derive(Clone)]
struct Spotify(Arc<Mutex<Backend>>);
impl Respond for Spotify {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        let args = &body["args"];
        let mut b = self.0.lock().unwrap();
        if body["name"] == "replace_playlist_tracks" {
            if args["expected_revision"] != b.revision {
                return ResponseTemplate::new(200)
                    .set_body_json(json!({"ok":false,"code":"playlist_version_conflict"}));
            }
            b.writes += 1;
            b.rows = args["uris"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| json!({"uri":u,"name":"Confirmada","artists":["Artista"]}))
                .collect();
            b.revision = "next".into();
            if b.lost_write {
                return ResponseTemplate::new(503);
            }
            return ResponseTemplate::new(200)
                .set_body_json(json!({"ok":true,"data":{"replaced":b.rows.len()}}));
        }
        let value = match args["response_format"].as_str() {
            Some("manifest") => {
                json!({"revision":b.revision,"total":b.rows.len(),"uris":b.rows.iter().map(|r|r["uri"].clone()).collect::<Vec<_>>(),"complete":true})
            }
            Some("page") => {
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                b.offsets.push(offset);
                if b.fail_offset == Some(offset) {
                    return ResponseTemplate::new(200)
                        .set_body_json(json!({"ok":false,"code":"headless_unavailable"}));
                }
                let end = (offset + 50).min(b.rows.len());
                json!({"revision":b.revision,"total":b.rows.len(),"offset":offset,"next_offset":if end<b.rows.len(){Some(end)}else{None},"complete":end==b.rows.len(),"items":b.rows[offset..end]})
            }
            _ => json!(b.rows),
        };
        ResponseTemplate::new(200)
            .set_body_json(json!({"ok":true,"data":value}))
            .set_delay(std::time::Duration::from_millis(
                if args["response_format"] == "page" {
                    b.delay_ms
                } else {
                    0
                },
            ))
    }
}
async fn backend(n: usize) -> (MockServer, Arc<Mutex<Backend>>) {
    let server = MockServer::start().await;
    let state = Arc::new(Mutex::new(Backend {
        rows: rows(n),
        revision: "initial".into(),
        offsets: vec![],
        writes: 0,
        fail_offset: None,
        lost_write: false,
        delay_ms: 0,
    }));
    Mock::given(path("/tools/call"))
        .respond_with(Spotify(state.clone()))
        .mount(&server)
        .await;
    Mock::given(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"supported_tools":["get_playlist_tracks","replace_playlist_tracks"]}),
        ))
        .mount(&server)
        .await;
    (server, state)
}
fn ctx<'a>(d: &'a TestDaemon, s: &str) -> ServerToolContext<'a> {
    ServerToolContext {
        cfg: &d.state.cfg,
        store: Some(&d.state.store),
        bridge: d.state.bridge.clone(),
        locale: "pt-br".into(),
        session_id: s.into(),
    }
}
async fn run(d: &TestDaemon, s: &str, name: &str, args: Value) -> Value {
    let result = wb::run(name, &args, &ctx(d, s)).await;
    assert!(result.ok, "{name}: {:?}", result.code);
    result.data.unwrap()
}
async fn wait(d: &TestDaemon, s: &str, id: &str) -> Value {
    for _ in 0..100 {
        let status = run(
            d,
            s,
            "operation_status",
            json!({"operation_id":id,"wait_ms":100}),
        )
        .await;
        if !["queued", "running", "verifying"].contains(&status["status"].as_str().unwrap_or("")) {
            return status;
        }
    }
    panic!("operation did not settle");
}
async fn capture(d: &TestDaemon, s: &str) -> String {
    let start = run(d, s, "playlist_dataset_create", json!({"playlist_id":"p"})).await;
    let result = wait(d, s, start["operation_id"].as_str().unwrap()).await;
    assert_eq!(result["status"], "completed", "{result}");
    result["result"]["dataset_id"].as_str().unwrap().into()
}
async fn preview(d: &TestDaemon, s: &str, dataset: &str) -> Value {
    let selection = run(
        d,
        s,
        "selection_build",
        json!({"dataset_id":dataset,"deduplicate":true,"max_tracks":30}),
    )
    .await;
    run(
        d,
        s,
        "selection_preview",
        json!({"selection_id":selection["selection_id"]}),
    )
    .await
}
async fn approve(d: &TestDaemon) {
    for _ in 0..100 {
        if let Some(p) = d.state.bridge.pending_proposals().first() {
            assert!(d
                .state
                .bridge
                .resolve_proposal(p["proposalId"].as_str().unwrap(), Decision::Approve));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("missing proposal");
}
async fn settle(d: &TestDaemon, s: &str, id: &str) -> Value {
    for _ in 0..200 {
        let result = wait(d, s, id).await;
        if ["completed", "failed", "cancelled", "uncertain"]
            .contains(&result["status"].as_str().unwrap_or(""))
        {
            return result;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("approved operation did not settle");
}

#[tokio::test]
async fn large_playlist_capture_is_complete_cached_and_context_bounded() {
    let (server, b) = backend(1050).await;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let id = capture(&d, "s").await;
    let summary = run(
        &d,
        "s",
        "dataset_query",
        json!({"dataset_id":id,"action":"summary"}),
    )
    .await;
    assert_eq!(summary["items_processed"], 1050);
    assert_eq!(summary["duplicate_occurrences"], 50);
    let cached = run(
        &d,
        "s",
        "playlist_dataset_create",
        json!({"playlist_id":"p"}),
    )
    .await;
    assert_eq!(cached["dataset_id"], id);
    assert_eq!(cached["cache_hit"], true);
    assert_eq!(b.lock().unwrap().offsets.len(), 21);
    let first = run(&d, "s", "dataset_page", json!({"dataset_id":id,"limit":50})).await;
    assert_eq!(first["coverage"], "page_only");
    assert!(first["items_returned"].as_u64().unwrap() <= 50);
    assert!(first.to_string().len() < 12000);
    let raw = json!(rows(1050));
    let bounded = context::bounded_result(
        &d.state.store,
        "s",
        "get_playlist_tracks",
        &json!({"playlist_id":"p"}),
        &raw,
    )
    .unwrap();
    assert!(bounded.to_string().len() * 100 < raw.to_string().len());
    let mut messages = vec![
        Msg::system("instructions"),
        Msg::user("Preserve the first occurrence and original order."),
        Msg::tool("call", raw.to_string()),
    ];
    let metrics = context::prepare(&d.state.store, "s", &mut messages, &[]).unwrap();
    assert!(metrics["after_bytes"].as_u64().unwrap() < 72000);
    let preserved = run(
        &d,
        "s",
        "selection_build",
        json!({"dataset_id":id,"deduplicate":true}),
    )
    .await;
    let preview = run(
        &d,
        "s",
        "selection_preview",
        json!({"selection_id":preserved["selection_id"]}),
    )
    .await;
    assert_eq!(preview["before"], 1050);
    assert_eq!(preview["after"], 1000);
    assert_eq!(preview["removed_occurrences"], 50);
    assert_eq!(preview["reordered"], false);
}

#[tokio::test]
async fn failed_capture_resumes_from_checkpoint_and_never_mixes_versions() {
    let (server, b) = backend(151).await;
    b.lock().unwrap().fail_offset = Some(50);
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let op = run(
        &d,
        "s",
        "playlist_dataset_create",
        json!({"playlist_id":"p"}),
    )
    .await;
    let id = op["operation_id"].as_str().unwrap();
    let failed = wait(&d, "s", id).await;
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["items_processed"], 50);
    b.lock().unwrap().fail_offset = None;
    run(&d, "s", "operation_resume", json!({"operation_id":id})).await;
    assert_eq!(wait(&d, "s", id).await["status"], "completed");
    assert_eq!(b.lock().unwrap().offsets, vec![0, 50, 50, 100, 150]);
    // Cached rows from the old version cannot be used to overwrite a changed playlist.
    let dataset = wait(&d, "s", id).await["result"]["dataset_id"]
        .as_str()
        .unwrap()
        .to_string();
    let p = preview(&d, "s", &dataset).await;
    b.lock().unwrap().revision = "external".into();
    let op = run(
        &d,
        "s",
        "selection_apply",
        json!({"preview_id":p["preview_id"]}),
    )
    .await;
    assert_eq!(
        wait(&d, "s", op["operation_id"].as_str().unwrap()).await["error"],
        "playlist_version_conflict"
    );
    assert_eq!(b.lock().unwrap().writes, 0);
}

#[tokio::test]
async fn approval_is_required_and_version_is_checked_after_approval() {
    let (server, b) = backend(80).await;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let dataset = capture(&d, "s").await;
    let p = preview(&d, "s", &dataset).await;
    let op = run(
        &d,
        "s",
        "selection_apply",
        json!({"preview_id":p["preview_id"]}),
    )
    .await;
    let id = op["operation_id"].as_str().unwrap();
    let waiting = wait(&d, "s", id).await;
    assert_eq!(waiting["status"], "awaiting_approval");
    assert_eq!(b.lock().unwrap().writes, 0);
    // Change occurs while the user is reviewing the proposal.
    b.lock().unwrap().revision = "concurrent".into();
    approve(&d).await;
    let end = settle(&d, "s", id).await;
    assert_eq!(end["status"], "failed");
    assert_eq!(end["error"], "playlist_version_conflict");
    assert_eq!(b.lock().unwrap().writes, 0);
}

#[tokio::test]
async fn applying_preview_twice_writes_once_and_verifies_exact_order() {
    let (server, b) = backend(80).await;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let dataset = capture(&d, "s").await;
    let p = preview(&d, "s", &dataset).await;
    let op = run(
        &d,
        "s",
        "selection_apply",
        json!({"preview_id":p["preview_id"]}),
    )
    .await;
    let duplicate = run(
        &d,
        "s",
        "selection_apply",
        json!({"preview_id":p["preview_id"]}),
    )
    .await;
    assert_eq!(op["operation_id"], duplicate["operation_id"]);
    approve(&d).await;
    let end = settle(&d, "s", op["operation_id"].as_str().unwrap()).await;
    assert_eq!(end["status"], "completed");
    assert_eq!(end["result"]["verified"], true);
    assert_eq!(b.lock().unwrap().writes, 1);
    let state = b.lock().unwrap();
    assert_eq!(state.rows.len(), 30);
    assert_eq!(state.rows[0]["uri"], "spotify:track:0");
    assert_eq!(state.rows[29]["uri"], "spotify:track:29");
}

#[tokio::test]
async fn lost_write_is_reconciled_without_repeating_the_mutation() {
    let (server, b) = backend(80).await;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let dataset = capture(&d, "s").await;
    let p = preview(&d, "s", &dataset).await;
    b.lock().unwrap().lost_write = true;
    let op = run(
        &d,
        "s",
        "selection_apply",
        json!({"preview_id":p["preview_id"]}),
    )
    .await;
    approve(&d).await;
    let end = settle(&d, "s", op["operation_id"].as_str().unwrap()).await;
    // status reconciles the uncertain write against the exact intended sequence.
    assert_eq!(end["status"], "completed");
    assert_eq!(end["result"]["reconciled"], true);
    assert_eq!(b.lock().unwrap().writes, 1);
}

#[tokio::test]
async fn references_are_scoped_and_deleting_a_conversation_cannot_resurrect_data() {
    let d = spawn().await;
    let s = uuid::Uuid::new_v4().to_string();
    let document = wb::document(
        &d.state.store,
        &s,
        wb::Dataset {
            playlist_id: None,
            revision: None,
            complete: true,
            total_items: 2,
            rows: rows(2),
            source: "test".into(),
        },
    )
    .unwrap();
    let id = document["dataset_id"].as_str().unwrap();
    assert!(
        !wb::run("dataset_page", &json!({"dataset_id":id}), &ctx(&d, "other"))
            .await
            .ok
    );
    // Reading history must not erase workspace documents.
    assert!(d
        .http()
        .get(format!("{}/history/{s}", d.base()))
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert!(
        wb::run("dataset_page", &json!({"dataset_id":id}), &ctx(&d, &s))
            .await
            .ok
    );
    assert!(d
        .http()
        .delete(format!("{}/history/{s}", d.base()))
        .bearer_auth(d.secret())
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert!(wb::ensure_session(&d.state.store, &s).is_err());
    assert!(wb::document(
        &d.state.store,
        &s,
        wb::Dataset {
            playlist_id: None,
            revision: None,
            complete: true,
            total_items: 0,
            rows: vec![],
            source: "late_job".into()
        }
    )
    .is_err());
}

#[test]
fn checkpoints_survive_restart_and_partial_samples_are_not_complete() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("work.db");
    let store = Store::open(&path).unwrap();
    wb::ensure_session(&store, "s").unwrap();
    store.with(|c|{c.execute("INSERT INTO workspace_operations VALUES ('read','s','dataset','running','{}','{\"offset\":50,\"total\":1050}',NULL,NULL,0)",[])?;c.execute("INSERT INTO workspace_operations VALUES ('write','s','apply','awaiting_approval','{\"preview_id\":\"p\"}','{}',NULL,NULL,0)",[])?;Ok(())}).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    wb::recover(&store).unwrap();
    assert_eq!(wb::status(&store, "s", "read").unwrap()["status"], "paused");
    assert_eq!(
        wb::status(&store, "s", "read").unwrap()["items_processed"],
        50
    );
    assert_eq!(
        wb::status(&store, "s", "write").unwrap()["status"],
        "uncertain"
    );
    let archived = wb::capture_result(
        &store,
        "s",
        "get_playlists",
        &json!({}),
        &json!({"total":1050,"items":rows(50)}),
    )
    .unwrap();
    assert_eq!(archived["complete"], false);
    assert_eq!(archived["items_processed"], 50);
    assert_eq!(archived["total_items"], 1050);
}

#[derive(Clone)]
struct Analyst(Arc<Mutex<Vec<usize>>>);
impl Respond for Analyst {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&req.body).unwrap();
        let input: Value = serde_json::from_str(
            body["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        if input.get("metrics").is_some(){
            return ResponseTemplate::new(200).set_body_json(json!({"choices":[{"message":{"content":json!({"coherence_notes":["Critérios limitados aos metadados."],"sequence_notes":["A sequência foi amostrada."],"missing_evidence":["Características sonoras não fornecidas."],"warnings":[]}).to_string()}}],"usage":{"prompt_tokens":100,"completion_tokens":100}}));
        }
        let rows = input["tracks"].as_array().unwrap();
        assert!(rows.len() <= 20);
        assert!(req.body.len() < 16000);
        self.0
            .lock()
            .unwrap()
            .push(rows[0]["position"].as_u64().unwrap() as usize);
        let scores:Vec<Value>=rows.iter().map(|t|json!({"position":t["position"],"score":0.8,"reason":"Correspondência baseada no nome fornecido.","basis_fields":["name"],"unknowns":["genre","sound"]})).collect();
        ResponseTemplate::new(200).set_body_json(json!({"choices":[{"message":{"content":json!({"scores":scores}).to_string()}}],"usage":{"prompt_tokens":100,"completion_tokens":100}}))
    }
}
#[tokio::test]
async fn subjective_analysis_uses_bounded_batches_and_preserves_evidence() {
    let (server, _) = backend(45).await;
    let llm = MockServer::start().await;
    let seen = Arc::new(Mutex::new(vec![]));
    Mock::given(method("POST"))
        .respond_with(Analyst(seen.clone()))
        .mount(&llm)
        .await;
    let d=spawn_with(|c|{c.headless_url=server.uri();let provider: euterpe::config::ProviderConfig=serde_json::from_value(json!({"id":"analysis-test","base_url":llm.uri(),"kind":"openai-compat","defaultModel":"m"})).unwrap();c.providers.push(provider);c.active_provider="analysis-test".into();c.active_model="m".into();}).await;
    let dataset = capture(&d, "s").await;
    let op=run(&d,"s","analysis_start",json!({"dataset_id":dataset,"criteria":"Classifique apenas pelo nome; marque características sonoras como desconhecidas."})).await;
    let end = wait(&d, "s", op["operation_id"].as_str().unwrap()).await;
    assert_eq!(end["status"], "completed", "{end}");
    assert_eq!(*seen.lock().unwrap(), vec![0, 20, 40]);
    assert_eq!(end["result"]["items_processed"], 45);
    assert_eq!(end["result"]["metadata_evidence_count"], 45);
    let selection=run(&d,"s","selection_build",json!({"dataset_id":dataset,"analysis_id":op["operation_id"],"min_score":0.7,"sort_by":"score","max_per_artist":2,"max_tracks":20})).await;
    assert_eq!(selection["selected"], 20);
    let p=run(&d,"s","selection_preview",json!({"selection_id":selection["selection_id"]})).await;
    assert_eq!(p["review_required"],true);
    let blocked=run(&d,"s","selection_apply",json!({"preview_id":p["preview_id"]})).await;
    assert_eq!(wait(&d,"s",blocked["operation_id"].as_str().unwrap()).await["error"],"selection_review_required");
    let review=run(&d,"s","selection_review",json!({"selection_id":selection["selection_id"]})).await;
    let end=wait(&d,"s",review["operation_id"].as_str().unwrap()).await;
    assert_eq!(end["status"],"completed","{end}");
    assert_eq!(end["result"]["metrics"]["deterministic_coverage"],"complete");
    assert_eq!(end["result"]["metrics"]["semantic_coverage"],"sample_and_aggregate_only");
}

#[tokio::test]
async fn cancellation_stops_capture_at_a_safe_boundary() {
    let (server, b) = backend(1000).await;
    b.lock().unwrap().delay_ms = 100;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let op = run(
        &d,
        "s",
        "playlist_dataset_create",
        json!({"playlist_id":"p"}),
    )
    .await;
    let id = op["operation_id"].as_str().unwrap();
    run(&d, "s", "operation_cancel", json!({"operation_id":id})).await;
    let result = settle(&d, "s", id).await;
    assert_eq!(result["status"], "cancelled");
    assert!(result["result"].is_null());
    assert!(b.lock().unwrap().offsets.len() <= 1);
}

#[test]
fn archived_unicode_is_recoverable_without_splitting_utf8_or_claiming_complete_analysis() {
    let store = Store::in_memory().unwrap();
    let raw = json!("ação e seleção ".repeat(4000));
    let archived = wb::capture_result(&store, "s", "long_text", &json!({}), &raw).unwrap();
    let id = archived["dataset_id"].as_str().unwrap();
    let mut cursor = String::new();
    let mut text = String::new();
    loop {
        let page = wb::page(
            &store,
            "s",
            &json!({"dataset_id":id,"format":"text","cursor":cursor}),
        )
        .unwrap();
        text.push_str(page["text"].as_str().unwrap());
        assert!(page.to_string().len() <= 12000);
        if page["has_more"] == false {
            break;
        }
        cursor = page["next_cursor"].as_str().unwrap().into();
    }
    let recovered: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert_eq!(recovered, vec![raw]);
}

#[tokio::test]
async fn workflow_end_to_end_deterministic_preview_without_polling() {
    let (server, _) = backend(1050).await;
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let start = run(
        &d,
        "s",
        "playlist_workflow_start",
        json!({
            "playlist_id": "p",
            "selection_rules": {
                "deduplicate": true,
                "max_tracks": 100
            },
            "apply": false
        }),
    )
    .await;
    let id = start["operation_id"].as_str().unwrap();
    let result = settle(&d, "s", id).await;
    assert_eq!(result["status"], "completed", "{result}");
    assert_eq!(result["result"]["applied"], false);
    assert_eq!(result["result"]["preview"]["before"], 1050);
    assert_eq!(result["result"]["preview"]["after"], 100);
    assert_eq!(result["result"]["preview"]["removed_occurrences"], 950);
}

#[tokio::test]
async fn failed_workflow_resumes_its_child_and_waits_for_completion() {
    let (server, b) = backend(150).await;
    b.lock().unwrap().fail_offset = Some(50);
    let d = spawn_with(|c| c.headless_url = server.uri()).await;
    let start = run(&d, "s", "playlist_workflow_start", json!({
        "playlist_id":"p", "selection_rules":{"max_tracks":30}, "apply":false
    })).await;
    let id = start["operation_id"].as_str().unwrap();
    let failed = settle(&d, "s", id).await;
    assert_eq!(failed["status"], "failed", "{failed}");
    b.lock().unwrap().fail_offset = None;
    run(&d, "s", "operation_resume", json!({"operation_id":id})).await;
    let completed = settle(&d, "s", id).await;
    assert_eq!(completed["status"], "completed", "{completed}");
    assert_eq!(completed["result"]["preview"]["after"], 30);
    assert_eq!(b.lock().unwrap().writes, 0);
}

#[tokio::test]
async fn workflow_with_criteria_and_approval_executes_review_and_verifies_write() {
    let (server, b) = backend(45).await;
    let llm = MockServer::start().await;
    let seen = Arc::new(Mutex::new(vec![]));
    Mock::given(method("POST"))
        .respond_with(Analyst(seen.clone()))
        .mount(&llm)
        .await;
    let d = spawn_with(|c| {
        c.headless_url = server.uri();
        let provider: euterpe::config::ProviderConfig = serde_json::from_value(json!({
            "id": "analysis-test",
            "base_url": llm.uri(),
            "kind": "openai-compat",
            "defaultModel": "m"
        }))
        .unwrap();
        c.providers.push(provider);
        c.active_provider = "analysis-test".into();
        c.active_model = "m".into();
    })
    .await;

    let start = run(
        &d,
        "s",
        "playlist_workflow_start",
        json!({
            "playlist_id": "p",
            "criteria": "Selecione faixas animadas com base no título.",
            "selection_rules": {
                "deduplicate": true,
                "min_score": 0.7,
                "max_per_artist": 2,
                "max_tracks": 15
            },
            "apply": true
        }),
    )
    .await;
    let id = start["operation_id"].as_str().unwrap();

    let waiting = wait(&d, "s", id).await;
    assert_eq!(waiting["status"], "awaiting_approval");
    approve(&d).await;

    let end = settle(&d, "s", id).await;
    assert_eq!(end["status"], "completed", "{end}");
    assert_eq!(end["result"]["applied"], true);
    assert_eq!(end["result"]["apply_result"]["verified"], true);
    assert_eq!(b.lock().unwrap().writes, 1);
    assert_eq!(b.lock().unwrap().rows.len(), 15);
}
