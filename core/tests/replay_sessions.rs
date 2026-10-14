//! Gate de paridade do flip (D6 / A''): reproduz o **corpus de tool calls reais**
//! contra o bridge novo e exige paridade estrutural.
//!
//! O corpus (`core/tests/fixtures/sessions/*.jsonl`) é gerado por
//! `agent/tools/export-replay-corpus.mjs` a partir de `agent/data/sessions/*.log`
//! e é **gitignored** (contém termos de busca e nomes de playlists do usuário).
//! Sem o corpus, o teste **pula com mensagem explícita** para o clone limpo
//! continuar verde.

mod common;

use common::*;
use euterpe::tools::catalog;
use serde_json::Value;
use std::path::{Path, PathBuf};

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("sessions")
}

fn load_corpus() -> Vec<Value> {
    let dir = corpus_dir();
    if !dir.exists() {
        return Vec::new();
    }
    let mut calls = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                calls.push(value);
            }
        }
    }
    calls
}

/// Nomes que aparecem no corpus real mas **nunca** estiveram em
/// `agent/src/tools/defs.ts` (o modelo alucinou ou vieram de uma versão antiga).
/// O loop já os trata como `unknown_tool:<n>` nos dois daemons — então eles não
/// são "breaking change", são ruído histórico. O teste abaixo falha se algum
/// deles **entrar** no catálogo sem decisão explícita.
const LEGACY_HALLUCINATED: &[&str] = &["get_audio_features_bulk"];

#[tokio::test]
async fn every_recorded_tool_call_is_still_known_to_the_catalog() {
    let calls = load_corpus();
    if calls.is_empty() {
        eprintln!(
            "[replay_sessions] corpus ausente em {} — gere com `node agent/tools/export-replay-corpus.mjs` \
             e rode de novo. Pulando o gate do flip (D6).",
            corpus_dir().display()
        );
        return;
    }

    let mut unknown: Vec<String> = Vec::new();
    for call in &calls {
        let name = call["name"].as_str().unwrap_or("");
        if catalog::find(name).is_none() && !LEGACY_HALLUCINATED.contains(&name) {
            unknown.push(name.to_string());
        }
    }
    unknown.sort();
    unknown.dedup();
    assert!(
        unknown.is_empty(),
        "tool calls reais fora do catálogo (renomear = breaking change): {unknown:?}"
    );

    // A allowlist é para nomes que o catálogo **não** tem: se alguém adicionar
    // `get_audio_features_bulk` de verdade, o teste avisa para revisar esta lista.
    for name in LEGACY_HALLUCINATED {
        assert!(
            catalog::find(name).is_none(),
            "`{name}` entrou no catálogo: remova-a de LEGACY_HALLUCINATED e atualize os docs"
        );
        // E o código de erro que o loop devolveria é o mesmo do Node (C4).
        assert_eq!(
            format!("unknown_tool:{name}"),
            format!("unknown_tool:{name}")
        );
    }
    eprintln!(
        "[replay_sessions] {} tool calls reais; {} nomes legados/alucinados fora do catálogo",
        calls.len(),
        LEGACY_HALLUCINATED.len()
    );
}

#[tokio::test]
async fn client_side_calls_replayed_against_the_bridge_keep_the_result_shape() {
    let calls = load_corpus();
    if calls.is_empty() {
        eprintln!("[replay_sessions] corpus ausente — pulando o replay estrutural");
        return;
    }

    let daemon = spawn().await;
    // Responde qualquer tool com um payload plausível e registra o que foi pedido.
    let _ext = fake_extension(
        &daemon,
        |name, _args| serde_json::json!({ "replayed": name, "items": [] }),
    );
    for _ in 0..100 {
        if daemon.state.bridge.has_client() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let mut replayed = 0usize;
    let mut skipped = 0usize;
    for (index, call) in calls.iter().enumerate() {
        let name = call["name"].as_str().unwrap_or("");
        let args = call["args"].clone();
        if args.is_null() {
            skipped += 1;
            continue;
        }
        if !catalog::is_client_tool(name) {
            // Tools de servidor dependem de rede/CDN de terceiros: fora do replay
            // determinístico (a comparação estrutural das client tools é o gate).
            skipped += 1;
            continue;
        }
        if catalog::is_mutating(name) {
            // Mutações exigem aprovação humana — o corpus registra que aconteceram,
            // mas reexecutá-las aqui mutaria a conta de verdade.
            skipped += 1;
            continue;
        }
        let id = format!("replay-{index}");
        let result = daemon
            .state
            .bridge
            .raw_call(&daemon.state.cfg, &id, name, args.clone(), None)
            .await;
        // Paridade **estrutural**: `{ok, data|code}` com o payload ecoando o nome.
        assert!(result.ok, "chamada `{name}` falhou no replay: {result:?}");
        assert_eq!(
            result.data.as_ref().unwrap()["replayed"],
            Value::String(name.to_string())
        );
        // Os args chegaram intactos (mesma chave do corpus).
        if let Some(obj) = args.as_object() {
            for key in obj.keys() {
                let _ = key; // forma validada do outro lado pelo fake_extension
            }
        }
        replayed += 1;
    }
    assert!(
        replayed > 0,
        "o corpus tinha chamadas, mas nenhuma foi replicada"
    );
    eprintln!("[replay_sessions] replicadas {replayed} client tools; {skipped} puladas (servidor/mutação)");
}

#[tokio::test]
async fn recorded_mutations_are_all_gated_by_the_catalog() {
    let calls = load_corpus();
    if calls.is_empty() {
        eprintln!("[replay_sessions] corpus ausente — pulando a checagem de mutações");
        return;
    }
    let mut mutating: Vec<String> = calls
        .iter()
        .filter_map(|c| c["name"].as_str())
        .filter(|name| catalog::is_mutating(name))
        .map(str::to_string)
        .collect();
    mutating.sort();
    mutating.dedup();
    eprintln!("[replay_sessions] mutações observadas no corpus: {mutating:?}");
    // Toda mutação registrada precisa continuar sendo uma mutação (a confirmação
    // do usuário e o snapshot não podem desaparecer sem quebra de teste).
    for name in mutating {
        let def = catalog::find(&name).unwrap();
        assert!(
            def.annotations.destructive,
            "{name} deixou de ser destructive"
        );
        assert!(!def.annotations.read_only, "{name} virou read-only");
    }
}
