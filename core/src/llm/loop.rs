//! Loop LLM nativo (paridade com `runAgentLoop` de `agent/src/agent.ts:299-446`).
//!
//! Regras que já custaram caro e são testadas em `llm_loop_degrade.rs`:
//!  - `rateLimited: HashSet` por nome; **2** rate_limits consecutivos ⇒
//!    `forceAnswer` ⇒ degradação graciosa;
//!  - quando `forceAnswer` liga, **todos** os `tool_calls` do lote continuam
//!    recebendo mensagem `tool` (senão a API devolve 400);
//!  - `chat.done` é **sempre** emitido (timeout, erro de API, limite de passos);
//!  - `reasoning` nunca é reenviado no histórico.

use std::sync::Arc;

use crate::bridge::{Bridge, CallOptions};
use crate::config::{Config, EffectiveConfig};
use crate::llm::canonical::{ChatRequest, LlmAdapter, LlmEvent, Msg, ToolCall};
use crate::protocol::ServerMsg;
use crate::store::Store;
use crate::tools::catalog;

use super::prompts;

/// Saída do loop.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopOutcome {
    pub text: String,
    pub degraded: bool,
}

/// Dependências de uma execução de chat.
pub struct ChatDeps<'a> {
    pub cfg: &'a Config,
    pub eff: &'a EffectiveConfig,
    pub store: &'a Store,
    pub bridge: Arc<Bridge>,
    pub sink: crate::bridge::Sink,
    pub session_id: String,
    pub locale: String,
    /// `None` quando não há provider utilizável (sem chave): cai no fallback.
    pub adapter: Option<Arc<dyn LlmAdapter>>,
    /// `true` no caminho SSE (streaming real de tokens); `false` no caminho WS
    /// (paridade com o Node: chunks de 40 chars após o loop).
    pub stream_deltas: bool,
    pub cancel_token: Option<tokio_util::sync::CancellationToken>,
}

impl<'a> ChatDeps<'a> {
    pub fn is_cancelled(&self) -> bool {
        self.cancel_token.as_ref().is_some_and(|t| t.is_cancelled())
    }

    fn send(&self, msg: ServerMsg) {
        let _ = self.sink.send(msg);
    }

    fn status(&self, status: &str, detail: impl Into<String>) {
        self.send(ServerMsg::ChatStatus {
            session_id: Some(self.session_id.clone()),
            status: status.to_string(),
            detail: Some(detail.into()),
        });
    }

    pub fn config_for(&self, call_id: &str) -> CallOptions<'a> {
        let mut opts = CallOptions::agentic(
            self.cfg,
            call_id,
            &self.session_id,
            &self.locale,
            self.store,
        );
        opts.mutation = self.eff.mutation_policy;
        opts
    }
}

/// Consulta o provider. No caminho SSE usa `stream()` (deltas reais); no caminho
/// WS usa `complete()` (igual ao Node, que manda `stream:false`).
async fn ask(
    deps: &ChatDeps<'_>,
    adapter: &Arc<dyn LlmAdapter>,
    model: &str,
    messages: &[Msg],
    tools: Vec<serde_json::Value>,
) -> anyhow::Result<crate::llm::canonical::Completion> {
    if deps.is_cancelled() {
        anyhow::bail!("cancelled");
    }
    let mut req = ChatRequest::new(model.to_string(), messages.to_vec());
    req.tools = tools;
    req.timeout_ms = deps.cfg.llm_timeout_ms;
    // Parâmetros do PERFIL ativo (None = o adapter usa o próprio padrão).
    req.temperature = deps.eff.active_temperature;
    req.max_tokens = deps.eff.active_max_tokens;
    let caps = adapter.capabilities();
    if deps.stream_deltas && caps.streaming {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<LlmEvent>(64);
        let sink = deps.sink.clone();
        let session_id = deps.session_id.clone();
        let cancel_token = deps.cancel_token.clone();
        let forwarder = tokio::spawn(async move {
            let mut completion = crate::llm::canonical::Completion::default();
            let mut text = String::new();
            let mut reasoning = String::new();
            while let Some(ev) = rx.recv().await {
                if cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
                    break;
                }
                match ev {
                    LlmEvent::Delta(d) => {
                        text.push_str(&d);
                        let _ = sink.send(ServerMsg::ChatStream {
                            session_id: Some(session_id.clone()),
                            delta: d,
                        });
                    }
                    LlmEvent::Reasoning(r) => reasoning.push_str(&r),
                    LlmEvent::ToolCall(tc) => completion.tool_calls.push(tc),
                    LlmEvent::Usage { input, output } => completion.usage = Some((input, output)),
                    LlmEvent::Done => {}
                }
            }
            if !text.is_empty() {
                completion.text = Some(text);
            }
            if !reasoning.is_empty() {
                completion.reasoning = Some(reasoning);
            }
            completion
        });
        let result = adapter.stream(req, tx).await;
        let completion = forwarder.await.unwrap_or_default();
        result?;
        Ok(completion)
    } else {
        adapter.complete(req).await
    }
}

/// Loop agentic completo.
pub async fn run_agent_loop(
    deps: &ChatDeps<'_>,
    model: &str,
    mut messages: Vec<Msg>,
) -> LoopOutcome {
    let adapter = match deps.adapter.clone() {
        Some(a) => a,
        None => {
            return LoopOutcome {
                text: crate::i18n::t(&deps.locale, "fallback.noApiKeyRust", &[]),
                degraded: true,
            }
        }
    };

    let t_thinking = crate::i18n::t(&deps.locale, "status.thinking", &[]);
    let all_tools = catalog::openai_schemas();

    let mut steps: u32 = 0;
    let mut final_text = String::new();
    let mut degraded = false;
    let mut rate_limited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut consecutive_rate_limited: u32 = 0;
    let mut force_answer = false;

    loop {
        if deps.is_cancelled() {
            tracing::info!(session_id = %deps.session_id, "chat loop cancelled by client");
            break;
        }
        if steps >= deps.eff.max_tool_steps {
            break;
        }
        steps += 1;
        deps.status("thinking", t_thinking.clone());

        let tools = if force_answer {
            Vec::new()
        } else {
            all_tools.clone()
        };
        let completion = match ask(deps, &adapter, model, &messages, tools).await {
            Ok(c) => c,
            Err(err) => {
                if deps.is_cancelled() {
                    break;
                }
                let detail = err.to_string();
                crate::logging::log_session(
                    &deps.cfg.sessions_dir,
                    &deps.session_id,
                    "llm.error",
                    Some(serde_json::json!({ "step": steps, "error": detail })),
                );
                final_text = crate::i18n::t(&deps.locale, "fallback.llmError", &[]);
                degraded = true;
                break;
            }
        };

        if let Some(reasoning) = completion.reasoning.as_deref().filter(|r| !r.is_empty()) {
            crate::logging::log_session(
                &deps.cfg.sessions_dir,
                &deps.session_id,
                "llm.reasoning",
                Some(serde_json::json!({
                    "step": steps,
                    "chars": reasoning.chars().count(),
                    "preview": reasoning.chars().take(300).collect::<String>(),
                })),
            );
        }

        if !completion.tool_calls.is_empty() && !force_answer {
            // O `reasoning` NUNCA volta para a API (recomendação do DeepSeek).
            messages.push(Msg::Assistant {
                text: completion.text.clone(),
                tool_calls: completion.tool_calls.clone(),
            });
            crate::logging::log_session(
                &deps.cfg.sessions_dir,
                &deps.session_id,
                "llm.turn",
                Some(serde_json::json!({
                    "step": steps,
                    "tool_calls": completion.tool_calls.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
                })),
            );

            for call in &completion.tool_calls {
                if deps.is_cancelled() {
                    break;
                }
                let label = if deps.eff.debug {
                    call.name.clone()
                } else {
                    prompts::friendly_tool_label(&deps.locale, &call.name)
                };
                deps.status("tool", label);

                // Emite o evento ToolCall estruturado para o cliente (SSE: event: tool {id, name, args})
                if deps.stream_deltas {
                    deps.send(ServerMsg::ToolCall {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        args: call.parsed_args(),
                    });
                }

                let started = std::time::Instant::now();
                let result = if force_answer || rate_limited.contains(&call.name) {
                    crate::protocol::ToolResult::err("rate_limited")
                } else {
                    dispatch(deps, call).await
                };
                if result.is_rate_limited() {
                    rate_limited.insert(call.name.clone());
                    consecutive_rate_limited += 1;
                } else {
                    consecutive_rate_limited = 0;
                }

                let size = if result.ok {
                    serde_json::to_string(result.data.as_ref().unwrap_or(&serde_json::Value::Null))
                        .map(|s| s.chars().count())
                        .unwrap_or(0)
                } else {
                    0
                };
                let content = prompts::tool_result_content(
                    result.ok,
                    result.data.as_ref(),
                    result.code.as_deref(),
                    deps.eff.debug,
                );
                let elapsed = started.elapsed().as_millis();
                crate::logging::log_tool_call(
                    &deps.cfg.sessions_dir,
                    &deps.session_id,
                    &call.name,
                    &call.parsed_args(),
                    Some(result.ok),
                    result.code.as_deref(),
                    Some(elapsed),
                );
                crate::logging::log_session(
                    &deps.cfg.sessions_dir,
                    &deps.session_id,
                    "tool.result",
                    Some(serde_json::json!({
                        "name": call.name,
                        "ok": result.ok,
                        "code": result.code,
                        "size": size,
                        "duration_ms": elapsed,
                        "preview": content.chars().take(400).collect::<String>(),
                    })),
                );
                messages.push(Msg::tool(call.id.clone(), content));

                if consecutive_rate_limited >= 2 && !force_answer {
                    force_answer = true;
                    degraded = true;
                    // Sem `break`: o resto do lote é respondido como rate_limited,
                    // preservando o pareamento tool_calls ↔ tool (C-F4).
                }
            }
            if force_answer {
                messages.push(Msg::system(prompts::force_answer_msg()));
            }
            continue;
        }

        final_text = completion.text.unwrap_or_default();
        crate::logging::log_session(
            &deps.cfg.sessions_dir,
            &deps.session_id,
            "llm.final",
            Some(serde_json::json!({ "step": steps, "length": final_text.chars().count() })),
        );
        break;
    }

    if final_text.trim().is_empty() && !degraded {
        final_text = if steps >= deps.eff.max_tool_steps {
            crate::i18n::t(&deps.locale, "fallback.stepLimit", &[])
        } else {
            crate::i18n::t(&deps.locale, "fallback.noAnswer", &[])
        };
        degraded = true;
    }

    LoopOutcome {
        text: prompts::trim_final(&final_text, prompts::max_final_length()),
        degraded,
    }
}

/// Executa a tool pedida pelo modelo (client-side ou server-side).
async fn dispatch(deps: &ChatDeps<'_>, call: &ToolCall) -> crate::protocol::ToolResult {
    let args = call.parsed_args();
    if catalog::is_client_tool(&call.name) {
        let opts = deps.config_for(&call.id);
        deps.bridge
            .call_tool(deps.cfg, &call.name, args, opts)
            .await
    } else if catalog::is_server_tool(&call.name) {
        let opts = deps.config_for(&format!("srv_{}", call.id));
        deps.bridge
            .run_server_tool(deps.cfg, &call.name, args, opts)
            .await
    } else {
        crate::protocol::ToolResult::err(format!("unknown_tool:{}", call.name))
    }
}

/// `handleChat()` — prepara o histórico, escolhe o modelo (roteamento por
/// curadoria), roda o loop, transmite e fecha com `chat.done`.
pub async fn handle_chat(deps: &ChatDeps<'_>, text: &str) {
    // Sem provider utilizável, o Node responde o texto de fallback em pedaços.
    if deps.adapter.is_none() {
        let fallback = crate::i18n::t(&deps.locale, "fallback.noApiKeyRust", &[]);
        stream_text_chunks(deps, &fallback).await;
        deps.store
            .with(|c| {
                crate::store::history::save_message(c, &deps.session_id, "assistant", &fallback);
                Ok(())
            })
            .ok();
        deps.send(ServerMsg::ChatDone {
            session_id: Some(deps.session_id.clone()),
            suggestions: Some(Vec::new()),
        });
        return;
    }

    let mut messages: Vec<Msg> = vec![Msg::system(prompts::with_user_instructions(
        prompts::system_prompt(Some(&deps.locale), deps.eff.debug),
        &deps.eff.instructions,
    ))];
    if deps.eff.chat_history_turns > 0 {
        let history = deps
            .store
            .with(|c| {
                Ok(crate::store::history::get_history(
                    c,
                    &deps.session_id,
                    deps.eff.chat_history_turns,
                ))
            })
            .unwrap_or_default();
        for m in history {
            messages.push(match m.role.as_str() {
                "assistant" => Msg::assistant_text(m.content),
                _ => Msg::user(m.content),
            });
        }
    }
    messages.push(Msg::user(text));

    deps.store
        .with(|c| {
            crate::store::history::save_message(c, &deps.session_id, "user", text);
            Ok(())
        })
        .ok();

    let model = if prompts::is_curation_request(text) {
        deps.eff.curation_model.clone()
    } else {
        deps.eff.active_model.clone()
    };
    crate::logging::log_session(
        &deps.cfg.sessions_dir,
        &deps.session_id,
        "session.start",
        Some(serde_json::json!({ "text": text, "model": model })),
    );

    let outcome = run_agent_loop(deps, &model, messages.clone()).await;

    if deps.is_cancelled() {
        return;
    }

    let suggestions =
        if deps.eff.suggestions && !outcome.degraded && !outcome.text.trim().is_empty() {
            super::suggestions::generate(deps, &model, &messages, text, &outcome.text).await
        } else {
            Vec::new()
        };

    if !deps.stream_deltas {
        stream_text_chunks(deps, &outcome.text).await;
    }
    deps.store
        .with(|c| {
            crate::store::history::save_message(c, &deps.session_id, "assistant", &outcome.text);
            Ok(())
        })
        .ok();
    crate::logging::log_session(
        &deps.cfg.sessions_dir,
        &deps.session_id,
        "session.end",
        Some(serde_json::json!({ "final_length": outcome.text.chars().count() })),
    );
    deps.send(ServerMsg::ChatDone {
        session_id: Some(deps.session_id.clone()),
        suggestions: Some(suggestions),
    });
}

/// Envia o texto em pedaços de 40 chars com 20 ms (UX do Node: "digita").
async fn stream_text_chunks(deps: &ChatDeps<'_>, text: &str) {
    let chars: Vec<char> = text.chars().collect();
    let delay = prompts::stream_delay_ms();
    for chunk in chars.chunks(40) {
        let delta: String = chunk.iter().collect();
        deps.send(ServerMsg::ChatStream {
            session_id: Some(deps.session_id.clone()),
            delta,
        });
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
}

/// `handleSongChange()` — roteamento automático da faixa em reprodução.
pub async fn handle_song_change(deps: &ChatDeps<'_>, uri: &str) {
    if !deps.eff.auto_routing || deps.adapter.is_none() {
        return;
    }
    crate::logging::log_session(
        &deps.cfg.sessions_dir,
        &deps.session_id,
        "songchange.start",
        Some(serde_json::json!({ "uri": uri })),
    );

    let id = uri.rsplit(':').next().unwrap_or(uri).to_string();
    let call_id = format!("sc_{uri}");
    let opts = CallOptions::agentic(
        deps.cfg,
        &call_id,
        &deps.session_id,
        &deps.locale,
        deps.store,
    );
    let tr = deps
        .bridge
        .call_tool(
            deps.cfg,
            "get_several_tracks",
            serde_json::json!({ "ids": [id] }),
            opts,
        )
        .await;
    if !tr.ok {
        return;
    }
    let Some(first) = tr
        .data
        .as_ref()
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
    else {
        return;
    };
    let name = first.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let artists = first
        .get("artists")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let text = if artists.is_empty() {
        format!("Now playing: \"{name}\".")
    } else {
        format!("Now playing: \"{name}\" by {artists}.")
    };

    let messages = vec![
        Msg::system(prompts::routing_prompt(Some(&deps.locale))),
        Msg::user(text),
    ];
    let outcome = run_agent_loop(deps, &deps.eff.active_model.clone(), messages).await;
    deps.send(ServerMsg::ChatStream {
        session_id: Some(deps.session_id.clone()),
        delta: outcome.text,
    });
    deps.send(ServerMsg::ChatDone {
        session_id: Some(deps.session_id.clone()),
        suggestions: None,
    });
}
