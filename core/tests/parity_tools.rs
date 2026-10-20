//! Gate de paridade do **catálogo único** (contrato C6 + decisão D5).
//!
//! O runtime lê `core/src/assets/tools.json` (gerado de `agent/src/tools/defs.ts`);
//! aqui provamos que ele continua idêntico às fixtures congeladas
//! (`core/tests/fixtures/tools_*.json`). Se alguém editar o asset à mão, isto
//! falha — que é o objetivo.

mod common;

use euterpe::tools::{catalog, Side};
use serde_json::Value;

fn fixture(name: &str) -> Vec<Value> {
    let raw = match name {
        "client" => include_str!("fixtures/tools_client.json"),
        "server" => include_str!("fixtures/tools_server.json"),
        _ => panic!("fixture desconhecida"),
    };
    serde_json::from_str(raw).expect("fixture inválida")
}

fn side_of(value: &Value) -> Side {
    match value["side"].as_str() {
        Some("client") => Side::Client,
        Some("server") => Side::Server,
        other => panic!("side inesperado: {other:?}"),
    }
}

fn assert_matches(def: &euterpe::tools::ToolDef, expected: &Value) {
    assert_eq!(
        def.name,
        expected["name"].as_str().unwrap(),
        "nome divergente"
    );
    assert_eq!(
        def.description,
        expected["description"].as_str().unwrap(),
        "descrição divergente em {}",
        def.name
    );
    assert_eq!(
        def.parameters, expected["parameters"],
        "parameters divergentes em {}",
        def.name
    );
    assert_eq!(
        def.side,
        side_of(expected),
        "side divergente em {}",
        def.name
    );
}

#[test]
fn client_catalog_matches_the_frozen_fixture() {
    let expected = fixture("client");
    let actual: Vec<&euterpe::tools::ToolDef> = catalog::client_tools().collect();
    assert_eq!(
        actual.len(),
        expected.len(),
        "quantidade de client tools mudou"
    );
    for (def, want) in actual.iter().zip(expected.iter()) {
        assert_matches(def, want);
    }
}

#[test]
fn server_catalog_matches_the_frozen_fixture() {
    let expected = fixture("server");
    let actual: Vec<&euterpe::tools::ToolDef> = catalog::server_tools().collect();
    assert_eq!(
        actual.len(),
        expected.len(),
        "quantidade de server tools mudou"
    );
    for (def, want) in actual.iter().zip(expected.iter()) {
        assert_matches(def, want);
    }
}

#[test]
fn mutating_set_matches_the_fixture() {
    let raw = include_str!("fixtures/tools_mutating.json");
    let expected: Vec<String> = serde_json::from_str(raw).unwrap();
    let mut actual: Vec<String> = catalog::mutating().to_vec();
    actual.sort();
    assert_eq!(actual, expected);
}

#[test]
fn counts_match_the_fixture() {
    let raw = include_str!("fixtures/tools_counts.json");
    let expected: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(expected["client"], catalog::client_tools().count());
    assert_eq!(expected["server"], catalog::server_tools().count());
    assert_eq!(expected["total"], catalog::all().len());
    assert_eq!(catalog::all().len(), 45);
}

#[test]
fn openai_schemas_match_the_fixture_shape() {
    let schemas = catalog::openai_schemas();
    let fixture = fixture("client");
    for (schema, want) in schemas.iter().zip(fixture.iter()) {
        assert_eq!(schema["type"], "function");
        assert_eq!(schema["function"]["name"], want["name"]);
        assert_eq!(schema["function"]["parameters"], want["parameters"]);
        assert!(
            schema["function"].get("side").is_none(),
            "side não pode ir para a wire"
        );
    }
}

#[test]
fn mcp_listing_uses_namespaced_names_and_annotations() {
    let listed = catalog::mcp_list();
    assert_eq!(listed.len(), 45);
    for entry in &listed {
        let name = entry["name"].as_str().unwrap();
        assert!(name.starts_with("spotify_"), "{name} sem prefixo");
        assert!(entry.get("inputSchema").is_some(), "{name} sem inputSchema");
        assert!(entry["annotations"]["readOnlyHint"].is_boolean());
        assert!(entry["annotations"]["destructiveHint"].is_boolean());
    }
    // `spotify_undo_last_mutation` é obrigatório: é o cinto do default `allow` (D3).
    assert!(catalog::find_mcp("spotify_undo_last_mutation").is_some());
}
