// Painel MCP (Proposta 2): chip "MCP ativo · N clientes", URL do endpoint e os
// três snippets de registro copiáveis. O endpoint é o Streamable HTTP do daemon
// (POST /mcp na mesma porta 8337 do bridge) — não há servidor separado.
import { tr } from "../lib/i18n.js";
import { BASE, mcpInfo } from "../lib/daemon.js";
import { copyText } from "./markdown.js";

const { React } = Spicetify;

const PATH_FALLBACK = "C:\\Users\\<user>\\AppData\\Roaming\\euterpe";

function stdioSnippet(dataDir) {
  const exe = `${dataDir || PATH_FALLBACK}\\euterpe.exe`;
  return JSON.stringify({ mcpServers: { euterpe: { command: exe, args: ["mcp", "--stdio"] } } }, null, 2);
}

function snippetRows(dataDir) {
  const url = `${BASE}/mcp`;
  return [
    { key: "opencode", label: tr("mcp.opencode"), text: `opencode mcp add euterpe --url ${url}` },
    { key: "claude", label: tr("mcp.claude"), text: `claude mcp add --transport http euterpe ${url}` },
    { key: "stdio", label: tr("mcp.stdio"), text: stdioSnippet(dataDir) },
  ];
}

function Snippet({ label, text, onCopy }) {
  return React.createElement(
    "div",
    { style: { marginBottom: 10 } },
    React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: "var(--euterpe-subtext)", marginBottom: 4 } }, label),
    React.createElement(
      "div",
      { style: { position: "relative" } },
      React.createElement(
        "pre",
        {
          style: {
            margin: 0,
            padding: "8px 46px 8px 10px",
            background: "var(--euterpe-overlay)",
            borderRadius: 8,
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "var(--euterpe-text)",
          },
        },
        text
      ),
      React.createElement(
        "button",
        {
          className: "euterpe-btn euterpe-btn-ghost",
          style: { position: "absolute", top: 4, right: 4, padding: "3px 8px", fontSize: 10 },
          onClick: () => onCopy(text),
          title: tr("action.copy"),
          "aria-label": tr("action.copy"),
        },
        tr("action.copy")
      )
    )
  );
}

export function McpPanel({ onToast }) {
  const { useState, useEffect } = React;
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () => {
      mcpInfo()
        .then((data) => {
          if (alive) setInfo(data);
        })
        .catch(() => {})
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    load();
    // O contador de clientes muda quando um cliente MCP entra/sai.
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const copy = (text) => {
    const ok = copyText(text);
    if (onToast) onToast(ok ? tr("action.copied") : tr("error.title"), ok ? "info" : "error");
  };

  const ok = !!(info && info.ok);
  const clients = (info && info.clients) || 0;
  const chip = ok ? tr("mcp.chip", { clients }) : tr("mcp.offline");

  return React.createElement(
    "div",
    null,
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" } },
      React.createElement(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 500,
            fontSize: 12,
            fontWeight: 600,
            background: ok ? "var(--euterpe-accent-soft)" : "var(--euterpe-danger-soft)",
            border: `1px solid ${ok ? "var(--euterpe-accent-border-strong)" : "var(--euterpe-danger)"}`,
            color: "var(--euterpe-text)",
          },
        },
        React.createElement("span", {
          style: {
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: ok ? "var(--euterpe-accent)" : "var(--euterpe-danger)",
          },
        }),
        loading && !info ? tr("settings.loading") : chip
      )
    ),
    React.createElement("p", { style: { fontSize: 12, lineHeight: 1.5, color: "var(--euterpe-subtext)", margin: "0 0 10px" } }, tr("mcp.help")),
    React.createElement(
      "div",
      { style: { fontSize: 11, fontWeight: 700, color: "var(--euterpe-subtext)", marginBottom: 4 } },
      `${tr("mcp.url")}: ${BASE}/mcp`
    ),
    snippetRows(info && info.dataDir).map((row) =>
      React.createElement(Snippet, { key: row.key, label: row.label, text: row.text, onCopy: copy })
    )
  );
}
