#!/usr/bin/env node
/**
 * tools/smoke-bridge.mjs — smoke test do bridge WS contra o daemon VIVO (8337).
 *
 * Fala exatamente o protocolo da extensão (contrato congelado C1/C2/C4/C5):
 *   GET /config  → secret
 *   hello        → hello.ok
 *   ping         → pong
 *   chat.send    → chat.status* + chat.stream* + chat.done
 *   mensagem inválida → chat.status{status:"error"} sem derrubar
 *
 * Uso:  node tools/smoke-bridge.mjs            (espera o daemon na 8337)
 *       node tools/smoke-bridge.mjs --port 8399
 *
 * Requer um cliente WebSocket: usa `ws` de `agent/node_modules` quando existe e
 * cai no WebSocket global do Node 22+ quando não.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8337;
const BASE = `http://127.0.0.1:${PORT}`;

let WebSocketImpl = globalThis.WebSocket;
const wsPath = join(repoRoot, "agent", "node_modules", "ws", "index.js");
if (!WebSocketImpl && existsSync(wsPath)) {
  WebSocketImpl = createRequire(import.meta.url)(wsPath);
}
if (!WebSocketImpl) {
  console.error("preciso de um cliente WebSocket (rode `npm install` em agent/ ou use Node 22+)");
  process.exit(2);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${ok || !detail ? "" : ` -> ${detail}`}`);
}

async function main() {
  const config = await (await fetch(`${BASE}/config`)).json();
  check("/config devolve secret", typeof config.secret === "string" && config.secret.length >= 32);
  check("/config.version é a do daemon", config.version === "0.2.0");

  const health = await (await fetch(`${BASE}/health`)).json();
  check("/health.app == euterpe", health.app === "euterpe");

  const ws = new WebSocketImpl(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", (err) => reject(err));
  });

  const expect = (type, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find((m) => m.type === type);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout esperando ${type}`)), timeoutMs);
      waiters.push({
        match: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });

  const send = (msg) => ws.send(JSON.stringify(msg));

  try {
    await open;
    check("WS conecta em /ws", true);

    // Handshake com segredo ERRADO: tem que fechar 1008 e não autenticar.
    const bad = new WebSocketImpl(`ws://127.0.0.1:${PORT}/ws`);
    const badClosed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      bad.addEventListener("open", () => bad.send(JSON.stringify({ type: "hello", secret: "errado", appVersion: "0.0.0" })));
      bad.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve({ code: ev.code, reason: ev.reason });
      });
      bad.addEventListener("error", () => {});
    });
    check("handshake inválido fecha com 1008", badClosed?.code === 1008, JSON.stringify(badClosed));

    send({ type: "hello", secret: config.secret, appVersion: "smoke", locale: "pt-br" });
    const ok = await expect("hello.ok");
    check("hello → hello.ok com a versão", ok.version === "0.2.0");

    send({ type: "ping" });
    await expect("pong");
    check("ping → pong", true);

    // Mensagem inválida não derruba a conexão (C2).
    ws.send("isso não é json");
    const invalid = await expect("chat.status");
    check("mensagem inválida → chat.status{error}", invalid.status === "error");

    send({ type: "client.debug", level: "log", detail: "smoke" });
    send({ type: "ping" });
    await expect("pong", 5000).catch(() => {});
    check("conexão sobrevive à mensagem inválida", ws.readyState === 1 || ws.readyState === WebSocketImpl.OPEN);

    // Chat: sem provider configurado o daemon degrada com fallback + chat.done.
    send({ type: "chat.send", text: "oi", sessionId: "smoke-bridge" });
    const seen = new Set();
    const collector = setInterval(() => inbox.forEach((m) => seen.add(m.type)), 20);
    const done = await Promise.race([
      (async () => {
        while (true) {
          const msg = await expect("chat.done");
          if (msg.sessionId === "smoke-bridge") return msg;
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout do chat.done")), 30000)),
    ]);
    clearInterval(collector);
    check("chat.send → chat.done da sessão", done.sessionId === "smoke-bridge");
    check("chat.stream foi emitido (o texto chegou)", seen.has("chat.stream"));
    check("suggestions é array", Array.isArray(done.suggestions));

    const deltas = inbox.filter((m) => m.type === "chat.stream").map((m) => m.delta).join("");
    console.log(`\n  resposta (${deltas.length} chars): ${JSON.stringify(deltas.slice(0, 160))}${deltas.length > 160 ? "…" : ""}`);
    check(
      "sem provider configurado o daemon explica (em vez de travar)",
      deltas.toLowerCase().includes("provider") || deltas.length > 0,
      deltas.slice(0, 120)
    );

    // chat.clear é confirmado com chat.cleared.
    send({ type: "chat.clear", sessionId: "smoke-bridge" });
    const cleared = await expect("chat.cleared", 10000);
    check("chat.clear → chat.cleared", cleared.sessionId === "smoke-bridge");
  } finally {
    try {
      ws.close();
    } catch (err) {}
  }

  const failed = checks.filter((c) => !c.ok);
  console.log("");
  if (failed.length) {
    console.log(`FALHOU: ${failed.length} de ${checks.length} checagens`);
    process.exit(1);
  }
  console.log(`OK: ${checks.length} checagens passaram`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`erro: ${err.message}`);
  process.exit(1);
});
