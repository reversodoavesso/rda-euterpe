// Chat do Euterpe — o app em si (header, sessões, thread, composer) + os extras
// da Fase 6: stop, copiar, regenerar, editar, tool cards, diff de proposta,
// autoscroll com lock, seletor de provider/modelo, pills de sugestão, toasts.
//
// Fontes de eventos do chat (as duas valem — PLAN-REFACTOR, regra 2):
//  - SSE de `POST /chat` (caminho normal da UI): `status` · `stream` · `tool` ·
//    `proposal` · `cleared` · `done` · `error`;
//  - WS do daemon via `window.euterpe` (a extensão não mudou): `chat.status`
//    `status:"tool"` · `chat.stream` · `chat.done` · `chat.cleared` ·
//    `proposal.create` · `hello.ok`.
// Ambos alimentam os mesmos handlers, então a UI se comporta igual nos dois modos
// (loop nativo no Rust ou `CHAT_UPSTREAM` para o agente Node).
import { appLocale, tr } from "../lib/i18n.js";
import { getSettings, listModels, listProviders, saveSettings, streamChat } from "../lib/daemon.js";
import { copyText, euterpeLogo, nativeIcon, renderMarkdown } from "./markdown.js";
import { useSessions } from "./sessions.js";
import { SettingsPanel } from "./settings.js";

const { React } = Spicetify;

/* ============================================================
   CSS do app (tokens + classes utilitárias). Substitui em vez de
   retornar cedo: o <style> persiste entre navegações do custom app e o
   arquivo pode ser relido após um update sem reiniciar o client.
   ============================================================ */
export function injectStyles() {
  try {
    const existing = document.getElementById("euterpe-styles");
    if (existing) existing.remove();
    const s = document.createElement("style");
    s.id = "euterpe-styles";
    s.textContent = `:root {
  /* Euterpe design tokens — mapped to Spotify/spicetify theme variables.
     Solid colors follow the active theme (--spice-*) and fall back to
     Spotify's native design-system vars, then to defaults.
     Translucent tones use --spice-rgb-* triplets so they work on any Chromium. */
  --euterpe-bg: var(--spice-main, var(--background-base, #121212));
  --euterpe-surface: var(--spice-card, var(--background-elevated-base, #181818));
  --euterpe-surface-raised: var(--spice-main-elevated, var(--background-elevated-highlight, #242424));
  --euterpe-text: var(--spice-text, var(--text-base, #ffffff));
  --euterpe-subtext: var(--spice-subtext, var(--text-subdued, #b3b3b3));
  --euterpe-accent: var(--spice-button, var(--essential-bright-accent, #1db954));
  --euterpe-accent-active: var(--spice-button-active, var(--essential-bright-accent, #1db954));
  --euterpe-on-accent: #000000;
  --euterpe-divider: var(--spice-selected-row, rgba(255,255,255,.12));
  --euterpe-border: rgba(var(--spice-rgb-text, 255,255,255), .25);
  --euterpe-overlay: rgba(0,0,0,.35);
  --euterpe-text-muted: rgba(var(--spice-rgb-text, 255,255,255), .5);
  --euterpe-text-dim: rgba(var(--spice-rgb-text, 255,255,255), .78);
  --euterpe-status: rgba(var(--spice-rgb-text, 255,255,255), .55);
  --euterpe-surface-soft: rgba(var(--spice-rgb-text, 255,255,255), .08);
  --euterpe-btn-bg: rgba(var(--spice-rgb-text, 255,255,255), .12);
  --euterpe-code-bg: rgba(var(--spice-rgb-text, 255,255,255), .14);
  --euterpe-message-bot-bg: rgba(var(--spice-rgb-text, 255,255,255), .08);
  --euterpe-message-user-bg: rgba(var(--spice-rgb-button, 29,185,84), .25);
  --euterpe-chip-bg: rgba(var(--spice-rgb-button, 29,185,84), .16);
  --euterpe-chip-border: rgba(var(--spice-rgb-button, 29,185,84), .35);
  --euterpe-accent-soft: rgba(var(--spice-rgb-button, 29,185,84), .2);
  --euterpe-accent-soft-2: rgba(var(--spice-rgb-button, 29,185,84), .15);
  --euterpe-accent-border-strong: rgba(var(--spice-rgb-button, 29,185,84), .4);
  --euterpe-danger: #f15e6c;
  --euterpe-danger-soft: rgba(241,94,108,.2);
}
@keyframes euterpeBlink { 50% { opacity: 0; } }
@keyframes euterpePulse {
  0% { box-shadow: 0 0 0 0 rgba(var(--spice-rgb-button, 29,185,84), .5); }
  70% { box-shadow: 0 0 0 6px rgba(var(--spice-rgb-button, 29,185,84), 0); }
  100% { box-shadow: 0 0 0 0 rgba(var(--spice-rgb-button, 29,185,84), 0); }
}
/* App buttons — utility classes scoped to the app root to beat the Encore
   resets (specificity 0,2,0) with a full style reset. */
.euterpe-app .euterpe-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0;
  padding: 7px 14px;
  border-radius: 500px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--euterpe-text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.euterpe-app .euterpe-btn:disabled { opacity: .5; cursor: not-allowed; }
.euterpe-app .euterpe-btn-ghost { border-color: var(--euterpe-divider); }
.euterpe-app .euterpe-btn-ghost:hover:not(:disabled) { background: var(--euterpe-surface-soft); border-color: var(--euterpe-border); }
/* Quick replies — suggestion bubbles inside the conversation thread. */
.euterpe-app .euterpe-quickreply {
  appearance: none;
  display: block;
  margin: 0;
  padding: 8px 12px;
  max-width: 100%;
  border-radius: 14px;
  border-top-left-radius: 4px;
  border: 1px solid var(--euterpe-accent-border-strong);
  background: var(--euterpe-surface);
  color: var(--euterpe-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  word-break: break-word;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.euterpe-app .euterpe-quickreply:hover { background: var(--euterpe-accent-soft); }
.euterpe-app .euterpe-quickreply:active { background: var(--euterpe-accent-soft-2); }
.euterpe-app .euterpe-quickreply:focus-visible {
  outline: 2px solid var(--euterpe-accent);
  outline-offset: 2px;
}
/* Ações por mensagem: discretas até o hover. */
.euterpe-app .euterpe-msg-action {
  appearance: none;
  margin: 0;
  padding: 2px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--euterpe-text-muted);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.euterpe-app .euterpe-msg-action:hover { background: var(--euterpe-btn-bg); color: var(--euterpe-text); }
@media (prefers-reduced-motion: reduce) {
  .euterpe-app * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}`;
    document.head.appendChild(s);
  } catch (err) {}
}

/* ---------- helpers locais ---------- */

function ToolCard({ card }) {
  const running = card.endedAt == null;
  const ms = (card.endedAt || Date.now()) - card.startedAt;
  const status = running ? tr("tool.running") : tr("tool.ok");
  const dot = running ? "var(--euterpe-accent)" : "var(--euterpe-text-muted)";
  return React.createElement(
    "details",
    {
      style: {
        alignSelf: "flex-start",
        maxWidth: "80%",
        background: "var(--euterpe-surface-soft)",
        border: "1px solid var(--euterpe-divider)",
        borderRadius: 10,
        padding: "6px 10px",
        fontSize: 12,
        color: "var(--euterpe-text-dim)",
      },
    },
    React.createElement(
      "summary",
      { style: { cursor: "pointer", display: "flex", gap: 8, alignItems: "center", listStyle: "none" } },
      React.createElement("span", {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          flexShrink: 0,
          background: dot,
          animation: running ? "euterpePulse 1.6s ease-out infinite" : "none",
        },
      }),
      React.createElement("span", { style: { fontWeight: 600, color: "var(--euterpe-text)" } }, card.name || tr("status.thinking")),
      React.createElement("span", { style: { color: "var(--euterpe-status)" } }, `· ${status} · ${tr("tool.duration", { ms })}`)
    ),
    card.args
      ? React.createElement(
          "div",
          { style: { marginTop: 6 } },
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "var(--euterpe-text-muted)", marginBottom: 2 } }, tr("tool.args")),
          React.createElement(
            "pre",
            { style: { margin: 0, overflowX: "auto", fontFamily: "ui-monospace, monospace", fontSize: 11, whiteSpace: "pre-wrap" } },
            JSON.stringify(card.args, null, 2)
          )
        )
      : null
  );
}

/* Diff do que a mutação muda, quando a tool carrega `uris`/`tracks`. */
export function proposalDiff(name, args) {
  const raw = (args && (args.uris || args.tracks)) || null;
  if (!raw) return null;
  const items = (Array.isArray(raw) ? raw : [raw])
    .map((item) => (typeof item === "string" ? item : (item && (item.uri || item.name)) || null))
    .filter((v) => typeof v === "string" && v.length);
  if (!items.length) return null;
  const tool = String(name || "");
  const mode = /replace/.test(tool) ? "replace" : /remove/.test(tool) ? "removed" : "added";
  return { mode, items };
}

function ProposalPanel({ proposal, onDecide }) {
  const diff = proposalDiff(proposal.name, proposal.args);
  const summary = !diff
    ? null
    : diff.mode === "replace"
      ? tr("proposal.replace", { n: diff.items.length })
      : diff.mode === "removed"
        ? tr("proposal.removed", { n: diff.items.length })
        : tr("proposal.added", { n: diff.items.length });
  const tone = diff && diff.mode === "removed" ? "var(--euterpe-danger)" : "var(--euterpe-accent)";
  return React.createElement(
    "div",
    {
      style: {
        background: "var(--euterpe-accent-soft-2)",
        border: "1px solid var(--euterpe-accent-border-strong)",
        borderRadius: 12,
        padding: "10px 14px",
        marginBottom: 8,
      },
    },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
      React.createElement("div", { style: { fontSize: 13, fontWeight: 600, minWidth: 0 } }, proposal.title || proposal.name),
      React.createElement(
        "div",
        { style: { display: "flex", gap: 8, flexShrink: 0 } },
        React.createElement(
          "button",
          {
            onClick: () => onDecide(proposal, "approve"),
            style: {
              background: "var(--euterpe-accent)",
              color: "var(--euterpe-on-accent)",
              border: "none",
              borderRadius: 500,
              padding: "8px 16px",
              fontWeight: 700,
              cursor: "pointer",
            },
          },
          tr("action.confirm")
        ),
        React.createElement(
          "button",
          {
            onClick: () => onDecide(proposal, "reject"),
            style: {
              background: "transparent",
              border: "1px solid var(--euterpe-border)",
              borderRadius: 500,
              padding: "8px 16px",
              cursor: "pointer",
              color: "var(--euterpe-text)",
            },
          },
          tr("action.cancel")
        )
      )
    ),
    summary
      ? React.createElement(
          "div",
          { style: { marginTop: 6, fontSize: 12, color: tone } },
          `${tr("proposal.change")}: ${summary}`,
          React.createElement(
            "details",
            { style: { marginTop: 4 } },
            React.createElement("summary", { style: { cursor: "pointer", color: "var(--euterpe-subtext)", fontSize: 11 } }, `+${diff.items.length}`),
            React.createElement(
              "pre",
              { style: { margin: "4px 0 0", fontFamily: "ui-monospace, monospace", fontSize: 11, whiteSpace: "pre-wrap", color: "var(--euterpe-text-dim)" } },
              diff.items.slice(0, 8).join("\n")
            )
          )
        )
      : null
  );
}

export function EuterpeApp() {
  const { useState, useEffect, useRef } = React;
  const {
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
  } = useSessions();

  const [bus, setBus] = useState(window.euterpe || null);
  const [status, setStatus] = useState("");
  const [tools, setTools] = useState([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [proposals, setProposals] = useState([]);
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [agentVersion, setAgentVersion] = useState(null);
  const [focused, setFocused] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [editing, setEditing] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [atBottom, setAtBottom] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProvider, setActiveProvider] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [modelList, setModelList] = useState([]);

  const listRef = useRef(null);
  const abortRef = useRef(null);
  const atBottomRef = useRef(true);
  const toolSeq = useRef(0);

  const toast = (text, level) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, text, level: level || "info" }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  };

  // If the extension mounts after the app, poll for window.euterpe instead of
  // getting stuck on "extension not loaded".
  useEffect(() => {
    if (bus) return;
    const id = setInterval(() => {
      if (window.euterpe) {
        clearInterval(id);
        setBus(window.euterpe);
      }
    }, 500);
    return () => clearInterval(id);
  }, [bus]);

  /* ---------- tool cards / proposta / estado ---------- */

  const startTool = (name, args) => setTools((prev) => [...prev, { key: ++toolSeq.current, name, args: args || null, startedAt: Date.now(), endedAt: null }]);

  const finishTools = () =>
    setTools((prev) => prev.map((t) => (t.endedAt == null ? { ...t, endedAt: Date.now() } : t)));

  const addProposal = (p) => {
    if (!p || !p.proposalId) return;
    setProposals((prev) => (prev.some((x) => x.proposalId === p.proposalId) ? prev : [...prev, p]));
  };

  /* Handler único para SSE e WS: mesmos efeitos, seja qual for a origem. */
  const applyEvent = (kind, payload) => {
    const data = payload || {};
    switch (kind) {
      case "stream":
        if (data.delta) streamDelta(data.delta);
        finishTools();
        break;
      case "tool":
        startTool(data.name, data.args);
        break;
      case "status":
        if (data.status === "tool") {
          finishTools();
          startTool(data.detail || tr("status.thinking"), null);
        } else if (data.status === "offline") {
          setConnected(false);
          setConnecting(false);
          finishTools();
          setStatus(data.detail || tr("status.disconnected"));
        } else if (data.status === "error") {
          finishTools();
          setStatus("");
          if (data.detail) toast(data.detail, "error");
        } else {
          finishTools();
          setStatus(data.detail || data.status || "");
        }
        break;
      case "proposal":
        addProposal(data);
        break;
      case "cleared":
        clearMessages();
        setTools([]);
        setProposals([]);
        setStatus(tr("status.cleared"));
        setSuggestions([]);
        break;
      case "done":
        markLastDone();
        finishTools();
        setStatus("");
        // Only touch suggestions when the agent sent the field — routing
        // (songchange) also emits chat.done without suggestions and must not
        // reset the contextual pills of the conversation.
        if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions.slice(0, 3));
        break;
      case "error":
        finishTools();
        setStatus("");
        toast(data.detail || data.code || tr("error.title"), "error");
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (!bus) return;
    const off = bus.onMessage((msg) => {
      switch (msg.type) {
        case "chat.stream":
          applyEvent("stream", msg);
          break;
        case "chat.done":
          applyEvent("done", msg);
          break;
        case "chat.cleared":
          applyEvent("cleared", msg);
          break;
        case "chat.status":
          applyEvent("status", msg);
          break;
        case "proposal.create":
          addProposal(msg);
          break;
        case "hello.ok":
          setConnected(true);
          setConnecting(false);
          setStatus("");
          setAgentVersion(msg.version || (bus && bus.agentVersion) || null);
          break;
        default:
          break;
      }
    });
    if (bus.connected) {
      setConnected(true);
      setConnecting(false);
    }
    if (bus.agentVersion) setAgentVersion(bus.agentVersion);
    return () => off();
  }, [bus]);

  /* ---------- provider/modelo ---------- */

  const refreshProviders = () => {
    Promise.all([listProviders(), getSettings()])
      .then(([listing, settings]) => {
        setProviders((listing && listing.providers) || []);
        const act = (settings && settings.settings) || {};
        setActiveProvider(act.activeProvider || "");
        setActiveModel(act.activeModel || "");
      })
      .catch((err) => toast(err.message, "error"));
  };

  useEffect(() => {
    refreshProviders();
  }, []);

  const providerOptions = providers;
  const currentProvider = providerOptions.find((p) => p.id === activeProvider) || null;
  const knownModels = modelList.length ? modelList : (currentProvider && currentProvider.models) || [];
  const modelOptions = activeModel && knownModels.indexOf(activeModel) < 0 ? [activeModel, ...knownModels] : knownModels;

  const mapModelIds = (res) =>
    (((res && res.models) || []).map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean));

  const changeProvider = (id) => {
    setActiveProvider(id);
    setModelList([]);
    saveSettings({ activeProvider: id })
      .then((res) => {
        setActiveModel((res && res.settings && res.settings.activeModel) || "");
        const p = providers.find((x) => x.id === id);
        setModelList((p && p.models) || []);
      })
      .catch((err) => toast(err.message, "error"));
    // Sem chave/provider fora do ar o daemon devolve 502: cai no catálogo local
    // do /providers sem incomodar o usuário com toast.
    listModels({ provider: id })
      .then((res) => setModelList(mapModelIds(res)))
      .catch(() => {});
  };

  const changeModel = (model) => {
    setActiveModel(model);
    saveSettings({ activeModel: model }).catch((err) => toast(err.message, "error"));
  };

  /* ---------- envio ---------- */

  const run = (text, { push }) => {
    if (!text || !currentId) return;
    if (push) pushUser(text);
    setInput("");
    setSuggestions([]);
    setTools([]);
    setStatus(tr("status.sending"));
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    streamChat({
      text,
      sessionId: currentId,
      locale: appLocale(),
      signal: controller.signal,
      onEvent: applyEvent,
    })
      .catch((err) => {
        const aborted = err && (err.name === "AbortError" || controller.signal.aborted);
        if (aborted) setStatus(tr("status.stopped"));
        else {
          setStatus("");
          toast(err && err.message ? err.message : String(err), "error");
        }
      })
      .finally(() => {
        markLastDone();
        finishTools();
        if (abortRef.current === controller) abortRef.current = null;
        setStreaming(false);
      });
  };

  const send = (textOverride) => {
    if (streaming) return;
    const text = (textOverride !== undefined ? textOverride : input).trim();
    if (!text) return;
    if (editing) {
      dropFrom(editing.index);
      setEditing(null);
    }
    run(text, { push: true });
  };

  const stop = () => {
    if (abortRef.current) abortRef.current.abort();
  };

  const clear = () => {
    if (!currentId) return;
    clearMessages();
    setSuggestions([]);
    setTools([]);
    setProposals([]);
    if (bus) bus.send({ type: "chat.clear", sessionId: currentId });
  };

  const regenerate = () => {
    if (streaming) return;
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        index = i;
        break;
      }
    }
    if (index < 0) return;
    const text = messages[index].content;
    dropFrom(index + 1);
    run(text, { push: false });
  };

  const startEdit = (index) => {
    const msg = messages[index];
    if (!msg || msg.role !== "user") return;
    setEditing({ index, text: msg.content });
    setInput(msg.content);
  };

  const copyMessage = (msg) => {
    const ok = copyText(msg.content);
    toast(ok ? tr("action.copied") : tr("error.title"), ok ? "info" : "error");
  };

  const decide = (proposal, decision) => {
    setProposals((prev) => prev.filter((p) => p.proposalId !== proposal.proposalId));
    if (bus) bus.send({ type: "proposal.decision", proposalId: proposal.proposalId, decision });
  };

  /* ---------- autoscroll com lock ---------- */

  useEffect(() => {
    const el = listRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status, tools, suggestions, proposals]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = near;
    setAtBottom(near);
  };

  const goToEnd = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };

  if (!bus) {
    return React.createElement(
      "section",
      { className: "contentSpacing" },
      React.createElement("h1", null, "Euterpe"),
      React.createElement("p", null, tr("error.extensionNotLoaded"))
    );
  }

  /* ---------- estilos ---------- */

  const headerOuterStyle = {
    padding: "18px 0 14px",
    marginBottom: "2px",
    background: "var(--euterpe-bg)",
    borderBottom: "1px solid var(--euterpe-divider)",
  };
  const headerRowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  };
  const brandStyle = {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    minWidth: 0,
  };
  const logoStyle = {
    width: 36,
    height: 36,
    borderRadius: 10,
    flexShrink: 0,
    background: "var(--euterpe-accent)",
    color: "var(--euterpe-on-accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 10px rgba(0,0,0,.3)",
  };
  const titleStackStyle = {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  };
  const titleStyle = {
    margin: 0,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: "-.3px",
    lineHeight: 1.15,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  const dotStyle = {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    background: connected ? "var(--euterpe-accent)" : "var(--euterpe-danger)",
    animation: connecting ? "euterpePulse 1.6s ease-out infinite" : "none",
  };
  const subtitleText = connected
    ? agentVersion
      ? tr("header.connectedVersion", { version: agentVersion })
      : tr("header.connected")
    : connecting
      ? tr("status.connecting")
      : tr("status.disconnected");
  const headerActionsStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
  };
  const selectorStyle = {
    background: "var(--euterpe-surface-soft)",
    border: "1px solid var(--euterpe-divider)",
    borderRadius: 500,
    padding: "4px 10px",
    color: "var(--euterpe-text)",
    fontFamily: "inherit",
    fontSize: 11,
    maxWidth: 150,
  };
  const emptyStateStyle = {
    margin: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "10px",
    textAlign: "center",
    maxWidth: 340,
    padding: "32px 12px",
  };
  const emptyLogoStyle = {
    width: 56,
    height: 56,
    borderRadius: 16,
    flexShrink: 0,
    background: "var(--euterpe-accent-soft)",
    color: "var(--euterpe-accent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  };
  const tabsBarStyle = {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    overflowX: "auto",
    padding: "12px 0 10px",
    borderBottom: "1px solid var(--euterpe-divider)",
    scrollbarWidth: "thin",
  };
  const tabStyle = (active) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
    background: active ? "var(--euterpe-accent-soft)" : "var(--euterpe-surface)",
    border: active ? "1px solid var(--euterpe-accent-border-strong)" : "1px solid var(--euterpe-divider)",
    borderRadius: "500px",
    padding: "6px 12px",
    fontSize: "12px",
    color: active ? "var(--euterpe-text)" : "var(--euterpe-subtext)",
    cursor: "pointer",
    maxWidth: "220px",
    whiteSpace: "nowrap",
  });
  const tabCloseStyle = {
    background: "none",
    border: "none",
    color: "var(--euterpe-text-muted)",
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: "1",
    padding: 0,
    display: "inline-flex",
  };
  const tabNewStyle = {
    flexShrink: 0,
    background: "transparent",
    border: "1px dashed var(--euterpe-border)",
    borderRadius: "500px",
    padding: "6px 12px",
    fontSize: "14px",
    color: "var(--euterpe-subtext)",
    cursor: "pointer",
    lineHeight: "1",
  };

  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();

  return React.createElement(
    "section",
    { className: "contentSpacing euterpe-app", style: { display: "flex", flexDirection: "column", height: "100%" } },
    React.createElement(
      "div",
      { style: headerOuterStyle },
      React.createElement(
        "div",
        { style: headerRowStyle },
        React.createElement(
          "div",
          { style: brandStyle },
          React.createElement("div", { style: logoStyle, "aria-hidden": true }, euterpeLogo(18)),
          React.createElement(
            "div",
            { style: titleStackStyle },
            React.createElement("h1", { style: titleStyle }, "Euterpe"),
            React.createElement(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2, minWidth: 0 } },
              React.createElement("span", { style: dotStyle, title: connected ? tr("status.connected") : tr("status.disconnected") }),
              React.createElement(
                "span",
                {
                  style: {
                    fontSize: 12,
                    color: "var(--euterpe-subtext)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                },
                subtitleText
              )
            )
          )
        ),
        React.createElement(
          "div",
          { style: headerActionsStyle },
          React.createElement(
            "select",
            {
              style: selectorStyle,
              value: activeProvider,
              title: tr("settings.tabSetup"),
              onChange: (e) => changeProvider(e.target.value),
            },
            !activeProvider ? React.createElement("option", { value: "" }, tr("settings.loading")) : null,
            providerOptions.map((p) => React.createElement("option", { key: p.id, value: p.id }, p.name || p.id))
          ),
          modelOptions.length
            ? React.createElement(
                "select",
                { style: selectorStyle, value: activeModel, title: tr("settings.model"), onChange: (e) => changeModel(e.target.value) },
                !activeModel ? React.createElement("option", { value: "" }, tr("settings.loading")) : null,
                modelOptions.map((m) => React.createElement("option", { key: m, value: m }, m))
              )
            : null,
          React.createElement(
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              onClick: () => setShowSettings(true),
              title: tr("action.settings"),
              "aria-label": tr("action.settings"),
            },
            nativeIcon("settings", 13),
            tr("action.settings")
          ),
          React.createElement(
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              onClick: clear,
              title: tr("action.clearTitle"),
              "aria-label": tr("action.clear"),
            },
            nativeIcon("ban", 13),
            tr("action.clear")
          )
        )
      )
    ),
    React.createElement(
      "div",
      { style: tabsBarStyle },
      sessions.map((s) =>
        React.createElement(
          "div",
          {
            key: s.id,
            onClick: () => {
              setSuggestions([]);
              setTools([]);
              openSession(s.id);
            },
            style: tabStyle(s.id === currentId),
            title: s.title,
          },
          React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, s.title),
          React.createElement(
            "button",
            {
              onClick: (e) => {
                e.stopPropagation();
                // Closing the active session switches the thread — the quick
                // replies of the previous session must not leak into the next.
                if (s.id === currentId) setSuggestions([]);
                closeSession(s.id);
              },
              style: tabCloseStyle,
              title: tr("action.closeSession"),
              "aria-label": tr("action.closeSession"),
            },
            "×"
          )
        )
      ),
      React.createElement(
        "button",
        {
          onClick: () => {
            setSuggestions([]);
            setTools([]);
            newSession();
          },
          style: tabNewStyle,
          title: tr("action.newSession"),
          "aria-label": tr("action.newSession"),
        },
        "+"
      )
    ),
    React.createElement(
      "div",
      {
        ref: listRef,
        onScroll,
        style: {
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "12px 0",
          scrollbarWidth: "thin",
          position: "relative",
        },
      },
      !messages.length && !tools.length && !status
        ? React.createElement(
            "div",
            { style: emptyStateStyle },
            React.createElement("div", { style: emptyLogoStyle, "aria-hidden": true }, euterpeLogo(26)),
            React.createElement("div", { style: { fontSize: 16, fontWeight: 700, color: "var(--euterpe-text)" } }, tr("empty.title")),
            React.createElement(
              "div",
              { style: { fontSize: 13, lineHeight: 1.5, color: "var(--euterpe-subtext)" } },
              tr("empty.subtitle")
            )
          )
        : null,
      messages.map((m, i) =>
        React.createElement(
          "div",
          {
            key: i,
            style: {
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              background: m.role === "user" ? "var(--euterpe-message-user-bg)" : "var(--euterpe-message-bot-bg)",
              borderRadius: "12px",
              padding: "8px 12px",
              maxWidth: "80%",
              wordBreak: "break-word",
            },
          },
          ...(m.role === "user"
            ? [m.content]
            : [
                ...renderMarkdown(m.content, `md-${i}`),
                ...(!m.done
                  ? [
                      React.createElement(
                        "span",
                        {
                          key: `md-${i}-caret`,
                          style: {
                            display: "inline-block",
                            width: 7,
                            height: 14,
                            marginLeft: 2,
                            verticalAlign: "text-bottom",
                            background: "var(--euterpe-accent)",
                            animation: "euterpeBlink 1s steps(2,start) infinite",
                          },
                        }
                      ),
                    ]
                  : []),
              ]),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 2, marginTop: 2, justifyContent: m.role === "user" ? "flex-end" : "flex-start" } },
            m.content
              ? React.createElement(
                  "button",
                  { className: "euterpe-msg-action", onClick: () => copyMessage(m), title: tr("action.copy") },
                  tr("action.copy")
                )
              : null,
            m.role === "user"
              ? React.createElement(
                  "button",
                  { className: "euterpe-msg-action", onClick: () => startEdit(i), title: tr("action.edit"), disabled: streaming },
                  tr("action.edit")
                )
              : null,
            m.role === "assistant" && i === lastAssistant && m.done
              ? React.createElement(
                  "button",
                  { className: "euterpe-msg-action", onClick: regenerate, title: tr("action.regenerate"), disabled: streaming },
                  tr("action.regenerate")
                )
              : null
          )
        )
      ),
      tools.map((card) => React.createElement(ToolCard, { key: card.key, card })),
      suggestions.length && connected && !streaming
        ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: "6px",
                marginTop: "2px",
                maxWidth: "80%",
              },
            },
            suggestions.map((text, i) =>
              React.createElement("button", { key: i, className: "euterpe-quickreply", onClick: () => send(text) }, text)
            )
          )
        : null,
      status && !streaming
        ? React.createElement("div", { style: { color: "var(--euterpe-status)", fontSize: "12px" } }, status)
        : null,
      !atBottom
        ? React.createElement(
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              onClick: goToEnd,
              style: { position: "sticky", bottom: 4, alignSelf: "center", background: "var(--euterpe-surface-raised)" },
            },
            tr("action.goToEnd")
          )
        : null
    ),
    proposals.map((p) => React.createElement(ProposalPanel, { key: p.proposalId, proposal: p, onDecide: decide })),
    editing
      ? React.createElement(
          "div",
          { style: { fontSize: 11, color: "var(--euterpe-subtext)", display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } },
          tr("edit.hint"),
          React.createElement(
            "button",
            {
              className: "euterpe-msg-action",
              onClick: () => {
                setEditing(null);
                setInput("");
              },
            },
            tr("edit.cancel")
          )
        )
      : null,
    React.createElement(
      "div",
      { style: { display: "flex", gap: "8px", paddingBottom: "16px", alignItems: "flex-end" } },
      React.createElement("textarea", {
        rows: 1,
        style: {
          flex: 1,
          resize: "vertical",
          background: "var(--euterpe-surface-soft)",
          border: focused ? "1px solid var(--euterpe-accent-border-strong)" : "1px solid transparent",
          borderRadius: 18,
          padding: "10px 14px",
          color: "var(--euterpe-text)",
          fontFamily: "inherit",
          fontSize: 13,
          outline: "none",
          transition: "border-color .15s ease",
          opacity: connected ? 1 : 0.5,
        },
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        placeholder: tr("input.placeholder"),
        value: input,
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            stop();
          }
        },
        disabled: !connected,
      }),
      React.createElement(
        "button",
        {
          style: {
            background: streaming ? "var(--euterpe-danger)" : "var(--euterpe-accent)",
            color: streaming ? "var(--euterpe-text)" : "var(--euterpe-on-accent)",
            border: "none",
            borderRadius: 500,
            padding: "10px 18px",
            fontWeight: 700,
            cursor: connected ? "pointer" : "not-allowed",
            opacity: connected ? 1 : 0.5,
          },
          onClick: streaming ? stop : () => send(),
          disabled: !connected,
        },
        streaming ? tr("action.stop") : tr("action.send")
      )
    ),
    showSettings
      ? React.createElement(SettingsPanel, { onClose: () => setShowSettings(false), onToast: toast })
      : null,
    toasts.length
      ? React.createElement(
          "div",
          { style: { position: "fixed", right: 16, bottom: 16, zIndex: 10000, display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 } },
          toasts.map((t) =>
            React.createElement(
              "div",
              {
                key: t.id,
                style: {
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontSize: 12,
                  background: t.level === "error" ? "var(--euterpe-danger-soft)" : "var(--euterpe-surface-raised)",
                  border: `1px solid ${t.level === "error" ? "var(--euterpe-danger)" : "var(--euterpe-divider)"}`,
                  color: "var(--euterpe-text)",
                  boxShadow: "0 8px 20px rgba(0,0,0,.4)",
                  wordBreak: "break-word",
                },
              },
              t.text
            )
          )
        )
      : null
  );
}
