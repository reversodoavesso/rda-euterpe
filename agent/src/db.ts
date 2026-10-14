import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Schema canônico (contrato C10). Extraído para constante para ser exportado
    como golden (`agent/tools/export-goldens.mjs` → `core/tests/fixtures/schema.sql`)
    e manter o paridade_store.rs ancorado no mesmo texto. Não mudar sem bump. */
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

export function openDb(): Database.Database {
  const dbPath = resolve(__dirname, "..", config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

  const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN session_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, id)");

  return db;
}

export interface HistoryMessage {
  role: string;
  content: string;
}

export function saveMessage(db: Database.Database, sessionId: string, role: string, content: string): void {
  try {
    db.prepare("INSERT INTO conversations (session_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
      sessionId,
      role,
      content,
      Date.now()
    );
  } catch (err) {
    console.error("[euterpe] failed to save conversation", err);
  }
}

export function getHistory(db: Database.Database, sessionId: string, limit = 20): HistoryMessage[] {
  try {
    return db
      .prepare(
        "SELECT role, content FROM conversations WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?"
      )
      .all(sessionId, limit)
      .reverse() as HistoryMessage[];
  } catch (err) {
    console.error("[euterpe] failed to read history", err);
    return [];
  }
}

export function clearHistory(db: Database.Database, sessionId: string): void {
  try {
    db.prepare("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
  } catch (err) {
    console.error("[euterpe] failed to clear history", err);
  }
}

export function getCache(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?").get(key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null;
    return row.value;
  } catch {
    return null;
  }
}

export function setCache(db: Database.Database, key: string, value: string, ttlMs = 0): void {
  try {
    const expires = ttlMs > 0 ? Date.now() + ttlMs : null;
    db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)").run(key, value, expires);
  } catch (err) {
    console.error("[euterpe] failed to write cache", err);
  }
}

export function saveSnapshot(db: Database.Database, playlistId: string, uris: string[]): void {
  try {
    db.prepare(
      "INSERT INTO snapshots (playlist_id, snapshot, created_at) VALUES (?, ?, ?)"
    ).run(playlistId, JSON.stringify(uris), Date.now());
  } catch (err) {
    console.error("[euterpe] failed to save snapshot", err);
  }
}

export function getLatestSnapshot(db: Database.Database, playlistId: string): string[] | null {
  try {
    const row = db
      .prepare("SELECT snapshot FROM snapshots WHERE playlist_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(playlistId) as { snapshot: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.snapshot) as string[];
  } catch (err) {
    console.error("[euterpe] failed to read snapshot", err);
    return null;
  }
}

export function markSnapshotUndone(db: Database.Database, playlistId: string): void {
  try {
    db.prepare(
      "UPDATE snapshots SET undone_at = ? WHERE playlist_id = ? AND undone_at IS NULL"
    ).run(Date.now(), playlistId);
  } catch (err) {
    console.error("[euterpe] failed to mark snapshot undone", err);
  }
}
