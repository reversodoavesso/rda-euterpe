import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, "..", "data", "sessions");

export interface SessionEvent {
  ts: string;
  session: string;
  event: string;
  payload?: unknown;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
}

function fileOf(sessionId: string): string {
  return resolve(LOG_DIR, `${sanitize(sessionId)}.log`);
}

function ensureDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

/** Appends a JSONL session event (for debug). */
export function logSession(sessionId: string, event: string, payload?: unknown): void {
  try {
    ensureDir();
    const line: SessionEvent = { ts: new Date().toISOString(), session: sessionId, event };
    if (payload !== undefined) line.payload = payload;
    appendFileSync(fileOf(sessionId), JSON.stringify(line) + "\n");
  } catch (err) {
    console.error("[euterpe] failed to write session log", err);
  }
}

export interface SessionSummary {
  id: string;
  file: string;
  size: number;
  modified: string;
  events: number;
}

function countJsonlLines(file: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function listSessions(): SessionSummary[] {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".log"))
    .map((f) => {
      const file = resolve(LOG_DIR, f);
      const st = statSync(file);
      return {
        id: f.replace(/\.log$/, ""),
        file: f,
        size: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
        events: countJsonlLines(file),
      };
    })
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

export function readSession(sessionId: string): SessionEvent[] {
  const file = fileOf(sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as SessionEvent;
      } catch {
        return { ts: "", session: sessionId, event: "unparseable", payload: l } as SessionEvent;
      }
    });
}

export function logToolCall(sessionId: string, name: string, args: unknown, ok?: boolean, code?: string, ms?: number): void {
  logSession(sessionId, "tool.call", {
    name,
    args: typeof args === "object" ? args : String(args),
    ok,
    code,
    duration_ms: ms,
  });
}
