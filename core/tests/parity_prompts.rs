//! Paridade de prompts e funções puras de texto (contratos C7/C8/C9/C11).
//!
//! Os textos vivem em `core/src/assets/prompts.json` (gerados de
//! `agent/src/agent.ts`). Aqui os comparamos com as fixtures congeladas — ou
//! seja, provamos que o que roda é o que o Node produzia.

use euterpe::i18n;
use euterpe::llm::prompts;
use serde_json::Value;

fn text(name: &str) -> &'static str {
    match name {
        "system_en" => include_str!("fixtures/system_prompt_en.txt"),
        "system_ptbr" => include_str!("fixtures/system_prompt_ptbr.txt"),
        "system_debug" => include_str!("fixtures/system_prompt_debug.txt"),
        "system_ptbr_debug" => include_str!("fixtures/system_prompt_ptbr_debug.txt"),
        "suggestions_en" => include_str!("fixtures/suggestions_prompt_en.txt"),
        "suggestions_ptbr" => include_str!("fixtures/suggestions_prompt_ptbr.txt"),
        "routing_en" => include_str!("fixtures/routing_prompt_en.txt"),
        "routing_ptbr" => include_str!("fixtures/routing_prompt_ptbr.txt"),
        other => panic!("fixture desconhecida: {other}"),
    }
}

#[test]
fn system_prompt_matches_the_golden_in_all_four_combinations() {
    assert_eq!(prompts::system_prompt(Some("en"), false), text("system_en"));
    assert_eq!(
        prompts::system_prompt(Some("pt-BR"), false),
        text("system_ptbr")
    );
    assert_eq!(
        prompts::system_prompt(Some("en"), true),
        text("system_debug")
    );
    assert_eq!(
        prompts::system_prompt(Some("pt"), true),
        text("system_ptbr_debug")
    );
}

#[test]
fn suggestions_and_routing_prompts_match_the_golden() {
    assert_eq!(
        prompts::suggestions_prompt(Some("en")),
        text("suggestions_en")
    );
    assert_eq!(
        prompts::suggestions_prompt(Some("pt-br")),
        text("suggestions_ptbr")
    );
    assert_eq!(prompts::routing_prompt(Some("en")), text("routing_en"));
    assert_eq!(prompts::routing_prompt(Some("pt-br")), text("routing_ptbr"));
}

#[test]
fn force_answer_and_caps_come_from_the_asset() {
    assert!(prompts::force_answer_msg().contains("rate_limited"));
    assert!(prompts::force_answer_msg().contains("Do not call any more tools"));
    assert_eq!(prompts::max_final_length(), 4000);
    assert_eq!(prompts::stream_delay_ms(), 20);
}

#[test]
fn trim_final_matches_every_case_of_the_table() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/trim_final_cases.json")).unwrap();
    assert!(
        cases.len() >= 15,
        "a tabela de casos precisa cobrir os cenários do C7"
    );
    for case in cases {
        let input = case["in"].as_str().unwrap();
        let max = case["max"].as_u64().unwrap() as usize;
        let expected = case["out"].as_str().unwrap();
        assert_eq!(
            prompts::trim_final(input, max),
            expected,
            "caso `{}`",
            case["label"]
        );
    }
}

#[test]
fn parse_suggestions_matches_every_case_of_the_table() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/parse_suggestions_cases.json")).unwrap();
    assert!(
        cases.len() >= 15,
        "a tabela de casos precisa cobrir os cenários do C8"
    );
    for case in cases {
        let input = case["in"].as_str().unwrap();
        let expected: Vec<String> = case["out"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            prompts::parse_suggestions(input),
            expected,
            "caso `{}`",
            case["label"]
        );
    }
}

#[test]
fn i18n_table_covers_every_golden_key_with_the_same_values() {
    let golden: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("fixtures/i18n_keys.json")).unwrap();
    for (key, entry) in &golden {
        for locale in ["en", "pt-br"] {
            let expected = entry[locale].as_str().unwrap();
            let got = i18n::t(locale, key, &[]);
            assert_eq!(&got, expected, "i18n `{key}` em `{locale}` divergiu");
        }
    }
}

#[test]
fn rust_only_i18n_extras_are_exactly_the_expected_ones() {
    // Chaves que o Rust acrescenta de propósito (documentadas em CHANGES.md):
    //  - status.clientOffline: o Node não tinha o conceito de cliente offline.
    //  - fallback.noApiKeyRust: o texto do Node fala de DEEPSEEK_API_KEY no
    //    agent/.env, que não existe mais neste daemon.
    let extra: Vec<&str> = i18n::STRINGS
        .iter()
        .map(|(k, _, _)| *k)
        .filter(|k| {
            let golden: serde_json::Map<String, Value> =
                serde_json::from_str(include_str!("fixtures/i18n_keys.json")).unwrap();
            !golden.contains_key(*k)
        })
        .collect();
    assert_eq!(extra, vec!["status.clientOffline", "fallback.noApiKeyRust"]);
}

#[test]
fn normalize_locale_matches_the_case_table() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/normalize_locale_cases.json")).unwrap();
    for case in cases {
        let raw = case["raw"].as_str();
        assert_eq!(
            i18n::normalize_locale(raw),
            case["out"].as_str().unwrap(),
            "raw={raw:?}"
        );
    }
}

#[test]
fn curation_routing_matches_the_node_hints() {
    assert!(prompts::is_curation_request("crie uma playlist de foco"));
    assert!(prompts::is_curation_request(
        "create a playlist for running"
    ));
    assert!(prompts::is_curation_request("me recomenda algo"));
    assert!(!prompts::is_curation_request("determine o tempo"));
    assert!(!prompts::is_curation_request("pause"));
}

#[test]
fn brand_voice_invariants_hold() {
    // 1. Prompts de sistema carregam a seção VOICE (house style)
    let en = prompts::system_prompt(Some("en"), false);
    let pt = prompts::system_prompt(Some("pt-br"), false);

    assert!(en.contains("VOICE (house style"));
    assert!(pt.contains("VOICE (house style"));
    assert!(en.contains("You are Euterpe, the resident music curator: a muse, not a tool"));
    assert!(pt.contains("a Euterpe avisa"));

    // 2. Proibição explícita de chamar-se "an AI" ou "virtual assistant"
    assert!(en.contains("Never describe yourself as \"an AI\""));
    assert!(pt.contains("Never describe yourself as \"an AI\""));

    // 3. Proibição de fillers
    assert!(en.contains("no filler openings or closings"));
    assert!(pt.contains("Como posso ajudar?"));

    // 4. Template de componentes nativos obrigatório
    assert!(en.contains("COMPONENT TEMPLATES"));
    assert!(en.contains("{{spotify:type:uri|Label}}"));
    assert!(pt.contains("COMPONENT TEMPLATES"));
    assert!(pt.contains("{{spotify:type:uri|Label}}"));

    // 5. Sugestões proíbem fillers e emojis
    let sugg_en = prompts::suggestions_prompt(Some("en"));
    let sugg_pt = prompts::suggestions_prompt(Some("pt-br"));
    assert!(sugg_en.contains("Never use generic filler"));
    assert!(sugg_pt.contains("Never use generic filler"));
    assert!(sugg_en.contains("Never use the {{spotify:...}} template, markdown or emojis"));
    assert!(sugg_pt.contains("Never use the {{spotify:...}} template, markdown or emojis"));
}
