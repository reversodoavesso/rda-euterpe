#!/usr/bin/env node
/**
 * Fase 1/2 (PLAN-REFACTOR.md, A'') — corpus de replay.
 *
 * Extrai os eventos `tool.call` reais (com args completos) de
 * `agent/data/sessions/*.log` (JSONL) para
 * `core/tests/fixtures/sessions/<session>.jsonl`.
 *
 * ⚠️ PRIVACIDADE: `args` contém termos de busca, IDs e nomes de playlists —
 * dado pessoal de escuta. Por isso `core/tests/fixtures/sessions/` é
 * **gitignored** (ver `.gitignore`): a evidência fica só na máquina local e o
 * `core/tests/replay_sessions.rs` pula com mensagem explícita quando ausente.
 *
 * Uso:  node agent/tools/export-replay-corpus.mjs
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = resolve(__dirname, "..", "data", "sessions");
const OUT = resolve(__dirname, "..", "..", "core", "tests", "fixtures", "sessions");

if (!existsSync(SESSIONS_DIR)) {
  console.error(`sem sessões em ${SESSIONS_DIR} — nada a exportar`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Ids de `tool.call` cujo nome NÃO entra no corpus (não é tool de catálogo). */
const SKIP = new Set(["probe"]);

let total = 0;
let files = 0;
for (const f of readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".log")).sort()) {
  const rows = [];
  for (const line of readFileSync(join(SESSIONS_DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.event !== "tool.call") continue;
    const p = ev.payload ?? {};
    if (!p.name || SKIP.has(p.name)) continue;
    rows.push({
      session: ev.session ?? null,
      ts: ev.ts ?? null,
      name: p.name,
      args: p.args ?? {},
      ok: typeof p.ok === "boolean" ? p.ok : null,
      code: p.code ?? null,
      duration_ms: typeof p.duration_ms === "number" ? p.duration_ms : null,
    });
  }
  if (!rows.length) continue;
  const name = f.replace(/\.log$/, "") + ".jsonl";
  writeFileSync(join(OUT, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  total += rows.length;
  files += 1;
}

// Manifesto (também gitignored): o teste Rust usa para reportar a cobertura.
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ files, calls: total }, null, 2) + "\n", "utf8");

console.log(`corpus de replay: ${total} tool calls de ${files} sessões → ${OUT}`);
if (total === 0) console.log("(nenhum tool.call registrado ainda — rode o mod no Spotify antes)");
