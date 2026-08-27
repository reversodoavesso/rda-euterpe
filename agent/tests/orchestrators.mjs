import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(__dirname, "..");

let calls = 0;
let enrichResultRaw = "";

const mockLlm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls += 1;
    const payload = JSON.parse(body);
    if (calls === 2) {
      const toolMsg = payload.messages.find((m) => m.role === "tool");
      if (toolMsg) enrichResultRaw = toolMsg.content;
    }
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    let message;
    if (calls === 1) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "enrich_tracks", arguments: '{"ids":["t1","t2"]}' } }] };
    } else {
      message = { role: "assistant", content: "Análise enriquecida pronta." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
        choices: [{ index: 0, message, finish_reason: calls === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    );
  });
});

await new Promise((res) => mockLlm.listen(18999, "127.0.0.1", res));

const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: agentDir,
  shell: true,
  env: { ...process.env, DEEPSEEK_API_KEY: "test", LLM_BASE_URL: "http://127.0.0.1:18999", PORT: "8338", DB_PATH: "data/test.db", EUTERPE_SUGGESTIONS: "false" },
});

function killPort(port) {
  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore" }
      );
    }
  } catch {}
}

function killTree() {
  try {
    execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" });
  } catch {
    try {
      server.kill();
    } catch {}
  }
  killPort(8338);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

killPort(8338);

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8338/health");
      if (r.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error("agente não subiu");
}

let ok = false;
try {
  await waitHealth();
  const cfg = await (await fetch("http://127.0.0.1:8338/config")).json();
  const ws = new WebSocket("ws://127.0.0.1:8338/ws");
  let doneResolve;
  const done = new Promise((r) => (doneResolve = r));

  const toolCalls = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "tool.call") toolCalls.push(msg.name);
    if (msg.type === "chat.done") doneResolve();
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg.type || msg.type !== "tool.call") return;
    if (msg.name === "get_several_tracks") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: [
        { uri: "spotify:track:t1", name: "A", artists: ["X"], artist_ids: ["a1"], duration_ms: 200000 },
        { uri: "spotify:track:t2", name: "B", artists: ["X"], artist_ids: ["a1"], duration_ms: 180000 },
      ] }));
    }
    if (msg.name === "get_audio_features_bulk") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: [
        { id: "t1", valence: 0.1, energy: 0.2 }, { id: "t2", valence: 0.9, energy: 0.8 },
      ] }));
    }
    if (msg.name === "get_several_artists") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: [{ id: "a1", name: "X", genres: ["rock"], popularity: 80 }] }));
    }
  });

  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0" }));
  await wait(300);
  ws.send(JSON.stringify({ type: "chat.send", text: "analisa essas faixas", sessionId: "sess-enrich" }));
  await done;

  const enriched = enrichResultRaw ? JSON.parse(enrichResultRaw) : null;
  const first = enriched?.tracks?.[0];

  console.log("LLM calls:", calls);
  console.log("tool.calls:", toolCalls.join(","));
  console.log("entities:", enriched?.count);
  console.log("track1 genres:", first?.genres?.join(","));
  console.log("track1 features.valence:", first?.audio_features?.valence);
  console.log("track1 lyrics:", first?.lyrics === null ? "null(ok)" : first?.lyrics);

  ok = calls === 2 && toolCalls.includes("get_several_tracks") && toolCalls.includes("get_audio_features_bulk") && toolCalls.includes("get_several_artists") && enriched?.count === 2 && first?.genres?.includes("rock") && first?.audio_features?.valence === 0.1;

  ws.close();
  console.log(ok ? "PASS" : "FAIL");
} finally {
  killTree();
  mockLlm.close();
}
process.exit(ok ? 0 : 1);
