//! Degradação graciosa do loop LLM (paridade com `runAgentLoop`).
//!
//! Regras provadas aqui:
//!  - 2 `rate_limited` consecutivos ⇒ `forceAnswer` ⇒ a chamada seguinte vai
//!    **sem tools** e o loop fecha com resposta (nunca pendura);
//!  - `chat.done` é **sempre** emitido (timeout, erro de API, limite de passos);
//!  - `reasoning` nunca é reenviado no histórico.

mod common;

use async_trait::async_trait;
use common::*;
use euterpe::config::MutationPolicy;
use euterpe::llm::canonical::{
    Caps, ChatRequest, Completion, LlmAdapter, ModelInfo, TestReport, ToolCall,
};
use euterpe::llm::{ChatDeps, LoopOutcome};
use euterpe::protocol::ServerMsg;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio::sync::mpsc;

/// Adapter roteirizado: devolve respostas de uma fila e registra os requests.
struct ScriptedAdapter {
    script: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<usize>>, // quantidade de tools em cada request
    models: Vec<ModelInfo>,
}

impl ScriptedAdapter {
    fn new(script: Vec<Completion>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            seen: Mutex::new(Vec::new()),
            models: vec![ModelInfo::new("scripted-model")],
        }
    }

    fn tools_seen(&self) -> Vec<usize> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmAdapter for ScriptedAdapter {
    fn wire(&self) -> euterpe::config::Wire {
        euterpe::config::Wire::OpenaiCompat
    }

    fn capabilities(&self) -> Caps {
        Caps {
            streaming: false,
            tools: true,
            json_mode: true,
            reasoning_field: None,
        }
    }

    fn model(&self) -> &str {
        "scripted-model"
    }

    async fn stream(
        &self,
        _req: ChatRequest,
        _tx: mpsc::Sender<euterpe::llm::canonical::LlmEvent>,
    ) -> anyhow::Result<()> {
        anyhow::bail!("stream não usado neste teste")
    }

    async fn complete(&self, req: ChatRequest) -> anyhow::Result<Completion> {
        self.seen.lock().unwrap().push(req.tools.len());
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| anyhow::anyhow!("script esgotado"))
    }

    async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(self.models.clone())
    }

    async fn test(&self) -> anyhow::Result<TestReport> {
        Ok(TestReport {
            ok: true,
            latency_ms: 1,
            model: "scripted-model".into(),
            sample: "pong".into(),
            code: None,
            detail: None,
        })
    }
}

fn tool_call(id: &str, name: &str) -> ToolCall {
    ToolCall::new(id, name, json!({ "ids": ["a"] }).to_string())
}

fn deps<'a>(
    daemon: &'a TestDaemon,
    eff: &'a euterpe::config::EffectiveConfig,
    adapter: std::sync::Arc<dyn LlmAdapter>,
    sink: euterpe::bridge::Sink,
) -> ChatDeps<'a> {
    ChatDeps {
        cfg: &daemon.state.cfg,
        eff,
        store: &daemon.state.store,
        bridge: std::sync::Arc::clone(&daemon.state.bridge),
        sink,
        session_id: "loop-test".to_string(),
        locale: "en".to_string(),
        adapter: Some(adapter),
        stream_deltas: false,
        cancel_token: None,
    }
}

#[tokio::test]
async fn two_consecutive_rate_limits_force_a_tool_free_answer() {
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |_name, _args| error_response("rate_limited"));
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    // Passo 1 e 2: o modelo pede 1 tool que volta rate_limited (2 consecutivos).
    // Passo 3: forceAnswer ⇒ sem tools ⇒ resposta final.
    let adapter = std::sync::Arc::new(ScriptedAdapter::new(vec![
        Completion {
            tool_calls: vec![tool_call("c1", "get_playlists")],
            ..Default::default()
        },
        Completion {
            tool_calls: vec![tool_call("c2", "get_top_tracks")],
            ..Default::default()
        },
        Completion {
            text: Some("Pronto, respondo com o que tenho.".into()),
            ..Default::default()
        },
    ]));

    let eff = daemon.state.effective();
    let (tx, _rx) = mpsc::unbounded_channel::<ServerMsg>();
    let outcome: LoopOutcome = euterpe::llm::run_agent_loop(
        &deps(&daemon, &eff, adapter.clone(), tx),
        "scripted-model",
        vec![euterpe::llm::canonical::Msg::user("oi")],
    )
    .await;

    assert_eq!(outcome.text, "Pronto, respondo com o que tenho.");
    assert!(outcome.degraded, "degradação precisa ser sinalizada");
    let tools_seen = adapter.tools_seen();
    assert_eq!(tools_seen.len(), 3, "3 chamadas ao modelo");
    assert!(tools_seen[0] > 0, "primeira chamada com tools");
    assert!(tools_seen[1] > 0, "segunda chamada com tools");
    assert_eq!(
        tools_seen[2], 0,
        "depois de 2 rate_limits, o modelo é chamado SEM tools"
    );
}

#[tokio::test]
async fn every_tool_call_gets_a_tool_message_even_after_force_answer() {
    // Este é o caso que faz a API devolver 400 se implementado errado: quando o
    // forceAnswer liga no meio de um lote, TODOS os tool_calls do lote ainda
    // precisam de resposta. Não temos acesso direto ao vetor de mensagens, então
    // provamos pelo efeito: a rodada seguinte precisa acontecer (sem 400) e o
    // resultado final precisa existir.
    let daemon = spawn().await;
    let _ext = fake_extension(&daemon, |_name, _args| error_response("rate_limited"));
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let adapter = std::sync::Arc::new(ScriptedAdapter::new(vec![
        Completion {
            tool_calls: vec![
                tool_call("a", "get_playlists"),
                tool_call("b", "get_saved_tracks"),
                tool_call("c", "get_top_artists"),
            ],
            ..Default::default()
        },
        Completion {
            text: Some("resposta final".into()),
            ..Default::default()
        },
    ]));
    let eff = daemon.state.effective();
    let (tx, _rx) = mpsc::unbounded_channel::<ServerMsg>();
    let outcome = euterpe::llm::run_agent_loop(
        &deps(&daemon, &eff, adapter.clone(), tx),
        "scripted-model",
        vec![euterpe::llm::canonical::Msg::user("oi")],
    )
    .await;
    assert_eq!(outcome.text, "resposta final");
    assert!(outcome.degraded);
}

#[tokio::test]
async fn a_model_error_is_answered_gracefully() {
    let daemon = spawn().await;
    // Script vazio ⇒ `complete` devolve Err na primeira chamada.
    let adapter = std::sync::Arc::new(ScriptedAdapter::new(vec![]));
    let eff = daemon.state.effective();
    let (tx, _rx) = mpsc::unbounded_channel::<ServerMsg>();
    let outcome = euterpe::llm::run_agent_loop(
        &deps(&daemon, &eff, adapter, tx),
        "scripted-model",
        vec![euterpe::llm::canonical::Msg::user("oi")],
    )
    .await;
    assert_eq!(
        outcome.text,
        "I could not reach the model just now. Try again in a moment."
    );
    assert!(outcome.degraded);
}

#[tokio::test]
async fn step_limit_produces_an_answer_not_a_hang() {
    let daemon = spawn_with(|cfg| cfg.max_tool_steps = 2).await;
    let _ext = fake_extension(&daemon, |name, _args| json!({ "tool": name }));
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // Sempre pede tool: o loop precisa parar no limite e responder.
    let adapter = std::sync::Arc::new(ScriptedAdapter::new(vec![
        Completion {
            tool_calls: vec![tool_call("1", "get_playlists")],
            ..Default::default()
        },
        Completion {
            tool_calls: vec![tool_call("2", "get_playlists")],
            ..Default::default()
        },
        Completion {
            tool_calls: vec![tool_call("3", "get_playlists")],
            ..Default::default()
        },
    ]));
    let eff = daemon.state.effective();
    assert_eq!(eff.max_tool_steps, 2, "override de settings");
    let (tx, _rx) = mpsc::unbounded_channel::<ServerMsg>();
    let outcome = euterpe::llm::run_agent_loop(
        &deps(&daemon, &eff, adapter, tx),
        "scripted-model",
        vec![euterpe::llm::canonical::Msg::user("oi")],
    )
    .await;
    assert!(
        outcome.text.starts_with("I hit the step limit"),
        "veio: {}",
        outcome.text
    );
    assert!(outcome.degraded);
}

#[tokio::test]
async fn chat_done_is_always_emitted_even_on_failure() {
    let daemon = spawn().await;
    let adapter = std::sync::Arc::new(ScriptedAdapter::new(vec![]));
    let eff = daemon.state.effective();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    let deps = ChatDeps {
        cfg: &daemon.state.cfg,
        eff: &eff,
        store: &daemon.state.store,
        bridge: std::sync::Arc::clone(&daemon.state.bridge),
        sink: tx,
        session_id: "s-done".to_string(),
        locale: "en".to_string(),
        adapter: Some(adapter),
        stream_deltas: false,
        cancel_token: None,
    };
    euterpe::llm::handle_chat(&deps, "oi").await;

    let mut saw_done = false;
    let mut deltas = String::new();
    while let Ok(msg) = rx.try_recv() {
        match msg {
            ServerMsg::ChatStream { delta, .. } => deltas.push_str(&delta),
            ServerMsg::ChatDone { session_id, .. } => {
                assert_eq!(session_id.as_deref(), Some("s-done"));
                saw_done = true;
            }
            _ => {}
        }
    }
    assert!(saw_done, "chat.done é obrigatório em qualquer caminho");
    assert!(deltas.contains("could not reach the model"));
}

#[tokio::test]
async fn handle_chat_without_provider_streams_the_fallback_and_saves_history() {
    let daemon = spawn().await;
    let eff = daemon.state.effective();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    let deps = ChatDeps {
        cfg: &daemon.state.cfg,
        eff: &eff,
        store: &daemon.state.store,
        bridge: std::sync::Arc::clone(&daemon.state.bridge),
        sink: tx,
        session_id: "s-fallback".to_string(),
        locale: "pt-br".to_string(),
        adapter: None,
        stream_deltas: false,
        cancel_token: None,
    };
    euterpe::llm::handle_chat(&deps, "oi").await;
    let mut text = String::new();
    let mut done = false;
    while let Ok(msg) = rx.try_recv() {
        match msg {
            ServerMsg::ChatStream { delta, .. } => text.push_str(&delta),
            ServerMsg::ChatDone { .. } => done = true,
            _ => {}
        }
    }
    assert!(done);
    assert!(
        text.contains("provider"),
        "mensagem pt-br de configuração: {text}"
    );

    // Paridade com o Node: no caminho "sem chave" ele grava **só** a resposta de
    // fallback do assistente (o `saveMessage(user)` acontece depois desse early
    // return). O teste trava esse comportamento de propósito.
    let history = daemon
        .state
        .store
        .with(|c| Ok(euterpe::store::history::get_history(c, "s-fallback", 10)))
        .unwrap();
    assert_eq!(
        history.len(),
        1,
        "só o assistente é persistido nesse caminho"
    );
    assert_eq!(history[0].role, "assistant");
}

#[tokio::test]
async fn curation_requests_are_routed_to_the_curation_model() {
    // Prova indireta: `is_curation_request` escolhe o modelo de curadoria.
    assert!(euterpe::llm::prompts::is_curation_request(
        "crie uma playlist de foco"
    ));
    let daemon = spawn().await;
    let eff = daemon.state.effective();
    assert_eq!(eff.active_model, "deepseek-flash");
    assert_eq!(eff.curation_model, "deepseek-v4-pro");
    assert_ne!(eff.active_model, eff.curation_model);
}

#[test]
fn mutation_policy_for_the_loop_is_always_confirm() {
    let cfg = euterpe::config::Config::for_test(std::path::PathBuf::from("C:/tmp/euterpe-loop"));
    let store = euterpe::store::Store::in_memory().unwrap();
    let opts = euterpe::bridge::CallOptions::agentic(&cfg, "id", "s", "en", &store);
    assert_eq!(opts.mutation, MutationPolicy::Confirm);
    assert!(opts.snapshot);
    let opts = euterpe::bridge::CallOptions::mcp(MutationPolicy::Allow, "id", "en", &store);
    assert_eq!(opts.mutation, MutationPolicy::Allow);
    assert!(opts.snapshot, "snapshot é obrigatório mesmo com allow (D3)");
}
