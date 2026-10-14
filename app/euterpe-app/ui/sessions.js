// Sessões de conversa + persistência.
//
// - A lista de sessões vive no LocalStorage ("euterpe:sessions")
// - As mensagens de cada sessão vivem em "euterpe:messages:<id>"
// - A sessão ativa é usada em cada chat.send / chat.clear
//
// Extraído de euterpe-app/index.js sem mudança de comportamento; o único acréscimo
// é `dropFrom`, usado pelo "regenerar" e pelo "editar e reenviar" do chat.
import { tr } from "../lib/i18n.js";

const { React } = Spicetify;

const SESSIONS_KEY = "euterpe:sessions";
const LEGACY_SESSION_KEY = "euterpe:session";
const MSG_PREFIX = "euterpe:messages:";
const MAX_SESSIONS = 12;
const SESSION_TITLE_MAX = 28;

export function newSessionId() {
  return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function sessionTitle(messages) {
  const first = (messages || []).find((m) => m.role === "user");
  if (!first) return tr("session.new");
  const text = String(first.content || "").replace(/<[^>]+>/g, "").trim();
  return text.length > SESSION_TITLE_MAX ? text.slice(0, SESSION_TITLE_MAX) + "…" : text || tr("session.new");
}

/* Single persistence layer for sessions/messages. */
export const sessionStore = {
  list() {
    try {
      const raw = Spicetify.LocalStorage.get(SESSIONS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((s) => s && typeof s.id === "string");
      }
    } catch (err) {}
    return null;
  },
  save(list) {
    try {
      Spicetify.LocalStorage.set(SESSIONS_KEY, JSON.stringify(list));
    } catch (err) {}
  },
  messages(id) {
    try {
      const raw = Spicetify.LocalStorage.get(MSG_PREFIX + id);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (err) {}
    return [];
  },
  saveMessages(id, messages) {
    try {
      Spicetify.LocalStorage.set(MSG_PREFIX + id, JSON.stringify(messages));
    } catch (err) {}
  },
  removeMessages(id) {
    try {
      Spicetify.LocalStorage.remove(MSG_PREFIX + id);
    } catch (err) {}
  },
  /* Migrates the old single session (euterpe:session) into the list. */
  migrateLegacy() {
    try {
      const legacyId = Spicetify.LocalStorage.get(LEGACY_SESSION_KEY);
      if (!legacyId) return null;
      const messages = sessionStore.messages(legacyId);
      if (!messages.length) return null;
      return [{ id: legacyId, title: sessionTitle(messages) }];
    } catch (err) {}
    return null;
  },
};

/* Sessions hook: state + operations + persistence. */
export function useSessions() {
  const { useState, useEffect } = React;
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);

  // Initialization: restore saved sessions, migrate the legacy one or create a new one.
  useEffect(() => {
    let list = sessionStore.list();
    if (!list || !list.length) list = sessionStore.migrateLegacy();
    if (!list || !list.length) list = [{ id: newSessionId(), title: tr("session.new") }];
    setSessions(list);
    const last = list[list.length - 1];
    setCurrentId(last.id);
    setMessages(sessionStore.messages(last.id));
  }, []);

  // Persists the session list.
  useEffect(() => {
    if (!sessions.length) return;
    sessionStore.save(sessions);
  }, [sessions]);

  // Persists the messages of the current session (debounced).
  useEffect(() => {
    if (!currentId || !messages.length) return;
    const tOut = setTimeout(() => sessionStore.saveMessages(currentId, messages), 400);
    return () => clearTimeout(tOut);
  }, [messages, currentId]);

  // Keeps the current session title synced with the 1st user message.
  useEffect(() => {
    if (!currentId) return;
    const title = sessionTitle(messages);
    setSessions((prev) =>
      prev.some((s) => s.id === currentId && s.title === title)
        ? prev
        : prev.map((s) => (s.id === currentId ? { ...s, title } : s))
    );
  }, [currentId, messages]);

  const openSession = (id) => {
    setCurrentId(id);
    setMessages(sessionStore.messages(id));
  };

  const newSession = () => {
    const id = newSessionId();
    setSessions((prev) => [...prev.slice(-(MAX_SESSIONS - 1)), { id, title: tr("session.new") }]);
    setCurrentId(id);
    setMessages([]);
  };

  const closeSession = (id) => {
    sessionStore.removeMessages(id);
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (id !== currentId) return;
    if (next.length) {
      const last = next[next.length - 1];
      setCurrentId(last.id);
      setMessages(sessionStore.messages(last.id));
    } else {
      const fresh = { id: newSessionId(), title: tr("session.new") };
      setSessions([fresh]);
      setCurrentId(fresh.id);
      setMessages([]);
    }
  };

  const clearMessages = () => {
    setMessages([]);
    if (currentId) sessionStore.removeMessages(currentId);
  };

  const pushUser = (text) => setMessages((prev) => [...prev, { role: "user", content: text, done: true }]);

  const streamDelta = (delta) =>
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && !last.done) {
        return [...prev.slice(0, -1), { role: "assistant", content: last.content + delta, done: false }];
      }
      return [...prev, { role: "assistant", content: delta, done: false }];
    });

  const markLastDone = () =>
    setMessages((prev) =>
      prev.map((m, i) => (i === prev.length - 1 && m.role === "assistant" ? { ...m, done: true } : m))
    );

  /* Trunca a conversa em `index` (exclusive) — base do regenerar/editar. */
  const dropFrom = (index) => setMessages((prev) => prev.slice(0, Math.max(0, index)));

  return {
    sessions,
    currentId,
    messages,
    openSession,
    newSession,
    closeSession,
    clearMessages,
    pushUser,
    streamDelta,
    markLastDone,
    dropFrom,
  };
}
