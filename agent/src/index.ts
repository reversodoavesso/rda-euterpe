import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { RawData, WebSocket as WsWebSocket } from "ws";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { MessageSchema, VERSION, type ClientMessage, type ServerMessage, type ToolCallRequest } from "./protocol.js";
import { handleChat, handleSongChange } from "./agent.js";
import { clearHistory, saveSnapshot } from "./db.js";
import { MUTATING_TOOLS } from "./tools/defs.js";
import { logSession, listSessions, readSession } from "./logging.js";
import { AGENT_STRINGS, makeT, normalizeLocale, type Translator } from "./i18n.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = resolve(__dirname, "..", "data", "probes");

const app = Fastify({ logger: { level: "info" } });
await app.register(websocket);

const db = openDb();

// Most recent authenticated client socket. GET /probe uses it to run a
// read-only inventory *inside* the Spotify client (extension `case "probe"`),
// so results land in a file instead of being copy-pasted from DevTools.
interface ActiveClient {
  callTool: (call: ToolCallRequest) => Promise<{ ok: boolean; data?: unknown; code?: string }>;
}
let activeClient: ActiveClient | null = null;

type WsSend = (msg: ServerMessage) => void;

function makeSend(socket: WsWebSocket): WsSend {
  return (msg) => socket.send(JSON.stringify(msg));
}

interface PendingTool {
  resolve: (result: { ok: boolean; data?: unknown; code?: string }) => void;
  timer: NodeJS.Timeout;
}

interface PendingProposal {
  resolve: (decision: "approve" | "reject") => void;
  timer: NodeJS.Timeout;
}

function summarize(t: Translator, name: string, args: Record<string, unknown>): string {
  const count = (key: string): number => (Array.isArray(args[key]) ? (args[key] as unknown[]).length : 0);
  switch (name) {
    case "create_playlist":
      return t("proposal.createPlaylist", { name: String(args.name ?? ""), count: count("tracks") });
    case "add_tracks":
      return t("proposal.addTracks", { count: count("uris") });
    case "remove_tracks":
      return t("proposal.removeTracks", { count: count("uris") });
    case "set_playlist_details":
      return t("proposal.setDetails");
    case "replace_playlist_tracks":
      return t("proposal.replaceTracks", { count: count("uris") });
    case "set_playlist_cover":
      return t("proposal.setCover");
    default:
      return t("proposal.execute", { name });
  }
}

function requestClientTool(
  socket: WsWebSocket,
  send: WsSend,
  pending: Map<string, PendingTool>,
  pendingProposals: Map<string, PendingProposal>,
  db: Database.Database,
  getSessionId: () => string | null,
  getT: () => Translator
) {
  return async (call: ToolCallRequest): Promise<{ ok: boolean; data?: unknown; code?: string }> => {
    const sid = getSessionId() ?? "unknown";
    if (MUTATING_TOOLS.has(call.name)) {
      const proposalId = randomUUID();
      const summary = summarize(getT(), call.name, call.args);
      logSession(sid, "proposal.created", { proposalId, title: summary, name: call.name, args: call.args });
      const approved = await new Promise<"approve" | "reject">((resolve) => {
        const timer = setTimeout(() => {
          pendingProposals.delete(proposalId);
          resolve("reject");
        }, 120000);
        pendingProposals.set(proposalId, { resolve, timer });
        send({
          type: "proposal.create",
          proposalId,
          kind: "tool",
          title: summary,
          name: call.name,
          args: call.args,
        });
      });
      logSession(sid, "proposal.decided", { proposalId, decision: approved });
      if (approved !== "approve") {
        return { ok: false, code: "user_rejected" };
      }

      if (call.args.playlist_id) {
        const snapshotRes = await new Promise<{ ok: boolean; data?: unknown; code?: string }>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(`snap_${call.id}`);
            resolve({ ok: false, code: "client_timeout" });
          }, 30000);
          pending.set(`snap_${call.id}`, { resolve, timer });
          send({
            type: "tool.call",
            id: `snap_${call.id}`,
            name: "get_playlist_tracks",
            args: { playlist_id: call.args.playlist_id },
          });
        });
        if (snapshotRes.ok) {
          const tracks = (snapshotRes.data as { uri?: string }[] | undefined) ?? [];
          saveSnapshot(db, String(call.args.playlist_id), tracks.map((t) => t.uri).filter(Boolean) as string[]);
        }
      }
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(call.id);
        resolve({ ok: false, code: "client_timeout" });
      }, 30000);
      pending.set(call.id, { resolve, timer });
      send({ type: "tool.call", id: call.id, name: call.name, args: call.args });
    });
  };
}

app.get("/config", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  return { secret: config.wsSecret, version: VERSION };
});

app.get("/health", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  return { ok: true };
});

app.get("/sessions", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  return listSessions();
});

app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  return readSession(req.params.id);
});

// Runs the read-only inventory probe inside the connected Spotify client and
// persists it to agent/data/probes/. Keeps the HTTP response tiny (the payload
// is large and meant to be read from disk, not pasted).
app.get("/probe", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  if (!activeClient) {
    return reply.code(503).send({ error: "no_client_connected" });
  }
  const res = await activeClient.callTool({ id: `probe_${randomUUID()}`, name: "probe", args: {} });
  if (!res.ok) {
    return reply.code(502).send({ error: res.code ?? "probe_failed" });
  }
  let file: string | null = null;
  let bytes = 0;
  try {
    const body = JSON.stringify(res.data, null, 2);
    bytes = Buffer.byteLength(body);
    mkdirSync(PROBE_DIR, { recursive: true });
    file = resolve(PROBE_DIR, `probe-${Date.now()}.json`);
    writeFileSync(file, body);
  } catch (err) {
    app.log.error(err);
    return reply.code(500).send({ error: "probe_write_failed" });
  }
  return { ok: true, file, bytes };
});

app.register(async (fastify) => {
  fastify.get("/ws", { websocket: true }, (connection, _req) => {
    const socket = connection.socket;
    const send = makeSend(socket);
    const pending = new Map<string, PendingTool>();
    const pendingProposals = new Map<string, PendingProposal>();
    let activeSessionId: string | null = null;
    let clientLocale: string | null = null;
    let t: Translator = makeT(AGENT_STRINGS, "en");
    const deps = { locale: (): string | undefined => clientLocale ?? undefined };
    const callClientTool = requestClientTool(socket, send, pending, pendingProposals, db, () => activeSessionId, () => t);
    let authed = false;

    // Per-connection serial queue for chat-affecting messages. Without it, two
    // chat.send (or a clear/songchange) processed while an LLM/tool flow is
    // running would interleave stream deltas and per-connection state.
    // Control messages (tool.result, proposal.decision, ping, hello) stay
    // immediate so pending promises can resolve mid-flow without deadlocking.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void>): void => {
      chain = chain.then(task).catch((err) => app.log.error(err));
    };

    const handleQueuedMessage = async (msg: ClientMessage): Promise<void> => {
      switch (msg.type) {
        case "chat.send": {
          const sessionId = msg.sessionId ?? randomUUID();
          activeSessionId = sessionId;
          await handleChat({ send, requestClientTool: callClientTool, locale: deps.locale() }, db, sessionId, msg.text);
          break;
        }
        case "chat.clear": {
          clearHistory(db, msg.sessionId);
          logSession(msg.sessionId, "chat.clear");
          send({ type: "chat.cleared", sessionId: msg.sessionId });
          break;
        }
        case "event.songchange": {
          logSession("routing", "songchange.event", { uri: msg.uri });
          await handleSongChange({ send, requestClientTool: callClientTool, locale: deps.locale() }, db, msg.uri);
          break;
        }
      }
    };

    socket.on("message", (raw: RawData) => {
      try {
        const parsed = MessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          send({ type: "chat.status", status: "error", detail: t("status.invalidMessage") });
          return;
        }
        const msg = parsed.data;

        if (msg.type === "ping") {
          send({ type: "pong" });
          return;
        }

        if (!authed) {
          if (msg.type === "hello" && msg.secret === config.wsSecret) {
            authed = true;
            clientLocale = msg.locale ?? null;
            t = makeT(AGENT_STRINGS, normalizeLocale(clientLocale));
            app.log.info({ locale: clientLocale }, t("status.clientAuthenticated"));
            send({ type: "hello.ok", version: VERSION });
            activeClient = { callTool: callClientTool };
          } else {
            app.log.warn(t("status.handshakeRejected"));
            socket.close(1008, "unauthorized");
          }
          return;
        }

        switch (msg.type) {
          case "hello":
            send({ type: "hello.ok", version: VERSION });
            break;
          case "client.debug": {
            const level = msg.level ?? "log";
            app.log.info({ client: true, level }, `[client] ${msg.detail}`);
            break;
          }
          case "chat.send":
          case "chat.clear":
          case "event.songchange":
            enqueue(() => handleQueuedMessage(msg));
            break;
          case "tool.result": {
            const p = pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              pending.delete(msg.id);
              p.resolve({ ok: msg.ok, data: msg.data, code: msg.code });
            }
            break;
          }
          case "proposal.decision": {
            const pr = pendingProposals.get(msg.proposalId);
            if (pr) {
              clearTimeout(pr.timer);
              pendingProposals.delete(msg.proposalId);
              pr.resolve(msg.decision);
            }
            break;
          }
          default:
            app.log.info({ type: msg.type }, t("status.messageReceived"));
        }
      } catch (err) {
        app.log.error(err);
      }
    });

    socket.on("close", () => {
      if (activeClient && activeClient.callTool === callClientTool) activeClient = null;
      app.log.info(t("status.clientDisconnected"));
    });
  });
});

await app.listen({ host: config.host, port: config.port });
app.log.info(makeT(AGENT_STRINGS, "en")("status.agentListening", { host: config.host, port: config.port }));
