//! Dispatch dos métodos MCP.

use serde_json::{json, Value};

use super::gate;
use super::jsonrpc::{negotiate_version, Error};
use crate::bridge::CallOptions;
use crate::protocol::ToolResult;
use crate::AppState;

pub const SERVER_NAME: &str = "euterpe";
pub const SERVER_VERSION: &str = crate::VERSION;

/// Executa um método MCP. `Err` = erro JSON-RPC.
pub async fn dispatch(state: &AppState, method: &str, params: &Value) -> Result<Value, Error> {
    match method {
        "initialize" => Ok(initialize(params)),
        "notifications/initialized" | "notifications/cancelled" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": crate::tools::catalog::mcp_list() })),
        "tools/call" => call_tool(state, params).await,
        "resources/list" => Ok(json!({ "resources": super::catalog::resources() })),
        "resources/read" => read_resource(state, params).await,
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": super::catalog::prompts() })),
        "prompts/get" => prompt_get(params),
        other => Err(Error::method_not_found(other)),
    }
}

fn initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(|v| v.as_str());
    json!({
        "protocolVersion": negotiate_version(requested),
        "capabilities": {
            // `listChanged:false`: o catálogo é congelado (C6).
            "tools": { "listChanged": false },
            "resources": { "listChanged": false, "subscribe": false },
            "prompts": { "listChanged": false },
        },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": "Ferramentas do Spotify rodando dentro do cliente desktop do usuário. \
    Leia primeiro (get_*), confirme mutações de playlist e use spotify_undo_last_mutation se precisar reverter.",
    })
}

/// `tools/call` — contrato congelado de resultado (§Fase 3).
pub async fn call_tool(state: &AppState, params: &Value) -> Result<Value, Error> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::invalid_params("name is required"))?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    let Some(def) = crate::tools::catalog::find_mcp(name) else {
        // Tool desconhecida **não** é erro de protocolo: devolve isError (§Fase 3).
        return Ok(error_content(format!("unknown_tool:{name}"), None));
    };

    let eff = state.effective();
    let locale = crate::i18n::normalize_locale(None).to_string();
    let call_id = format!("mcp_{}", uuid::Uuid::new_v4());
    let mutating = crate::tools::catalog::is_mutating(&def.name);
    let policy = if mutating {
        gate::effective_policy(
            eff.mutation_policy,
            &def.name,
            &state.settings.mutation_allowlist(),
        )
    } else {
        crate::config::MutationPolicy::Allow
    };

    if !state.bridge.has_client() {
        return Ok(error_content("client_offline".to_string(), None));
    }

    let opts = CallOptions::mcp(policy, &call_id, &locale, &state.store);
    let result = if crate::tools::catalog::is_client_tool(&def.name) {
        state
            .bridge
            .call_tool(&state.cfg, &def.name, args.clone(), opts)
            .await
    } else {
        state
            .bridge
            .run_server_tool(&state.cfg, &def.name, args.clone(), opts)
            .await
    };

    let result = if mutating {
        gate::annotate(result, &state.store, &args, &def.name)
    } else {
        result
    };
    Ok(to_content(result))
}

/// Sucesso: `content:[{type:"text",text:<json>}]`. Falha: `isError:true`.
pub fn to_content(result: ToolResult) -> Value {
    if result.ok {
        json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(result.data.as_ref().unwrap_or(&Value::Null))
                    .unwrap_or_else(|_| "null".to_string()),
            }],
            "isError": false,
        })
    } else {
        error_content(
            result.code.unwrap_or_else(|| "tool_failed".to_string()),
            result.data,
        )
    }
}

fn error_content(code: String, data: Option<Value>) -> Value {
    let text = match data {
        Some(d) if !d.is_null() => {
            let mut obj = json!({ "ok": false, "code": code });
            if let Some(map) = d.as_object() {
                for (k, v) in map {
                    obj[k] = v.clone();
                }
            } else {
                obj["data"] = d;
            }
            obj.to_string()
        }
        _ => json!({ "ok": false, "code": code }).to_string(),
    };

    json!({
        "content": [{
            "type": "text",
            "text": text,
        }],
        "isError": true,
    })
}

async fn read_resource(state: &AppState, params: &Value) -> Result<Value, Error> {
    let uri = params
        .get("uri")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::invalid_params("uri is required"))?;
    if uri == "euterpe://voice" {
        let voice_json = serde_json::json!({
            "name": "Euterpe",
            "archetype": "a pessoa da rádio",
            "persona": "Curadora residente no Spotify desktop. Uma amiga que trabalha na rádio, sabe onde está cada disco, e fica genuinamente feliz que você perguntou.",
            "pillars": [
                "Próxima (presente, direta, inclusiva, sem hype nem exclamações empilhadas)",
                "Tagarela por dentro (narra o processo em gerúndios de música)",
                "Seca no humor (absurdo-técnico deadpan sobre a máquina, nunca sobre a pessoa)"
            ],
            "thinkingVerbs": {
                "pt-br": [
                    "Garimpando", "Sampleando", "Fatiando", "Loopando", "Equalizando",
                    "Beatmatching", "Afinando", "Sequenciando", "Mixando", "Masterizando",
                    "Rebobinando a fita", "Catalogando", "Arquivando", "Fichando", "Indexando",
                    "Orquestrando", "Roteando", "Encaixando", "Fadeando", "Escalando o setlist"
                ],
                "en": [
                    "Crate-digging", "Sample-chopping", "Looping", "Beatmatching",
                    "Sequencing", "Rewinding the tape", "Filing the 45s", "Dusting the sleeves",
                    "Slowing the tape", "Spinning up", "Bouncing the stems"
                ]
            },
            "rules": [
                "No sycophancy or generic filler (\"Como posso ajudar?\", \"Anything else?\")",
                "Call things by their musical names: faixas, discos, o que está tocando",
                "Never invent data, tracks or lyrics",
                "Component template required for Spotify items: {{spotify:type:uri|Label}}"
            ]
        });
        return Ok(json!({
            "contents": [{
                "uri": uri,
                "mimeType": "application/json",
                "text": voice_json.to_string(),
            }]
        }));
    }
    let Some((tool, args)) = super::catalog::resource_tool(uri) else {
        return Err(Error::with_data(
            crate::mcp::jsonrpc::INVALID_PARAMS,
            format!("Recurso desconhecido: {uri}"),
            json!({ "uri": uri }),
        ));
    };
    if !state.bridge.has_client() {
        return Err(Error::new(
            crate::mcp::jsonrpc::INTERNAL_ERROR,
            "client_offline",
        ));
    }
    let locale = crate::i18n::normalize_locale(None).to_string();
    let call_id = format!("mcp_res_{}", uuid::Uuid::new_v4());
    let opts = CallOptions::mcp(
        crate::config::MutationPolicy::Deny,
        &call_id,
        &locale,
        &state.store,
    );
    let result = state.bridge.call_tool(&state.cfg, tool, args, opts).await;
    let text = if result.ok {
        serde_json::to_string(result.data.as_ref().unwrap_or(&Value::Null)).unwrap_or_default()
    } else {
        json!({ "ok": false, "code": result.code }).to_string()
    };
    Ok(json!({
        "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }],
    }))
}

fn prompt_get(params: &Value) -> Result<Value, Error> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::invalid_params("name is required"))?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));
    match super::catalog::prompt_messages(name, &args) {
        Some(messages) => Ok(
            json!({ "description": "Curadoria de playlist com o Euterpe", "messages": messages }),
        ),
        None => Err(Error::invalid_params(format!(
            "Prompt desconhecido: {name}"
        ))),
    }
}

/// Métodos que exigem sessão (Streamable HTTP com `Mcp-Session-Id`).
pub fn requires_session(method: &str) -> bool {
    !matches!(
        method,
        "initialize" | "notifications/initialized" | "ping" | "notifications/cancelled"
    )
}
