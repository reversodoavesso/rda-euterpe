// Painel MCP (Proposta 2): chip "MCP ativo · N clientes", URL do endpoint e os
// três snippets de registro copiáveis. O endpoint é o Streamable HTTP do daemon
// (POST /mcp na mesma porta 8337 do bridge) — não há servidor separado.
//
// Apresentação: token do Encore para cor/espaço, `TextComponent` nativo para o
// texto e o bloco de código com o mesmo `--background-tinted-base` que a tela
// nativa usa nos campos. Sem hex.
import { tr } from "../lib/i18n.js";
import { BASE, mcpInfo } from "../lib/daemon.js";
import { copyText } from "./markdown.js";
import { Badge, Button, Text, COLOR, TEXT } from "./ds.js";

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
    { style: { display: "flex", flexDirection: "column", gap: "var(--encore-spacing-tighter-4, 4px)" } },
    React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, label),
    React.createElement(
      "div",
      { style: { position: "relative" } },
      React.createElement("pre", { className: "ds-code", style: { paddingRight: 72 } }, text),
      React.createElement(
        Button,
        {
          kind: "secondary",
          size: "small",
          className: "ds-snippet-copy",
          onClick: () => onCopy(text),
          title: tr("action.copy"),
          "aria-label": tr("action.copy"),
        },
        tr("action.copy"),
      ),
    ),
  );
}

export function McpPanel({ onToast, enabled = true }) {
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

  const ok = enabled && !!(info && info.ok);
  const clients = (info && info.clients) || 0;
  const chip = !enabled ? tr("mcp.offline") : ok ? tr("mcp.chip", { clients }) : tr("mcp.offline");

  return React.createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "var(--encore-spacing-tighter-2, 8px)" } },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "var(--encore-spacing-tighter-2, 8px)", flexWrap: "wrap" } },
      React.createElement(Badge, { tone: ok ? "accent" : "danger", text: loading && !info ? tr("settings.loading") : chip }),
      React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, `${tr("mcp.url")}: ${BASE}/mcp`),
    ),
    React.createElement(Text, { as: "p", variant: TEXT.caption, color: COLOR.subdued, style: { margin: 0 } }, tr("mcp.help")),
    snippetRows(info && info.dataDir).map((row) =>
      React.createElement(Snippet, { key: row.key, label: row.label, text: row.text, onCopy: copy })
    ),
  );
}
