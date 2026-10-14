//! Catálogo único de tools (decisão D5): o **mesmo** conjunto alimenta o loop LLM
//! interno (formato OpenAI `{type:"function",function:...}`) e o servidor MCP
//! (`tools/list` com nomes `spotify_<name>`).
//!
//! A fonte de verdade é `agent/src/tools/defs.ts`; `agent/tools/export-goldens.mjs`
//! materializa isso em `core/src/assets/tools.json` (commitado) e em
//! `core/tests/fixtures/tools_{client,server}.json` (fixture de paridade).
//! `parity_tools.rs` falha se os dois divergirem — ou seja, se alguém editar o
//! asset à mão.
//!
//! As *anotações* MCP (readOnly/destructive/idempotent) são conhecimento do Rust e
//! vivem aqui, não no golden.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const ASSET: &str = include_str!("../assets/tools.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Client,
    Server,
}

#[derive(Debug, Clone, Deserialize)]
struct RawTool {
    name: String,
    description: String,
    parameters: Value,
    side: Side,
}

#[derive(Debug, Deserialize)]
struct RawCatalog {
    client: Vec<RawTool>,
    server: Vec<RawTool>,
    mutating: Vec<String>,
}

/// Anotações MCP expostas em `tools/list` (§Fase 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub struct Annotations {
    #[serde(rename = "readOnlyHint")]
    pub read_only: bool,
    #[serde(rename = "destructiveHint")]
    pub destructive: bool,
    #[serde(rename = "idempotentHint")]
    pub idempotent: bool,
    #[serde(rename = "openWorldHint")]
    pub open_world: bool,
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub side: Side,
    pub annotations: Annotations,
}

impl ToolDef {
    /// Nome exposto no MCP. Renomear isto é *breaking change* (contrato congelado).
    pub fn mcp_name(&self) -> String {
        format!("spotify_{}", self.name)
    }

    /// Esquema no formato OpenAI (`allToolSchemas` do Node).
    pub fn openai_schema(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        })
    }

    /// Esquema no formato MCP (`tools/list`).
    pub fn mcp_schema(&self) -> Value {
        json!({
            "name": self.mcp_name(),
            "description": self.description,
            "inputSchema": self.parameters,
            "annotations": self.annotations,
        })
    }

    pub fn is_mutating(&self) -> bool {
        self.annotations.destructive
    }
}

struct Catalog {
    tools: Vec<ToolDef>,
}

/// Parse puro do asset, **sem** depender de `catalog()`. Existe separado para
/// evitar *re-entrância* em `OnceLock`: a construção do catálogo precisa de
/// `mutating`, e `is_mutating` (usada por `annotations_for`) iria reentrar no
/// mesmo `OnceLock` e travar (deadlock de inicialização).
fn raw() -> &'static RawCatalog {
    static RAW: OnceLock<RawCatalog> = OnceLock::new();
    RAW.get_or_init(|| {
        serde_json::from_str(ASSET)
            .expect("core/src/assets/tools.json inválido — rode `npm run goldens`")
    })
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let raw = raw();
        let destructive_set: &[String] = &raw.mutating;
        let mut tools = Vec::with_capacity(raw.client.len() + raw.server.len());
        for t in raw.client.iter().chain(raw.server.iter()) {
            let destructive = destructive_set.iter().any(|m| m == &t.name);
            let read_only = !destructive && is_read_only(&t.name);
            let annotations = Annotations {
                read_only,
                destructive,
                idempotent: read_only || t.name == "set_playlist_details",
                // Toda tool fala com o Spotify/Web: não é pura local.
                open_world: true,
            };
            tools.push(ToolDef {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.parameters.clone(),
                side: t.side,
                annotations,
            });
        }
        Catalog { tools }
    })
}

/// Todas as tools, na ordem canônica (client primeiro, depois server).
pub fn all() -> &'static [ToolDef] {
    &catalog().tools
}

pub fn client_tools() -> impl Iterator<Item = &'static ToolDef> {
    all().iter().filter(|t| t.side == Side::Client)
}

pub fn server_tools() -> impl Iterator<Item = &'static ToolDef> {
    all().iter().filter(|t| t.side == Side::Server)
}

pub fn find(name: &str) -> Option<&'static ToolDef> {
    all().iter().find(|t| t.name == name)
}

/// Busca pelo nome MCP (`spotify_<name>`), aceitando também o nome cru.
pub fn find_mcp(mcp_name: &str) -> Option<&'static ToolDef> {
    let raw = mcp_name.strip_prefix("spotify_").unwrap_or(mcp_name);
    all()
        .iter()
        .find(|t| t.name == raw || t.mcp_name() == mcp_name)
}

/// Conjunto de mutantes (`MUTATING_TOOLS` do Node) — as que exigem confirmação,
/// snapshot e que carregam `destructiveHint`.
pub fn mutating() -> &'static [String] {
    &raw().mutating
}

pub fn is_mutating(name: &str) -> bool {
    raw().mutating.iter().any(|n| n == name)
}

/// Esquemas no formato OpenAI (`allToolSchemas`).
pub fn openai_schemas() -> Vec<Value> {
    all().iter().map(|t| t.openai_schema()).collect()
}

/// `tools/list` do MCP.
pub fn mcp_list() -> Vec<Value> {
    all().iter().map(|t| t.mcp_schema()).collect()
}

/// Regras de anotação (§Fase 3): read-only é regra de nome, mutação vem do
/// `MUTATING_TOOLS` do Node (fonte de verdade).
fn is_read_only(name: &str) -> bool {
    const READS: &[&str] = &[
        "search_spotify",
        "new_releases",
        "lyrics_lookup",
        "lyrics_bulk",
        "artist_info",
        "similar_artists",
        "web_search",
        "chart_lookup",
        "image_search",
        "weekly_report",
        "get_listening_recents",
        "get_currently_playing",
        "get_player_state",
        "get_player_queue",
        "get_connect_devices",
    ];
    name.starts_with("get_") || READS.contains(&name)
}

/// Vocabulário interno usado pelos loops (`clientToolNames`/`serverToolNames`).
pub fn is_client_tool(name: &str) -> bool {
    find(name).map(|t| t.side == Side::Client).unwrap_or(false)
}

pub fn is_server_tool(name: &str) -> bool {
    find(name).map(|t| t.side == Side::Server).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_match_the_frozen_contract_c6() {
        assert_eq!(client_tools().count(), 25);
        assert_eq!(server_tools().count(), 11);
        assert_eq!(all().len(), 36);
    }

    #[test]
    fn names_are_unique_and_mcp_names_namespaced() {
        let mut names: Vec<&str> = all().iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "nome de tool duplicado");
        for t in all() {
            assert!(t.mcp_name().starts_with("spotify_"));
            assert_eq!(find_mcp(&t.mcp_name()).unwrap().name, t.name);
        }
    }

    #[test]
    fn required_is_subset_of_properties() {
        for t in all() {
            let props = t.parameters.get("properties").and_then(Value::as_object);
            let required = t.parameters.get("required").and_then(Value::as_array);
            for req in required.into_iter().flatten() {
                let key = req.as_str().unwrap();
                assert!(
                    props.map(|p| p.contains_key(key)).unwrap_or(false),
                    "{}: required `{key}` sem propriedade",
                    t.name
                );
            }
        }
    }

    #[test]
    fn mutating_set_is_destructive_and_inside_client_side() {
        assert_eq!(mutating().len(), 6);
        for name in mutating() {
            let def = find(name).unwrap_or_else(|| panic!("{name} não está no catálogo"));
            assert_eq!(def.side, Side::Client, "{name} deveria ser client-side");
            assert!(
                def.annotations.destructive,
                "{name} deveria ter destructiveHint"
            );
            assert!(!def.annotations.read_only, "{name} não é read-only");
        }
    }

    #[test]
    fn read_only_tools_are_annotated_and_idempotent() {
        for t in all() {
            if t.annotations.read_only {
                assert!(
                    t.annotations.idempotent,
                    "{} read-only deveria ser idempotente",
                    t.name
                );
                assert!(
                    !t.annotations.destructive,
                    "{} não pode ser destructive",
                    t.name
                );
            }
        }
        assert!(find("set_playlist_details").unwrap().annotations.idempotent);
        assert!(!find("player_control").unwrap().annotations.destructive);
        assert!(
            !find("player_queue_control")
                .unwrap()
                .annotations
                .destructive
        );
    }

    #[test]
    fn openai_schema_shape_matches_node() {
        let v = find("add_tracks").unwrap().openai_schema();
        assert_eq!(v["type"], "function");
        assert_eq!(v["function"]["name"], "add_tracks");
        assert_eq!(v["function"]["parameters"]["type"], "object");
        assert!(v["function"]["description"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn mcp_schema_uses_input_schema_and_annotations() {
        let v = find("get_playlists").unwrap().mcp_schema();
        assert_eq!(v["name"], "spotify_get_playlists");
        assert!(v.get("inputSchema").is_some());
        assert_eq!(v["annotations"]["readOnlyHint"], true);
        assert_eq!(v["annotations"]["destructiveHint"], false);
    }
}
