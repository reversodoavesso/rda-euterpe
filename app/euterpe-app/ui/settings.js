// Painel de setup (Fase 6): providers/modelos/chaves + botão "testar" + toggles.
//
// Tudo vem do daemon (GET/PUT /settings, GET /providers, GET /models,
// POST /providers, POST /providers/test, DELETE /providers/:id) — a UI não guarda
// estado de configuração em lugar nenhum: o daemon é a fonte de verdade.
// A chave nunca volta do daemon (só `hasKey`), então o campo nasce vazio e só é
// enviado quando o usuário digita uma nova.
import { tr } from "../lib/i18n.js";
import { BASE, deleteProvider, getSettings, listModels, listProviders, saveProvider, saveSettings, testProvider } from "../lib/daemon.js";
import { McpPanel } from "./mcp-panel.js";

const { React } = Spicetify;

const MUTATION_POLICIES = ["allow", "confirm", "deny"];
const WEB_SEARCH = ["auto", "searxng", "brave", "tavily", "duckduckgo", "off"];

function label(text) {
  return React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: "var(--euterpe-subtext)", marginBottom: 4 } }, text);
}

function Badge({ text, tone }) {
  const danger = tone === "danger";
  return React.createElement(
    "span",
    {
      style: {
        padding: "2px 8px",
        borderRadius: 500,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".2px",
        background: danger ? "var(--euterpe-danger-soft)" : "var(--euterpe-accent-soft-2)",
        border: `1px solid ${danger ? "var(--euterpe-danger)" : "var(--euterpe-accent-border-strong)"}`,
        color: "var(--euterpe-text)",
      },
    },
    text
  );
}

/** Campo numérico que só persiste no blur/Enter (evita PUT por tecla). */
function NumberField({ value, onCommit }) {
  const { useState, useEffect } = React;
  const [draft, setDraft] = useState(String(value == null ? "" : value));
  useEffect(() => setDraft(String(value == null ? "" : value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0 && n !== value) onCommit(Math.floor(n));
  };
  return React.createElement("input", {
    type: "number",
    min: 1,
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === "Enter") commit();
    },
    style: {
      width: 80,
      background: "var(--euterpe-surface-soft)",
      border: "1px solid var(--euterpe-divider)",
      borderRadius: 8,
      padding: "6px 8px",
      color: "var(--euterpe-text)",
      fontFamily: "inherit",
      fontSize: 12,
    },
  });
}

function Select({ value, options, onChange, labels }) {
  return React.createElement(
    "select",
    {
      value: value == null ? "" : value,
      onChange: (e) => onChange(e.target.value),
      style: {
        background: "var(--euterpe-surface-soft)",
        border: "1px solid var(--euterpe-divider)",
        borderRadius: 8,
        padding: "6px 8px",
        color: "var(--euterpe-text)",
        fontFamily: "inherit",
        fontSize: 12,
        maxWidth: 260,
      },
    },
    options.map((opt) => React.createElement("option", { key: opt, value: opt }, labels && labels[opt] ? labels[opt] : opt))
  );
}

function Toggle({ checked, onChange, text }) {
  return React.createElement(
    "label",
    { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer", minWidth: 160 } },
    React.createElement("input", { type: "checkbox", checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
    text
  );
}

export function SettingsPanel({ onClose, onToast }) {
  const { useState, useEffect } = React;
  const [tab, setTab] = useState("setup");
  const [providers, setProviders] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [models, setModels] = useState({});
  const [chosen, setChosen] = useState({});
  const [keys, setKeys] = useState({});
  const [busy, setBusy] = useState({});
  const [reports, setReports] = useState({});

  const notify = (text, level) => {
    if (onToast) onToast(text, level || "info");
  };

  const reload = () =>
    Promise.all([listProviders(), getSettings()])
      .then(([p, s]) => {
        setProviders((p && p.providers) || []);
        setSettings((s && s.settings) || {});
        setError(null);
      })
      .catch((err) => setError(err && err.message ? err.message : String(err)));

  useEffect(() => {
    reload();
  }, []);

  const patch = (body) =>
    saveSettings(body)
      .then((res) => {
        if (res && res.settings) setSettings(res.settings);
        notify(tr("settings.saved"));
        return res;
      })
      .catch((err) => notify(err.message, "error"));

  const modelOptions = (p) => {
    const known = models[p.id] || p.models || [];
    const current = chosen[p.id] || (settings && settings.activeProvider === p.id ? settings.activeModel : p.defaultModel);
    const list = known.slice();
    if (current && list.indexOf(current) < 0) list.unshift(current);
    if (!list.length) list.push("");
    return list;
  };

  const loadModels = (p) => {
    setBusy((b) => ({ ...b, [p.id]: "models" }));
    listModels({ provider: p.id, baseUrl: p.baseUrl })
      .then((res) => {
        const ids = ((res && res.models) || []).map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
        setModels((m) => ({ ...m, [p.id]: ids }));
        notify(`${p.id}: ${ids.length} ${tr("settings.model").toLowerCase()}`);
      })
      .catch((err) => notify(`${p.id}: ${err.message}`, "error"))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: null })));
  };

  const useProvider = (p) => {
    const model = chosen[p.id] || (settings && settings.activeProvider === p.id ? settings.activeModel : p.defaultModel) || "";
    patch({ activeProvider: p.id, activeModel: model });
  };

  const selectModel = (p, model) => {
    setChosen((c) => ({ ...c, [p.id]: model }));
    if (settings && settings.activeProvider === p.id && model) patch({ activeModel: model });
  };

  const saveKey = (p) => {
    const apiKey = (keys[p.id] || "").trim();
    if (!apiKey) return;
    setBusy((b) => ({ ...b, [p.id]: "key" }));
    saveProvider({ id: p.id, apiKey })
      .then(() => {
        setKeys((k) => ({ ...k, [p.id]: "" }));
        notify(`${p.id}: ${tr("settings.keySet")}`);
        return reload();
      })
      .catch((err) => notify(`${p.id}: ${err.message}`, "error"))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: null })));
  };

  const removeKey = (p) => {
    setBusy((b) => ({ ...b, [p.id]: "key" }));
    deleteProvider(p.id)
      .then(() => {
        notify(`${p.id}: ${tr("settings.keyMissing")}`);
        return reload();
      })
      .catch((err) => notify(`${p.id}: ${err.message}`, "error"))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: null })));
  };

  const runTest = (p) => {
    const model = chosen[p.id] || (settings && settings.activeProvider === p.id ? settings.activeModel : p.defaultModel) || "";
    const apiKey = (keys[p.id] || "").trim();
    setBusy((b) => ({ ...b, [p.id]: "test" }));
    setReports((r) => ({ ...r, [p.id]: null }));
    testProvider(apiKey ? { provider: p.id, model, apiKey } : { provider: p.id, model })
      .then((res) => {
        const report = (res && res.report) || {};
        const parts = [];
        if (report.latencyMs != null) parts.push(tr("settings.latency", { ms: report.latencyMs }));
        if (report.model) parts.push(report.model);
        const text = report.ok ? parts.join(" · ") || "ok" : report.code || report.detail || "failed";
        setReports((r) => ({ ...r, [p.id]: { ok: !!report.ok, text } }));
        if (report.ok && apiKey) reload();
      })
      .catch((err) => setReports((r) => ({ ...r, [p.id]: { ok: false, text: err.message } })))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: null })));
  };

  const tabButton = (id, text) =>
    React.createElement(
      "button",
      {
        key: id,
        className: "euterpe-btn",
        style: {
          background: tab === id ? "var(--euterpe-accent-soft)" : "transparent",
          borderColor: tab === id ? "var(--euterpe-accent-border-strong)" : "var(--euterpe-divider)",
          border: `1px solid ${tab === id ? "var(--euterpe-accent-border-strong)" : "var(--euterpe-divider)"}`,
        },
        onClick: () => setTab(id),
      },
      text
    );

  const providerCard = (p) => {
    const active = settings && settings.activeProvider === p.id;
    const pending = busy[p.id];
    const report = reports[p.id];
    const opts = modelOptions(p);
    const value = chosen[p.id] || (active ? settings.activeModel : p.defaultModel) || opts[0] || "";
    return React.createElement(
      "div",
      {
        key: p.id,
        style: {
          border: `1px solid ${active ? "var(--euterpe-accent-border-strong)" : "var(--euterpe-divider)"}`,
          borderRadius: 12,
          padding: 12,
          marginBottom: 10,
          background: "var(--euterpe-surface)",
        },
      },
      React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
        React.createElement("span", { style: { fontSize: 13, fontWeight: 700 } }, p.name || p.id),
        React.createElement("span", { style: { fontSize: 11, color: "var(--euterpe-text-muted)" } }, `${p.id} · ${p.kind}`),
        active ? Badge({ text: tr("settings.active") }) : null,
        p.hasKey ? Badge({ text: tr("settings.keySet") }) : p.needsKey ? Badge({ text: tr("settings.keyMissing"), tone: "danger" }) : null,
        active
          ? null
          : React.createElement(
              "button",
              { className: "euterpe-btn euterpe-btn-ghost", style: { marginLeft: "auto" }, onClick: () => useProvider(p) },
              tr("settings.use")
            )
      ),
      label(tr("settings.model")),
      React.createElement(
        "div",
        { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 } },
        React.createElement(Select, { value, options: opts, onChange: (m) => selectModel(p, m) }),
        React.createElement(
          "button",
          { className: "euterpe-btn euterpe-btn-ghost", onClick: () => loadModels(p), disabled: pending === "models" },
          pending === "models" ? tr("settings.loading") : tr("settings.refreshModels")
        )
      ),
      p.needsKey
        ? React.createElement(
            "div",
            null,
            label(tr("settings.key")),
            React.createElement(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 } },
              React.createElement("input", {
                type: "password",
                value: keys[p.id] || "",
                placeholder: tr("settings.keyPlaceholder"),
                onChange: (e) => setKeys((k) => ({ ...k, [p.id]: e.target.value })),
                style: {
                  flex: 1,
                  minWidth: 180,
                  background: "var(--euterpe-surface-soft)",
                  border: "1px solid var(--euterpe-divider)",
                  borderRadius: 8,
                  padding: "6px 8px",
                  color: "var(--euterpe-text)",
                  fontFamily: "inherit",
                  fontSize: 12,
                },
              }),
              React.createElement(
                "button",
                { className: "euterpe-btn euterpe-btn-ghost", onClick: () => saveKey(p), disabled: pending === "key" },
                tr("settings.saveKey")
              ),
              p.hasKey
                ? React.createElement(
                    "button",
                    { className: "euterpe-btn euterpe-btn-ghost", onClick: () => removeKey(p), disabled: pending === "key" },
                    tr("settings.removeKey")
                  )
                : null
            )
          )
        : null,
      React.createElement(
        "div",
        { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
        React.createElement(
          "button",
          { className: "euterpe-btn euterpe-btn-ghost", onClick: () => runTest(p), disabled: pending === "test" },
          pending === "test" ? tr("settings.testing") : tr("settings.test")
        ),
        report
          ? React.createElement(
              "span",
              { style: { fontSize: 11, color: report.ok ? "var(--euterpe-accent)" : "var(--euterpe-danger)" } },
              `${report.ok ? "OK" : tr("error.title")} · ${report.text}`
            )
          : null
      )
    );
  };

  const v2 = (on) => (on ? tr("settings.on") : tr("settings.off"));

  const behaviour = () =>
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { style: { marginBottom: 10 } },
        label(tr("settings.mutationPolicy")),
        React.createElement(Select, { value: settings.mutationPolicy, options: MUTATION_POLICIES, onChange: (v) => patch({ mutationPolicy: v }) })
      ),
      React.createElement(
        "div",
        { style: { marginBottom: 10 } },
        label(tr("settings.webSearch")),
        React.createElement(Select, { value: settings.webSearch, options: WEB_SEARCH, onChange: (v) => patch({ webSearch: v }) })
      ),
      React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 } },
        React.createElement(Toggle, {
          checked: settings.suggestions,
          onChange: (v) => patch({ suggestions: v }),
          text: `${tr("settings.suggestions")} (${v2(settings.suggestions)})`,
        }),
        React.createElement(Toggle, {
          checked: settings.autoRouting,
          onChange: (v) => patch({ autoRouting: v }),
          text: `${tr("settings.autoRouting")} (${v2(settings.autoRouting)})`,
        }),
        React.createElement(Toggle, {
          checked: settings.debug,
          onChange: (v) => patch({ debug: v }),
          text: `${tr("settings.debug")} (${v2(settings.debug)})`,
        })
      ),
      React.createElement(
        "div",
        { style: { display: "flex", gap: 20, flexWrap: "wrap" } },
        React.createElement(
          "div",
          null,
          label(tr("settings.chatHistoryTurns")),
          React.createElement(NumberField, { value: settings.chatHistoryTurns, onCommit: (n) => patch({ chatHistoryTurns: n }) })
        ),
        React.createElement(
          "div",
          null,
          label(tr("settings.maxToolSteps")),
          React.createElement(NumberField, { value: settings.maxToolSteps, onCommit: (n) => patch({ maxToolSteps: n }) })
        )
      )
    );

  let body;
  if (error) {
    body = React.createElement(
      "div",
      { style: { fontSize: 12, color: "var(--euterpe-danger)" } },
      tr("settings.unavailable", { url: BASE }),
      React.createElement("div", { style: { marginTop: 4, fontFamily: "ui-monospace, monospace", fontSize: 11 } }, error)
    );
  } else if (!providers || !settings) {
    body = React.createElement("div", { style: { fontSize: 12, color: "var(--euterpe-subtext)" } }, tr("settings.loading"));
  } else if (tab === "mcp") {
    body = React.createElement(McpPanel, { onToast: notify });
  } else {
    body = React.createElement(
      "div",
      null,
      providers.map(providerCard),
      React.createElement("div", { style: { marginTop: 16, marginBottom: 8, fontSize: 13, fontWeight: 700 } }, tr("settings.behaviour")),
      behaviour()
    );
  }

  return React.createElement(
    "div",
    { className: "euterpe-app", style: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.55)", display: "flex", justifyContent: "center", alignItems: "flex-start" } },
    React.createElement(
      "div",
      {
        style: {
          margin: "6vh 12px",
          width: "min(680px, 94vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          background: "var(--euterpe-bg)",
          border: "1px solid var(--euterpe-divider)",
          borderRadius: 16,
          padding: 18,
          boxShadow: "0 20px 50px rgba(0,0,0,.5)",
          scrollbarWidth: "thin",
        },
      },
      React.createElement(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } },
        React.createElement("div", { style: { fontSize: 16, fontWeight: 700, marginRight: "auto" } }, tr("settings.title")),
        tabButton("setup", tr("settings.tabSetup")),
        tabButton("mcp", tr("settings.tabMcp")),
        React.createElement("button", { className: "euterpe-btn euterpe-btn-ghost", onClick: onClose, "aria-label": tr("settings.close") }, "×")
      ),
      body
    )
  );
}
