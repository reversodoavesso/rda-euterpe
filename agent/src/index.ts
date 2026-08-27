import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { RawData, WebSocket as WsWebSocket } from "ws";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { MessageSchema, VERSION, type ServerMessage, type ToolCallRequest } from "./protocol.js";
import { handleChat, handleSongChange } from "./agent.js";
import { clearHistory, saveSnapshot } from "./db.js";
import { MUTATING_TOOLS } from "./tools/defs.js";
import { logSession, listSessions, readSession } from "./logging.js";
import { AGENT_STRINGS, makeT, normalizeLocale, type Translator } from "./i18n.js";

const app = Fastify({ logger: { level: "info" } });
await app.register(websocket);

const db = openDb();

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

function summarize(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "create_playlist":
      return `Criar playlist "${args.name}" com ${Array.isArray(args.tracks) ? args.tracks.length : 0} faixas`;
    case "add_tracks":
      return `Adicionar ${Array.isArray(args.uris) ? args.uris.length : 0} faixas à playlist`;
    case "remove_tracks":
      return `Remover ${Array.isArray(args.uris) ? args.uris.length : 0} faixas da playlist`;
    case "set_playlist_details":
      return "Atualizar nome/descrição da playlist";
    case "replace_playlist_tracks":
      return `Substituir todas as faixas da playlist (${Array.isArray(args.uris) ? args.uris.length : 0} faixas)`;
    case "set_playlist_cover":
      return "Alterar a capa da playlist";
    default:
      return `Executar ${name}`;
  }
}

function requestClientTool(
  socket: WsWebSocket,
  send: WsSend,
  pending: Map<string, PendingTool>,
  pendingProposals: Map<string, PendingProposal>,
  db: Database.Database,
  getSessionId: () => string | null
) {
  return async (call: ToolCallRequest): Promise<{ ok: boolean; data?: unknown; code?: string }> => {
    const sid = getSessionId() ?? "unknown";
    if (MUTATING_TOOLS.has(call.name)) {
      const proposalId = randomUUID();
      const summary = summarize(call.name, call.args);
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

app.register(async (fastify) => {
  fastify.get("/ws", { websocket: true }, (connection, _req) => {
    const socket = connection.socket;
    const send = makeSend(socket);
    const pending = new Map<string, PendingTool>();
    const pendingProposals = new Map<string, PendingProposal>();
    let activeSessionId: string | null = null;
    let clientLocale: string | null = null;
    const deps = { locale: (): string | undefined => clientLocale ?? undefined };
    const callClientTool = requestClientTool(socket, send, pending, pendingProposals, db, () => activeSessionId);
    let authed = false;

    socket.on("message", async (raw: RawData) => {
      try {
        const parsed = MessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          send({ type: "chat.status", status: "error", detail: "mensagem inválida" });
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
            app.log.info({ locale: clientLocale }, "cliente autenticado");
            send({ type: "hello.ok", version: VERSION });
          } else {
            app.log.warn("handshake rejeitado");
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
            void handleSongChange({ send, requestClientTool: callClientTool, locale: deps.locale() }, db, msg.uri);
            break;
          }
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
            app.log.info({ type: msg.type }, "mensagem recebida");
        }
      } catch (err) {
        app.log.error(err);
      }
    });

    socket.on("close", () => app.log.info("cliente desconectado"));
  });
});

await app.listen({ host: config.host, port: config.port });
app.log.info(`Euterpe agente ouvindo em ws://${config.host}:${config.port}`);
