//! Prompts e funções puras de texto (contratos C7/C8/C9).
//!
//! Os *textos* são dados gerados da fonte de verdade Node
//! (`core/src/assets/prompts.json`, ver `agent/tools/export-goldens.mjs`); a
//! *lógica* de seleção/limpeza é Rust e é o que `parity_prompts.rs` testa contra
//! `core/tests/fixtures/*`.

use regex::Regex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const ASSET: &str = include_str!("../assets/prompts.json");

#[derive(Debug, serde::Deserialize)]
struct Assets {
    system: BTreeMap<String, String>,
    suggestions: BTreeMap<String, String>,
    routing: BTreeMap<String, String>,
    #[serde(rename = "forceAnswer")]
    force_answer: String,
    #[serde(rename = "maxFinalLength")]
    max_final_length: usize,
    #[serde(rename = "streamDelayMs")]
    stream_delay_ms: u64,
}

fn assets() -> &'static Assets {
    static ASSETS: OnceLock<Assets> = OnceLock::new();
    ASSETS.get_or_init(|| {
        serde_json::from_str(ASSET)
            .expect("core/src/assets/prompts.json inválido — rode `npm run goldens`")
    })
}

/// Prompt de sistema (C9). `debug` liga o bloco técnico do Node.
pub fn system_prompt(locale: Option<&str>, debug: bool) -> String {
    let base = crate::i18n::normalize_locale(locale);
    let key = if debug {
        format!("{base}-debug")
    } else {
        base.to_string()
    };
    assets()
        .system
        .get(&key)
        .or_else(|| assets().system.get(base))
        .or_else(|| assets().system.get("en"))
        .cloned()
        .unwrap_or_default()
}

/// Prompt das sugestões dinâmicas.
pub fn suggestions_prompt(locale: Option<&str>) -> String {
    let base = crate::i18n::normalize_locale(locale);
    assets()
        .suggestions
        .get(base)
        .cloned()
        .unwrap_or_else(|| assets().suggestions.get("en").cloned().unwrap_or_default())
}

/// Prompt do roteamento por troca de faixa.
pub fn routing_prompt(locale: Option<&str>) -> String {
    let base = crate::i18n::normalize_locale(locale);
    assets()
        .routing
        .get(base)
        .cloned()
        .unwrap_or_else(|| assets().routing.get("en").cloned().unwrap_or_default())
}

/// Instrução injetada quando o Spotify estrangula as tools (2× rate_limited).
pub fn force_answer_msg() -> &'static str {
    &assets().force_answer
}

pub fn max_final_length() -> usize {
    assets().max_final_length
}

pub fn stream_delay_ms() -> u64 {
    assets().stream_delay_ms
}

/* ------------------------------------------------------------- trimFinal (C7) */

/// Corta a resposta num limite seguro: nunca dentro de `{{spotify:...}}` e
/// preferindo quebra de parágrafo. Espelho fiel de `trimFinal()` — inclusive no
/// uso de índices por *caractere* (o `slice` do JS corta por unidade UTF-16; para
/// os casos reais, BMP, o índice de caractere coincide).
pub fn trim_final(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() <= max {
        return text.to_string();
    }
    let mut cut: Vec<char> = chars[..max].to_vec();

    let last_index = |hay: &[char], needle: &[char]| -> i64 {
        if needle.is_empty() || hay.len() < needle.len() {
            return -1;
        }
        (0..=hay.len() - needle.len())
            .rev()
            .find(|&i| hay[i..i + needle.len()] == *needle)
            .map(|i| i as i64)
            .unwrap_or(-1)
    };

    let open = last_index(&cut, &['{', '{']);
    let close = last_index(&cut, &['}', '}']);
    if open > close {
        cut.truncate(open.max(0) as usize);
    }

    let nl = last_index(&cut, &['\n', '\n']);
    let sp = last_index(&cut, &[' ']);
    let boundary = nl.max(sp);
    if boundary >= 0 && (boundary as f64) >= (max as f64) * 0.5 {
        cut.truncate(boundary as usize);
    }

    let trimmed: String = cut.iter().collect::<String>().trim_end().to_string();
    format!("{trimmed}…")
}

/* -------------------------------------------------------- parseSuggestions (C8) */

fn fence_start() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^```(?:json)?\s*").unwrap())
}

fn fence_end() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"```\s*$").unwrap())
}

fn trailing_comma() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r",\s*([\]}])").unwrap())
}

fn spotify_template() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*spotify:[^}|]+\|([^}]*?)\s*\}\}").unwrap())
}

fn any_template() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{[^}]*\}\}").unwrap())
}

fn whitespace() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

pub const MAX_SUGGESTIONS: usize = 3;
pub const MAX_SUGGESTION_CHARS: usize = 60;

/// Extrai até 3 sugestões, tolerando fences, `[...]` solto, trailing comma e
/// templates vazados. Nunca falha: qualquer erro devolve `[]`.
pub fn parse_suggestions(raw: &str) -> Vec<String> {
    let mut s = raw.trim().to_string();
    s = fence_start().replace(&s, "").to_string();
    s = fence_end().replace(&s, "").to_string();
    s = s.trim().to_string();

    let start = match s.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match s.rfind(']') {
        Some(i) => i,
        None => return Vec::new(),
    };
    if end <= start {
        return Vec::new();
    }
    let slice = &s[start..=end];
    let cleaned = trailing_comma().replace_all(slice, "$1").to_string();

    let parsed: Value = match serde_json::from_str(&cleaned) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match parsed.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };

    arr.iter()
        .filter_map(|item| item.as_str())
        .map(|item| {
            let with_labels = spotify_template().replace_all(item, "$1").to_string();
            let no_templates = any_template().replace_all(&with_labels, "").to_string();
            whitespace()
                .replace_all(&no_templates, " ")
                .trim()
                .to_string()
        })
        .filter(|item| !item.is_empty() && item.chars().count() <= MAX_SUGGESTION_CHARS)
        .take(MAX_SUGGESTIONS)
        .collect()
}

/* ------------------------------------------------------------ roteamento (C9) */

/// Pedidos de curadoria vão para o modelo mais forte (paridade com
/// `isCurationRequest`). Manter bilíngue; `\btermin` evita falsos positivos.
pub const CURATION_HINTS: &[&str] = &[
    "criar playlist",
    "crie uma playlist",
    "playlist de",
    "recomenda",
    "curadoria",
    "mood",
    "vibe",
    "tema",
    "término",
    "artistas similares",
    "artistas parecidos",
    "suger",
    "create playlist",
    "create a playlist",
    "playlist of",
    "recommend",
    "curat",
    "breakup",
    "similar artists",
    "suggest",
];

fn termin_word() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\btermin").unwrap())
}

pub fn is_curation_request(text: &str) -> bool {
    let lower = text.to_lowercase();
    if termin_word().is_match(&lower) {
        return true;
    }
    CURATION_HINTS.iter().any(|h| lower.contains(h))
}

/// `friendlyToolLabel` (usa `tool.<name>` quando existe).
pub fn friendly_tool_label(locale: &str, name: &str) -> String {
    crate::i18n::friendly_tool_label(locale, name)
}

/// Conteúdo da mensagem `tool` enviada de volta ao modelo.
pub fn tool_result_content(
    ok: bool,
    data: Option<&Value>,
    code: Option<&str>,
    debug: bool,
) -> String {
    if ok {
        return serde_json::to_string(data.unwrap_or(&Value::Null))
            .unwrap_or_else(|_| "{}".to_string());
    }
    match code {
        Some("rate_limited") => serde_json::json!({ "error": "rate_limited" }).to_string(),
        Some(code) if debug => serde_json::json!({ "error": code }).to_string(),
        _ => serde_json::json!({ "error": "tool_failed" }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases(name: &str) -> Vec<Value> {
        let raw = match name {
            "trim" => include_str!("../../tests/fixtures/trim_final_cases.json"),
            _ => include_str!("../../tests/fixtures/parse_suggestions_cases.json"),
        };
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn trim_final_matches_every_golden_case() {
        for case in cases("trim") {
            let input = case["in"].as_str().unwrap();
            let max = case["max"].as_u64().unwrap() as usize;
            let expected = case["out"].as_str().unwrap();
            let got = trim_final(input, max);
            assert_eq!(got, expected, "caso {}", case["label"]);
        }
    }

    #[test]
    fn parse_suggestions_matches_every_golden_case() {
        for case in cases("parse") {
            let input = case["in"].as_str().unwrap();
            let expected: Vec<String> = case["out"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let got = parse_suggestions(input);
            assert_eq!(got, expected, "caso {}", case["label"]);
        }
    }

    #[test]
    fn curation_request_detection() {
        assert!(is_curation_request("crie uma playlist de foco"));
        assert!(is_curation_request("Recommend me something"));
        assert!(is_curation_request("artistas similares"));
        assert!(is_curation_request("a playlist para término"));
        // `\btermin` não pode casar "determine".
        assert!(!is_curation_request("determine the tempo"));
        assert!(!is_curation_request("pause the music"));
    }

    #[test]
    fn tool_result_content_hides_details_unless_debug() {
        assert_eq!(
            tool_result_content(true, Some(&serde_json::json!({"a":1})), None, false),
            "{\"a\":1}"
        );
        assert_eq!(
            tool_result_content(false, None, Some("rate_limited"), false),
            "{\"error\":\"rate_limited\"}"
        );
        assert_eq!(
            tool_result_content(false, None, Some("client_offline"), false),
            "{\"error\":\"tool_failed\"}"
        );
        assert_eq!(
            tool_result_content(false, None, Some("client_offline"), true),
            "{\"error\":\"client_offline\"}"
        );
    }

    #[test]
    fn prompts_are_loaded_from_the_asset() {
        let en = system_prompt(Some("en"), false);
        assert!(en.contains("You are Euterpe"));
        assert!(!en.contains("DEBUG MODE ON"));
        let dbg = system_prompt(Some("pt-br"), true);
        assert!(dbg.contains("DEBUG MODE ON"));
        assert!(dbg.contains("Portuguese"));
        assert!(suggestions_prompt(Some("pt-br")).contains("Euterpe's follow-up suggestor"));
        assert!(routing_prompt(None).contains("router"));
        assert!(force_answer_msg().contains("rate_limited"));
        assert_eq!(max_final_length(), 4000);
    }
}
