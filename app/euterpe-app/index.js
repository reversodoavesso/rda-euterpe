// Euterpe - Custom App (chat panel)
const { React } = Spicetify;

/* ============================================================
   Sessões de conversa
   - A lista de sessões vive em LocalStorage ("euterpe:sessions")
   - As mensagens de cada sessão ficam em "euterpe:messages:<id>"
   - A sessão ativa é usada em todo chat.send / chat.clear
   ============================================================ */
const SESSIONS_KEY = "euterpe:sessions";
const LEGACY_SESSION_KEY = "euterpe:session";
const MSG_PREFIX = "euterpe:messages:";
const MAX_SESSIONS = 12;
const SESSION_TITLE_MAX = 28;

function newSessionId() {
  return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function sessionTitle(messages) {
  const first = (messages || []).find((m) => m.role === "user");
  if (!first) return "Conversa";
  const text = String(first.content || "").replace(/<[^>]+>/g, "").trim();
  return text.length > SESSION_TITLE_MAX ? text.slice(0, SESSION_TITLE_MAX) + "…" : text || "Conversa";
}

/* Camada única de persistência de sessões/mensagens. */
const sessionStore = {
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
  /* Migra a sessão única antiga (euterpe:session) para a lista. */
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

/* Hook de sessões: estado + operações + persistência. */
function useSessions() {
  const { useState, useEffect } = React;
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [messages, setMessages] = useState([]);

  // Inicialização: restaura sessões salvas, migra a legada ou cria uma nova.
  useEffect(() => {
    let list = sessionStore.list();
    if (!list || !list.length) list = sessionStore.migrateLegacy();
    if (!list || !list.length) list = [{ id: newSessionId(), title: "Conversa" }];
    setSessions(list);
    const last = list[list.length - 1];
    setCurrentId(last.id);
    setMessages(sessionStore.messages(last.id));
  }, []);

  // Persiste a lista de sessões.
  useEffect(() => {
    if (!sessions.length) return;
    sessionStore.save(sessions);
  }, [sessions]);

  // Persiste as mensagens da sessão atual (debounce).
  useEffect(() => {
    if (!currentId || !messages.length) return;
    const t = setTimeout(() => sessionStore.saveMessages(currentId, messages), 400);
    return () => clearTimeout(t);
  }, [messages, currentId]);

  // Mantém o título da sessão atual sincronizado com a 1ª msg do usuário.
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
    setSessions((prev) => [...prev.slice(-(MAX_SESSIONS - 1)), { id, title: "Conversa" }]);
    setCurrentId(id);
    setMessages([]);
  };

  const closeSession = (id) => {
    sessionStore.removeMessages(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id !== currentId) return next;
      if (next.length) {
        const last = next[next.length - 1];
        setCurrentId(last.id);
        setMessages(sessionStore.messages(last.id));
        return next;
      }
      const fresh = { id: newSessionId(), title: "Conversa" };
      setCurrentId(fresh.id);
      setMessages([]);
      return [fresh];
    });
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
  };
}

function nativeIcon(name, size) {
  try {
    const path = Spicetify && Spicetify.SVGIcons && Spicetify.SVGIcons[name];
    if (!path) return null;
    return React.createElement("svg", {
      width: size || 14,
      height: size || 14,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      dangerouslySetInnerHTML: { __html: path },
    });
  } catch (err) {
    return null;
  }
}

function spotifyLinkIcon(size) {
  const path =
    (Spicetify &&
      Spicetify.SVGIcons &&
      (Spicetify.SVGIcons["spotify-logo"] || Spicetify.SVGIcons["external-link"] || Spicetify.SVGIcons["link"])) ||
    null;
  if (path) {
    return React.createElement("svg", {
      width: size || 14,
      height: size || 14,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      dangerouslySetInnerHTML: { __html: path },
    });
  }
  return React.createElement(
    "svg",
    { width: size || 14, height: size || 14, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
    React.createElement("path", {
      d: "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm3.67 11.54c-.15.24-.47.31-.71.16-1.94-1.18-4.38-1.45-7.26-.8-.28.06-.55-.12-.61-.4-.06-.28.12-.55.4-.61 3.15-.7 5.85-.4 8.01.9.25.15.32.48.17.72Zm.99-2.18c-.19.3-.58.39-.88.2-2.22-1.36-5.6-1.76-8.22-.96-.32.1-.67-.08-.77-.4-.1-.32.08-.67.4-.77 2.98-.91 6.69-.46 9.26 1.12.3.18.38.58.21.88v.01Zm.09-2.26C10.07 5.4 6.06 5.21 3.57 5.99c-.38.12-.78-.1-.9-.47-.12-.38.1-.78.47-.9 2.84-.89 7.27-.68 10.14 1.34.34.25.42.73.18 1.07-.25.34-.73.42-1.07.18l-.02-.01Z",
    })
  );
}

/* Logo Euterpe — mesma arte do ícone em manifest.json (duas colcheias com
   barra dupla). Mantenha o path/elipses sincronizados com o manifest. */
function euterpeLogo(size) {
  return React.createElement(
    "svg",
    {
      width: size || 18,
      height: size || 18,
      viewBox: "0 0 16 16",
      fill: "currentColor",
      "aria-hidden": true,
      style: { display: "block" },
    },
    React.createElement("path", { d: "M5.9 12.6L5.9 3 12.9 3.3 12.9 12.6 12.2 12.6 12.2 4.5 6.6 4.2 6.6 12.6Z" }),
    React.createElement("ellipse", { cx: "5.1", cy: "12.7", rx: "1.65", ry: "1.2", transform: "rotate(-20 5.1 12.7)" }),
    React.createElement("ellipse", { cx: "11.6", cy: "12.7", rx: "1.65", ry: "1.2", transform: "rotate(-20 11.6 12.7)" })
  );
}

function spotifyChip(raw, key) {
  const m = raw.match(/^\{\{\s*spotify:(track|playlist|album|artist|show|episode):([A-Za-z0-9_-]{6,})(?:\s*\|\s*([\s\S]*?))?\s*\}\}$/);
  if (!m) return null;
  const type = m[1];
  const uri = "spotify:" + type + ":" + m[2];
  const label = (m[3] || "").trim() || uri;
  const iconName = { track: "play", playlist: "playlist", album: "album", artist: "artist" }[type] || "play";
  const isArtist = type === "artist";
  const play = () => {
    try {
      const P = Spicetify.Player;
      if (P && typeof P.playUri === "function") {
        P.playUri(uri);
      } else if (P && P.origin && typeof P.origin.play === "function") {
        P.origin.play({ uri });
      }
    } catch (err) {}
  };
  const open = () => {
    try {
      if (window.euterpe && typeof window.euterpe.openUri === "function") {
        if (window.euterpe.openUri(uri)) return;
      }
    } catch (err) {}
    try {
      const hist = Spicetify.Platform && Spicetify.Platform.History;
      if (hist && typeof hist.push === "function") {
        hist.push(uri);
      }
    } catch (err) {}
  };
  if (isArtist) {
    return React.createElement(
      "button",
      {
        key,
        onClick: open,
        title: "Abrir página do artista no Spotify",
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-accent)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 13,
          padding: 0,
          margin: "2px 4px 2px 0",
          verticalAlign: "middle",
          textDecoration: "underline",
          textUnderlineOffset: 2,
          textDecorationColor: "var(--euterpe-accent)",
        },
      },
      ...mdInline(label, `${key}-lb`)
    );
  }
  return React.createElement(
    "span",
    {
      key,
      title: uri,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "var(--euterpe-chip-bg)",
        border: "1px solid var(--euterpe-chip-border)",
        borderRadius: "500px",
        padding: "3px 8px 3px 8px",
        margin: "2px 4px 2px 0",
        verticalAlign: "middle",
      },
    },
    React.createElement("span", { style: { display: "inline-flex", opacity: 0.9, color: "var(--euterpe-accent)" } }, nativeIcon(iconName)),
    React.createElement(
      "button",
      {
        onClick: play,
        title: "Tocar",
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-text)",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: 13,
          padding: 0,
        },
      },
      ...mdInline(label, `${key}-lb`)
    ),
    React.createElement(
      "button",
      {
        onClick: open,
        title: "Abrir no Spotify",
        "aria-label": "Abrir no Spotify",
        style: {
          background: "none",
          border: "none",
          color: "var(--euterpe-accent)",
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
        },
      },
      spotifyLinkIcon(12)
    )
  );
}

function mdInline(text, keyPrefix) {
  const nodes = [];
  const tokenRe =
    /(\{\{spotify:[\s\S]+?\}\}|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|~~[^~\n]+~~|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(React.createElement("span", { key: `${keyPrefix}-t${k++}` }, text.slice(last, m.index)));
    }
    const tok = m[0];
    let el = null;
    if (tok.startsWith("{{spotify:")) {
      el = spotifyChip(tok, `${keyPrefix}-sp${k++}`);
      if (!el) {
        el = React.createElement("span", { key: `${keyPrefix}-spraw${k++}` }, tok);
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      el = React.createElement("strong", { key: `${keyPrefix}-b${k++}` }, ...mdInline(tok.slice(2, -2), `${keyPrefix}-bin${k}`));
    } else if (tok.startsWith("`")) {
      el = React.createElement(
        "code",
        {
          key: `${keyPrefix}-c${k++}`,
          style: {
            background: "var(--euterpe-code-bg)",
            padding: "1px 5px",
            borderRadius: 4,
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.9em",
          },
        },
        tok.slice(1, -1)
      );
    } else if (tok.startsWith("~~")) {
      el = React.createElement("s", { key: `${keyPrefix}-s${k++}` }, ...mdInline(tok.slice(2, -2), `${keyPrefix}-sin${k}`));
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) {
        el = React.createElement(
          "a",
          {
            key: `${keyPrefix}-a${k++}`,
            href: mm[2],
            target: "_blank",
            rel: "noopener noreferrer",
            style: { color: "var(--euterpe-accent)", textDecoration: "underline" },
          },
          ...mdInline(mm[1], `${keyPrefix}-ain${k}`)
        );
      }
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      el = React.createElement("em", { key: `${keyPrefix}-i${k++}` }, ...mdInline(tok.slice(1, -1), `${keyPrefix}-iin${k}`));
    }
    if (el) nodes.push(el);
    last = m.index + tok.length;
  }
  if (last < text.length) {
    nodes.push(React.createElement("span", { key: `${keyPrefix}-t${k++}` }, text.slice(last)));
  }
  return nodes;
}

function renderMarkdown(md, keyBase = "md") {
  if (!md) return [];
  const blocks = [];
  const lines = md.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      const codeText = code.join("\n");
      const copy = () => {
        try {
          navigator.clipboard && navigator.clipboard.writeText(codeText);
        } catch (err) {}
      };
      blocks.push(
        React.createElement(
          "div",
          {
            key: `${keyBase}-code${key++}`,
            style: {
              background: "var(--euterpe-overlay)",
              borderRadius: 10,
              padding: "10px 12px",
              margin: "6px 0",
              position: "relative",
            },
          },
          React.createElement(
            "pre",
            { style: { margin: 0, overflowX: "auto", fontFamily: "ui-monospace, monospace", fontSize: "12px", whiteSpace: "pre-wrap" } },
            React.createElement("code", null, codeText)
          ),
          React.createElement(
            "button",
            {
              onClick: copy,
              style: {
                position: "absolute",
                top: 6,
                right: 6,
                background: "var(--euterpe-btn-bg)",
                border: "none",
                borderRadius: 6,
                padding: "3px 8px",
                fontSize: 11,
                color: "var(--euterpe-text)",
                cursor: "pointer",
              },
            },
            "copiar"
          )
        )
      );
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: "1.35em", 2: "1.2em", 3: "1.1em", 4: "1em", 5: ".95em", 6: ".9em" };
      const tag = "h" + level;
      blocks.push(
        React.createElement(
          tag,
          { key: `${keyBase}-h${key++}`, style: { margin: "10px 0 4px", fontSize: sizes[level], fontWeight: 700 } },
          ...mdInline(h[2], `${keyBase}-h${key}`)
        )
      );
      i++;
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        React.createElement(
          "blockquote",
          {
            key: `${keyBase}-q${key++}`,
            style: {
              margin: "6px 0",
              padding: "2px 12px",
              borderLeft: "3px solid var(--euterpe-accent)",
              color: "var(--euterpe-text-dim)",
            },
          },
          ...mdInline(quote.join("\n"), `${keyBase}-q${key}`)
        )
      );
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        React.createElement("hr", {
          key: `${keyBase}-hr${key++}`,
          style: { border: "none", borderTop: "1px solid var(--euterpe-divider)", margin: "8px 0" },
        })
      );
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (bullet || ordered) {
      const isTask = /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        const bl = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const ol = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (bullet && bl) {
          items.push(bl[1]);
          i++;
        } else if (ordered && ol) {
          items.push(ol[1]);
          i++;
        } else break;
      }
      if (isTask) {
        blocks.push(
          React.createElement(
            "div",
            { key: `${keyBase}-t${key++}`, style: { margin: "6px 0", display: "flex", flexDirection: "column", gap: "3px" } },
            items.map((it, j) => {
              const tm = it.match(/^\[([ xX])\]\s+(.*)$/);
              const checked = tm ? /[xX]/.test(tm[1]) : false;
              const body = tm ? tm[2] : it;
              return React.createElement(
                "div",
                { key: j, style: { display: "flex", alignItems: "flex-start", gap: 8 } },
                React.createElement(
                  "span",
                  {
                    style: {
                      color: checked ? "var(--euterpe-accent)" : "var(--euterpe-text-muted)",
                      fontSize: 13,
                      lineHeight: "1.5",
                    },
                  },
                  checked ? "☑" : "☐"
                ),
                React.createElement("span", { style: checked ? { opacity: 0.6, textDecoration: "line-through" } : {} }, ...mdInline(body, `${keyBase}-tk${key}${j}`))
              );
            })
          )
        );
        continue;
      }
      blocks.push(
        React.createElement(
          bullet ? "ul" : "ol",
          { key: `${keyBase}-l${key++}`, style: { margin: "6px 0", paddingLeft: "22px" } },
          items.map((it, j) =>
            React.createElement("li", { key: j, style: { margin: "2px 0" } }, ...mdInline(it, `${keyBase}-li${key}${j}`))
          )
        )
      );
      continue;
    }

    const soloChip = line.trim().match(/^\{\{spotify:[\s\S]+?\}\}$/);
    if (soloChip) {
      const chip = spotifyChip(line.trim(), `${keyBase}-solo${key++}`);
      if (chip) {
        blocks.push(React.createElement("div", { key: `${keyBase}-solo${key}`, style: { margin: "4px 0" } }, chip));
        i++;
        continue;
      }
    }

    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("```")) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      blocks.push(
        React.createElement("p", { key: `${keyBase}-p${key++}`, style: { margin: "4px 0" } }, ...mdInline(para.join(" "), `${keyBase}-p${key}`))
      );
    } else {
      i++;
    }
  }
  return blocks;
}

(function injectStyles() {
  try {
    // Substitui em vez de retornar cedo: o <style> persiste entre navegações do
    // custom app na mesma sessão do Spotify, e o arquivo pode ser relido após um
    // update sem reiniciar o cliente — o CSS novo precisa chegar de novo.
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
/* Botões do app — classes utilitárias escopadas no root do app para vencer os
   resets do Encore (specificity 0,2,0) com reset completo de estilo. */
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
/* Quick replies — balões de sugestão dentro do thread de conversa. */
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
@media (prefers-reduced-motion: reduce) {
  .euterpe-app * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}`;
    document.head.appendChild(s);
  } catch (err) {}
})();

function Euterpe() {
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
  } = useSessions();
  const [status, setStatus] = useState("conectando…");
  const [tool, setTool] = useState(null);
  const [connected, setConnected] = useState(window.euterpe ? window.euterpe.connected : false);
  const [proposal, setProposal] = useState(null);
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [agentVersion, setAgentVersion] = useState(
    window.euterpe && window.euterpe.agentVersion ? window.euterpe.agentVersion : null
  );
  const [focused, setFocused] = useState(false);
  const listRef = useRef(null);
  const bus = window.euterpe;

  useEffect(() => {
    if (!bus) return;
    const off = bus.onMessage((msg) => {
      switch (msg.type) {
        case "chat.stream":
          streamDelta(msg.delta);
          break;
        case "chat.done":
          markLastDone();
          setTool(null);
          setStatus("conectado");
          // Só mexe nas sugestões quando o agente mandou o campo — o routing
          // (songchange) também emite chat.done sem suggestions e não deve
          // resetar os pills contextuais da conversa.
          if (Array.isArray(msg.suggestions)) setSuggestions(msg.suggestions.slice(0, 3));
          break;
        case "chat.cleared":
          clearMessages();
          setTool(null);
          setStatus("conversa limpa");
          setSuggestions([]);
          break;
        case "proposal.create":
          setProposal({ id: msg.proposalId, title: msg.title, detail: msg.detail || msg.name || "" });
          break;
        case "chat.status":
          if (msg.status === "tool") {
            setTool(msg.detail);
            setStatus("");
          } else if (msg.status === "offline") {
            setConnected(false);
            setTool(null);
            setStatus(msg.detail || "desconectado");
          } else {
            setTool(null);
            setStatus(msg.detail || msg.status);
          }
          break;
        case "hello.ok":
          setConnected(true);
          setStatus("conectado");
          setAgentVersion(msg.version || (window.euterpe && window.euterpe.agentVersion) || null);
          break;
        default:
          break;
      }
    });
    return () => off();
  }, []);

  const decide = (decision) => {
    if (!proposal || !bus) return;
    bus.send({ type: "proposal.decision", proposalId: proposal.id, decision });
    setProposal(null);
  };

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, status, tool, suggestions]);

  const send = (textOverride) => {
    const text = (textOverride !== undefined ? textOverride : input).trim();
    if (!text || !bus || !currentId) return;
    pushUser(text);
    setInput("");
    setSuggestions([]);
    setStatus("enviando…");
    bus.send({ type: "chat.send", text, sessionId: currentId });
  };

  const clear = () => {
    if (!bus || !currentId) return;
    clearMessages();
    bus.send({ type: "chat.clear", sessionId: currentId });
    setSuggestions([]);
  };

  if (!bus) {
    return React.createElement(
      "section",
      { className: "contentSpacing" },
      React.createElement("h1", null, "Euterpe"),
      React.createElement(
        "p",
        null,
        "A extension 'euterpe.js' não está carregada. Instale-a na pasta Extensions do spicetify e reabra o Spotify."
      )
    );
  }

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
  const connecting = !connected && status === "conectando…";
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
      ? `conectado ao agente · v${agentVersion}`
      : "conectado ao agente"
    : status || "desconectado";
  const headerActionsStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
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
              React.createElement("span", { style: dotStyle, title: connected ? "conectado" : "desconectado" }),
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
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              onClick: clear,
              title: "Apagar as mensagens desta conversa",
              "aria-label": "Limpar conversa",
            },
            nativeIcon("ban", 13),
            "Limpar conversa"
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
                // Se fechou a sessão ativa, a thread muda — os quick replies da
                // sessão anterior não podem vazar para a próxima.
                if (s.id === currentId) setSuggestions([]);
                closeSession(s.id);
              },
              style: tabCloseStyle,
              title: "Fechar sessão",
              "aria-label": "Fechar sessão",
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
            newSession();
          },
          style: tabNewStyle,
          title: "Nova conversa",
          "aria-label": "Nova conversa",
        },
        "+"
      )
    ),
    React.createElement(
      "div",
      {
        ref: listRef,
        style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", padding: "12px 0", scrollbarWidth: "thin" },
      },
      !messages.length && !tool && (!status || status === "conectado")
        ? React.createElement(
            "div",
            { style: emptyStateStyle },
            React.createElement("div", { style: emptyLogoStyle, "aria-hidden": true }, euterpeLogo(26)),
            React.createElement("div", { style: { fontSize: 16, fontWeight: 700, color: "var(--euterpe-text)" } }, "Seu assistente musical"),
            React.createElement(
              "div",
              { style: { fontSize: 13, lineHeight: 1.5, color: "var(--euterpe-subtext)" } },
              "Pergunte sobre playlists, artistas, mood e lançamentos — depois de cada resposta, o Euterpe sugere os próximos passos."
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
              ])
        )
      ),
      suggestions.length && connected && !tool
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
              React.createElement(
                "button",
                { key: i, className: "euterpe-quickreply", onClick: () => send(text) },
                text
              )
            )
          )
        : null,
      tool
        ? React.createElement(
            "div",
            { style: { color: "var(--euterpe-status)", fontSize: "12px", display: "flex", gap: "6px", alignItems: "center" } },
            React.createElement("span", { style: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "var(--euterpe-accent)" } }),
            tool.replace("usando ", "")
          )
        : null,
      status && !tool && status !== "conectado"
        ? React.createElement("div", { style: { color: "var(--euterpe-status)", fontSize: "12px" } }, status)
        : null
    ),
    proposal
      ? React.createElement(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              background: "var(--euterpe-accent-soft-2)",
              border: "1px solid var(--euterpe-accent-border-strong)",
              borderRadius: "12px",
              padding: "10px 14px",
              marginBottom: "8px",
            },
          },
          React.createElement(
            "div",
            { style: { fontSize: "13px", fontWeight: 600 } },
            proposal.title
          ),
          React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", flexShrink: 0 } },
            React.createElement(
              "button",
              {
                onClick: () => decide("approve"),
                style: {
                  background: "var(--euterpe-accent)",
                  color: "var(--euterpe-on-accent)",
                  border: "none",
                  borderRadius: "500px",
                  padding: "8px 16px",
                  fontWeight: 700,
                  cursor: "pointer",
                },
              },
              "Confirmar"
            ),
            React.createElement(
              "button",
              {
                onClick: () => decide("reject"),
                style: {
                  background: "transparent",
                  border: "1px solid var(--euterpe-border)",
                  borderRadius: "500px",
                  padding: "8px 16px",
                  cursor: "pointer",
                  color: "var(--euterpe-text)",
                },
              },
              "Cancelar"
            )
          )
        )
      : null,
    React.createElement(
      "div",
      { style: { display: "flex", gap: "8px", paddingBottom: "16px" } },
      React.createElement("input", {
        style: {
          flex: 1,
          background: "var(--euterpe-surface-soft)",
          border: focused ? "1px solid var(--euterpe-accent-border-strong)" : "1px solid transparent",
          borderRadius: "500px",
          padding: "10px 14px",
          color: "var(--euterpe-text)",
          outline: "none",
          transition: "border-color .15s ease",
          opacity: connected ? 1 : 0.5,
        },
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        placeholder: "Ex.: pega os artistas da minha playlist X e busca músicas de término…",
        value: input,
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") send();
        },
        disabled: !connected,
      }),
      React.createElement(
        "button",
        {
          style: {
            background: "var(--euterpe-accent)",
            color: "var(--euterpe-on-accent)",
            border: "none",
            borderRadius: "500px",
            padding: "10px 18px",
            fontWeight: 700,
            cursor: connected ? "pointer" : "not-allowed",
            opacity: connected ? 1 : 0.5,
          },
          onClick: send,
          disabled: !connected,
        },
        "Enviar"
      )
    )
  );
}

function render() {
  return React.createElement(Euterpe);
}
