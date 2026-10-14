#!/usr/bin/env node
/**
 * Fase 1 (PLAN-REFACTOR.md) — exporta os GOLDENS do agente Node para
 * `core/tests/fixtures/`. Sem isto, "paridade" entre Node e Rust é opinião.
 *
 * Regras:
 *  - Tudo é derivado do código compilado (`agent/dist`), nunca duplicado aqui.
 *  - Serialização determinística (chaves ordenadas, indent 2, \n final) para que
 *    `git status --porcelain core/tests/fixtures` fique limpo após o commit.
 *  - Nenhum timestamp, path absoluto ou dado do usuário entra nas fixtures.
 *
 * Uso:  cd agent && npm run build && node tools/export-goldens.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientTools, serverTools, MUTATING_TOOLS } from "../dist/tools/defs.js";
import { buildSystemPrompt, buildRoutingPrompt, SUGGESTIONS_PROMPT, parseSuggestions, trimFinal, FORCE_ANSWER_MSG, MAX_FINAL_LENGTH, STREAM_DELAY_MS, SUGGESTIONS_MAX_TOKENS } from "../dist/agent.js";
import { AGENT_STRINGS, normalizeLocale } from "../dist/i18n.js";
import { SCHEMA_SQL } from "../dist/db.js";
import { config } from "../dist/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "..", "core", "tests", "fixtures");
mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- utils */

/** JSON determinístico: ordena chaves em todos os níveis. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

const written = [];
function writeJson(name, value) {
  const body = JSON.stringify(stable(value), null, 2) + "\n";
  writeFileSync(resolve(OUT, name), body, "utf8");
  written.push(name);
}
function writeText(name, text) {
  writeFileSync(resolve(OUT, name), text, "utf8");
  written.push(name);
}

/* ------------------------------------------------------------- catálogo */

/** Contrato C6: mesmos `name`/`parameters`/`required`/`side` (JSON diff no Rust). */
const catalogOf = (defs) =>
  defs.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    parameters: d.function.parameters,
    side: d.side,
  }));

writeJson("tools_client.json", catalogOf(clientTools));
writeJson("tools_server.json", catalogOf(serverTools));
writeJson("tools_mutating.json", [...MUTATING_TOOLS].sort());
writeJson("tools_counts.json", { client: clientTools.length, server: serverTools.length, total: clientTools.length + serverTools.length });

// D5 — o catálogo é UM só. O Rust consome este asset gerado (mesma fonte de
// verdade: `defs.ts`), então o loop LLM interno e o servidor MCP nunca divergem.
// As *anotações* MCP (readOnly/destructive/idempotent) são conhecimento do Rust
// e vivem em `core/src/tools/catalog.rs`.
const ASSETS = resolve(__dirname, "..", "..", "core", "src", "assets");
mkdirSync(ASSETS, { recursive: true });
const catalogAsset = {
  _generated: "agent/tools/export-goldens.mjs — NÃO editar à mão (fonte: agent/src/tools/defs.ts)",
  client: catalogOf(clientTools),
  server: catalogOf(serverTools),
  mutating: [...MUTATING_TOOLS].sort(),
};
writeFileSync(resolve(ASSETS, "tools.json"), JSON.stringify(stable(catalogAsset), null, 2) + "\n", "utf8");
console.log(`catálogo de runtime escrito em ${resolve(ASSETS, "tools.json")}`);

/* -------------------------------------------------------------- prompts */

// `config` é objeto mutável exportado: alternamos o modo debug para capturar as
// duas variantes sem precisar de dois processos.
const prompts = { system: {}, suggestions: {}, routing: {} };
for (const locale of ["en", "pt-br"]) {
  config.debug = false;
  prompts.system[locale] = buildSystemPrompt(locale);
  prompts.suggestions[locale] = SUGGESTIONS_PROMPT(locale);
  prompts.routing[locale] = buildRoutingPrompt(locale);
  config.debug = true;
  prompts.system[`${locale}-debug`] = buildSystemPrompt(locale);
}
config.debug = false;

writeText("system_prompt_en.txt", prompts.system["en"]);
writeText("system_prompt_ptbr.txt", prompts.system["pt-br"]);
writeText("system_prompt_debug.txt", prompts.system["en-debug"]);
writeText("system_prompt_ptbr_debug.txt", prompts.system["pt-br-debug"]);
writeText("suggestions_prompt_en.txt", prompts.suggestions["en"]);
writeText("suggestions_prompt_ptbr.txt", prompts.suggestions["pt-br"]);
writeText("routing_prompt_en.txt", prompts.routing["en"]);
writeText("routing_prompt_ptbr.txt", prompts.routing["pt-br"]);

// Asset de runtime (mesma decisão do catálogo D5): prompts são *dados* gerados da
// fonte de verdade (`agent/src/agent.ts`). A lógica de seleção/interpolação é
// Rust (`core/src/llm/prompts.rs`) e é o que `parity_prompts.rs` testa.
const ASSETS_PROMPTS = resolve(__dirname, "..", "..", "core", "src", "assets");
mkdirSync(ASSETS_PROMPTS, { recursive: true });
writeFileSync(
  resolve(ASSETS_PROMPTS, "prompts.json"),
  JSON.stringify(
    stable({
      _generated: "agent/tools/export-goldens.mjs — NÃO editar à mão (fonte: agent/src/agent.ts)",
      ...prompts,
      forceAnswer: FORCE_ANSWER_MSG,
      maxFinalLength: MAX_FINAL_LENGTH,
      streamDelayMs: STREAM_DELAY_MS,
      suggestionsMaxTokens: SUGGESTIONS_MAX_TOKENS,
    }),
    null,
    2
  ) + "\n",
  "utf8"
);
console.log(`prompts de runtime escritos em ${resolve(ASSETS_PROMPTS, "prompts.json")}`);

/* ------------------------------------------------------- trimFinal (C7) */

const T = "{{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}";
const CASES_TRIM = [
  ["short_as_max", "hello world", 11],
  ["empty", "", 10],
  ["exact_max", "abcdef", 6],
  ["one_over", "abcdefg", 6],
  ["paragraph_boundary", `first paragraph here.\n\nsecond paragraph that is much longer`, 40],
  ["no_boundary_after_half", "x".repeat(60), 40],
  ["space_boundary", "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii", 30],
  ["template_cut_inside", `intro text ${T} tail`, 30],
  ["template_whole_kept", `intro ${T}`, 60],
  ["template_exactly_at_cut", `${T} and more`, 50],
  ["newline_then_space", "line one\nline two is here and it keeps going", 25],
  ["many_templates", `${T}${T}${T}${T}${T}${T}${T}${T}${T}${T}`, 80],
  ["trailing_whitespace", "abcdefgh        ", 8],
  ["half_boundary_is_ok", "aaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 20],
  ["max_zero", "abcdef", 0],
  ["unicode", "ação çãõ ê ü — travessão", 10],
];
writeJson(
  "trim_final_cases.json",
  CASES_TRIM.map(([label, input, max]) => ({ label, in: input, max, out: trimFinal(input, max) }))
);

/* --------------------------------------------- parseSuggestions (C8) */

const T2 = "{{spotify:track:4cOdK2wGLETKBW3PvgPWqT|Creep}}";
const CASES_PARSE = [
  ["plain_object", '{"suggestions": ["a", "b", "c"]}'],
  ["bare_array", '["a", "b", "c"]'],
  ["fenced", '```json\n{"suggestions": ["a", "b", "c"]}\n```'],
  ["trailing_comma", '{"suggestions": ["a", "b", "c",]}'],
  ["more_than_three", '{"suggestions": ["a", "b", "c", "d", "e"]}'],
  ["too_long_dropped", JSON.stringify({ suggestions: ["ok", "x".repeat(61), "ok2"] })],
  ["non_string_dropped", '{"suggestions": ["a", 1, null, "b"]}'],
  ["template_to_label", JSON.stringify({ suggestions: [`veja ${T2}`, "curto"] })],
  ["unknown_template_removed", '{"suggestions": ["a {{foo:bar}} b", "c"]}'],
  ["garbage", "not json at all"],
  ["empty_string", ""],
  ["empty_array", "[]"],
  ["no_array", '{"suggestions": {"a": 1}}'],
  ["whitespace_collapse", '{"suggestions": ["  a    b   ", "c"]}'],
  ["reversed_brackets", '[ "a" }'],
  ["nested_code_block", "```\n```json\n[\"a\",\"b\"]\n```\n```"],
];
writeJson(
  "parse_suggestions_cases.json",
  CASES_PARSE.map(([label, input]) => ({ label, in: input, out: parseSuggestions(input) }))
);

/* -------------------------------------------------------------- i18n (C11) */

writeJson("i18n_keys.json", AGENT_STRINGS);
writeJson("i18n_locales.json", ["en", "pt-br"]);
writeJson(
  "normalize_locale_cases.json",
  ["pt", "pt-BR", "pt-br", "en", "en-US", "ES", "", " fr ", null, undefined].map((raw) => ({
    raw: raw === undefined ? null : raw,
    out: normalizeLocale(raw),
  }))
);

/* ------------------------------------------------------------- schema (C10) */

writeText("schema.sql", SCHEMA_SQL);

/* ---------------------------------------------------------------- report */

console.log(`goldens escritos em ${OUT}:`);
for (const f of written.sort()) console.log(`  - ${f}`);
console.log(`catálogo: ${clientTools.length} client + ${serverTools.length} server = ${clientTools.length + serverTools.length}`);
