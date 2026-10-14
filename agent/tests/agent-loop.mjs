import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(__dirname, "..");

let calls = 0;
const receivedMessages = [];

const mockLlm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls += 1;
    const payload = JSON.parse(body);
    receivedMessages.push(payload.messages.map((m) => ({ role: m.role, content: m.content ?? null })));
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    let message;
    if (calls === 1) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_playlists", type: "function", function: { name: "get_playlists", arguments: "{}" } },
          { id: "call_tracks", type: "function", function: { name: "get_playlist_tracks", arguments: '{"playlist_id":"abc123"}' } },
        ],
      };
    } else if (calls === 2) {
      message = { role: "assistant", content: "Test answer A" };
    } else {
      message = { role: "assistant", content: "Test answer B (with context)" };
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
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "test",
    LLM_BASE_URL: "http://127.0.0.1:18999",
    PORT: "8338",
    DB_PATH: "data/test.db",
    CHAT_HISTORY: "4",
    EUTERPE_SUGGESTIONS: "false",
  },
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
  } catch (err) {
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
  throw new Error("agent did not start");
}

let ok = false;
try {
  await waitHealth();
  const cfg = await (await fetch("http://127.0.0.1:8338/config")).json();
  const ws = new WebSocket("ws://127.0.0.1:8338/ws");

  const got = [];
  let sessionId = null;
  let pendingDone = null;

  function onDone(resolve) {
    pendingDone = resolve;
  }

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    got.push(msg);
    if (msg.type === "chat.done" && msg.sessionId) sessionId = msg.sessionId;
    if (msg.type === "chat.done" && pendingDone) {
      const r = pendingDone;
      pendingDone = null;
      r();
    }
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "tool.call" && msg.name === "get_playlists") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: true, data: { playlists: [{ id: "p1", name: "My playlist" }] } }));
    }
    if (msg.type === "tool.call" && msg.name === "get_playlist_tracks") {
      ws.send(JSON.stringify({ type: "tool.result", id: msg.id, ok: false, code: "boom" }));
    }
  });

  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "hello", secret: cfg.secret, appVersion: "0.1.0" }));
  await wait(300);

  // first message (with tools)
  ws.send(JSON.stringify({ type: "chat.send", text: "first question", sessionId: "test-session" }));
  await new Promise((res) => onDone(res));

  // second message in the same session (checks history)
  ws.send(JSON.stringify({ type: "chat.send", text: "second question", sessionId: "test-session" }));
  await new Promise((res) => onDone(res));

  // clear
  ws.send(JSON.stringify({ type: "chat.clear", sessionId: "test-session" }));
  await wait(400);

  const toolCalls = got.filter((m) => m.type === "tool.call").map((m) => m.name);
  const finalA = got.filter((m) => m.type === "chat.stream").slice(0, 10).map((m) => m.delta).join("");
  const hasCleared = got.some((m) => m.type === "chat.cleared");

  // history: the 3rd LLM call must contain the 1st question and answer A
  const call3Messages = receivedMessages[2] ?? [];
  const hasFirstUser = call3Messages.some((m) => m.role === "user" && m.content === "first question");
  const hasAnswerA = call3Messages.some((m) => m.role === "assistant" && m.content === "Test answer A");

  console.log("LLM calls:", calls);
  console.log("tool.calls:", toolCalls.join(","));
  console.log("answer A:", finalA.includes("Test answer A") ? "ok" : "MISSING");
  console.log("history (1st question):", hasFirstUser ? "ok" : "MISSING");
  console.log("history (answer A):", hasAnswerA ? "ok" : "MISSING");
  console.log("chat.cleared:", hasCleared ? "ok" : "MISSING");

  ok =
    calls === 3 &&
    toolCalls.includes("get_playlists") &&
    toolCalls.includes("get_playlist_tracks") &&
    finalA.includes("Test answer A") &&
    hasFirstUser &&
    hasAnswerA &&
    hasCleared;

  ws.close();
  console.log(ok ? "PASS" : "FAIL");
} finally {
  killTree();
  mockLlm.close();
}
process.exit(ok ? 0 : 1);
