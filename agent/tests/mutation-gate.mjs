import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(__dirname, "..");

let calls = 0;

const mockLlm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls += 1;
    const payload = JSON.parse(body);
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    let message;
    if (calls === 1) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_playlists", arguments: "{}" } }] };
    } else if (calls === 2) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "create_playlist", arguments: '{"name":"Playlist Aprovada","tracks":["spotify:track:1"]}' } }] };
    } else if (calls === 3) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "create_playlist", arguments: '{"name":"rejeitar esta","tracks":["spotify:track:2"]}' } }] };
    } else {
      message = { role: "assistant", content: "Fluxo de mutação finalizado." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock",
        choices: [{ index: 0, message, finish_reason: calls <= 3 ? "tool_calls" : "stop" }],
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

  const got = [];
  let pendingDone = null;
  let createCalls = 0;

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    got.push(msg);
    if (msg.type === "chat.done" && pendingDone) {
      const r = pendingDone;
      pendingDone = null;
      r();
    }
    if (msg.type === "tool.call" && msg.name === "create_playlist") createCalls += 1;
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "proposal.create") {
      const decision = msg.title && msg.title.toLowerCase().includes("rejeitar") ? "reject" : "approve";
      ws.send(JSON.stringify({ type: "proposal.decision", proposalId: msg.proposalId, decision }));
    }
    if (msg.type === "tool.call" && msg.name === "get_playlists") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: { playlists: [{ id: "p0", name: "Base" }] } }));
    }
    if (msg.type === "tool.call" && msg.name === "create_playlist") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: { playlist_id: "p1", name: msg.args.name, added: (msg.args.tracks || []).length } }));
    }
  });

  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0" }));
  await wait(300);

  ws.send(JSON.stringify({ type: "chat.send", text: "cria playlists", sessionId: "sess-mut" }));
  await new Promise((res) => (pendingDone = res));

  const proposals = got.filter((m) => m.type === "proposal.create");
  const finalText = got.filter((m) => m.type === "chat.stream").map((m) => m.delta).join("");

  console.log("LLM calls:", calls);
  console.log("proposals:", proposals.length);
  console.log("create_playlist tool.call:", createCalls);
  console.log("texto final:", finalText);

  // esperado: 1 proposta aprovada (tool.call executado) + 1 rejeitada (sem tool.call)
  ok = calls === 4 && proposals.length === 2 && createCalls === 1 && finalText.includes("finalizado");
  ws.close();
  console.log(ok ? "PASS" : "FAIL");
} finally {
  killTree();
  mockLlm.close();
}
process.exit(ok ? 0 : 1);
