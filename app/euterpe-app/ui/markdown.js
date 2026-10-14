// Renderização de markdown do chat — movido verbatim de euterpe-app/index.js.
//
// Nada aqui mudou de comportamento: mesmo parser de tokens inline, mesmos chips
// {{spotify:...}}, mesmas tags/estilos inline. A única diferença é a função
// `copyText` compartilhada (Clipboard API + fallback) para o botão "copiar" do
// bloco de código — a mesma usada pelo botão de copiar mensagem.
import { tr } from "../lib/i18n.js";

const { React } = Spicetify;

/** Copia para a área de transferência; devolve false quando não foi possível. */
export function copyText(text) {
  const value = String(text == null ? "" : text);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {}
  // Fallback (renderer sem permissão de clipboard API): textarea temporário.
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (err) {
    return false;
  }
}

export function nativeIcon(name, size) {
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

export function spotifyLinkIcon(size) {
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

/* Euterpe logo — same art as the manifest.json icon (two beamed notes with a
   double bar). Keep the path/ellipses in sync with the manifest. */
export function euterpeLogo(size) {
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

export function spotifyChip(raw, key) {
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
        title: tr("chip.artistTitle"),
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
        title: tr("chip.play"),
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
        title: tr("chip.open"),
        "aria-label": tr("chip.open"),
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

export function mdInline(text, keyPrefix) {
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

export function renderMarkdown(md, keyBase = "md") {
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
        copyText(codeText);
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
            tr("code.copy")
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
