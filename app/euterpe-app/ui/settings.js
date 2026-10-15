// Painel de setup (Fase 6): providers/modelos/chaves + botão "testar" + toggles.
//
// Tudo vem do daemon (GET/PUT /settings, GET /providers, GET /models,
// POST /providers, POST /providers/test, DELETE /providers/:id) — a UI não guarda
// estado de configuração em lugar nenhum: o daemon é a fonte de verdade.
// A chave nunca volta do daemon (só `hasKey`), então o campo nasce vazio e só é
// enviado quando o usuário digita uma nova.
//
// Apresentação: NENHUM componente é desenhado à mão aqui. Tudo sai de `./ds.js`,
// que é a camada copiada da tela de configurações nativa do Spotify (tokens do
// Encore + `Spicetify.ReactComponent`). Regra da casa: se um widget novo for
// preciso, ele nasce em `ds.js` com a declaração nativa citada — nunca um
// `style={{}}` solto com hex inventado.
import { tr } from "../lib/i18n.js";
import { BASE, deleteProvider, eraseStorage, getSettings, getStorage, listModels, listProviders, probe, saveProvider, saveSettings, testProfile, testProvider } from "../lib/daemon.js";
import { McpPanel } from "./mcp-panel.js";
import { Badge, Button, Divider, Hint, IconButton, NumberInput, Panel, Row, SectionTitle, Select, Text, TextArea, TextInput, Toggle, COLOR, TEXT } from "./ds.js";
import { icon, ICON } from "./icons.js";

const { React } = Spicetify;

const MUTATION_POLICIES = ["allow", "confirm", "deny"];
const WEB_SEARCH = ["auto", "searxng", "brave", "tavily", "duckduckgo", "off"];

/** Micro-layouts (só espaçamento por token; nada de cor). */
const inline = (gap = "tighter-2") => ({ display: "flex", alignItems: "center", gap: `var(--encore-spacing-${gap}, 8px)`, flexWrap: "wrap" });
const spaced = { display: "flex", flexDirection: "column", gap: "var(--encore-spacing-base, 16px)" };

/**
 * Seções de Preferências (protótipo, `prototype/ui-proposta.html`).
 *
 * Fonte única: o rail (agrupado, com busca) e o crumb da página consomem isto —
 * assim não existe uma lista no rail e outra no roteador.
 */
export const PREFS_SECTIONS = [
  {
    labelKey: "prefs.groupModels",
    items: [
      { id: "perfis", labelKey: "prefs.profiles" },
      { id: "papeis", labelKey: "prefs.roles" },
      { id: "overrides", labelKey: "prefs.overrides" },
    ],
  },
  {
    labelKey: "prefs.groupProviders",
    items: [
      { id: "credenciais", labelKey: "prefs.pageCredentials" },
      { id: "endpoints", labelKey: "prefs.pageEndpoints" },
    ],
  },
  {
    labelKey: "prefs.groupAgency",
    warn: true,
    items: [
      { id: "mutacao", labelKey: "prefs.pageMutation" },
      { id: "limites", labelKey: "prefs.pageLimits" },
    ],
  },
  {
    labelKey: "prefs.groupChat",
    items: [
      { id: "comportamento", labelKey: "prefs.pageBehaviour" },
      { id: "instrucoes", labelKey: "prefs.instructions" },
    ],
  },
  {
    labelKey: "prefs.groupTools",
    items: [
      { id: "mcp", labelKey: "prefs.mcpEnabled" },
      { id: "busca", labelKey: "prefs.pageSearch" },
    ],
  },
  {
    labelKey: "prefs.groupData",
    items: [
      { id: "armazenamento", labelKey: "prefs.storage" },
      { id: "diagnostico", labelKey: "prefs.diag" },
    ],
  },
];

/** Grupo + rótulo de uma seção, para o crumb `Grupo › Seção`. */
export function prefsCrumb(section) {
  for (const group of PREFS_SECTIONS) {
    const item = group.items.find((i) => i.id === section);
    if (item) return { groupKey: group.labelKey, labelKey: item.labelKey };
  }
  return null;
}

export function SettingsPanel({ onClose, onToast, inline: inlineView, section }) {
  const { useState, useEffect } = React;
  // `section` substitui as antigas abas: a view é roteada pelo rail.
  const active = section || "credenciais";
  const [savedAt, setSavedAt] = useState(null);
  const [providers, setProviders] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [models, setModels] = useState({});
  const [chosen, setChosen] = useState({});
  const [keys, setKeys] = useState({});
  const [busy, setBusy] = useState({});
  const [reports, setReports] = useState({});
  const [meta, setMeta] = useState(null);
  const [storage, setStorage] = useState(null);
  const [latencies, setLatencies] = useState({});
  const [urls, setUrls] = useState({});
  const [names, setNames] = useState({});
  const [addId, setAddId] = useState("");
  const [addedIds, setAddedIds] = useState(() => new Set());

  const notify = (text, level) => {
    if (onToast) onToast(text, level || "info");
  };

  const reload = () =>
    Promise.all([listProviders(), getSettings()])
      .then(([p, s]) => {
        setProviders((p && p.providers) || []);
        setSettings((s && s.settings) || {});
        setMeta(s || null);
        setError(null);
      })
      .catch((err) => setError(err && err.message ? err.message : String(err)));

  useEffect(() => {
    reload();
  }, []);

  // Armazenamento: só leitura, para a página "Armazenamento" mostrar números
  // reais (nada de estimativa).
  useEffect(() => {
    getStorage()
      .then((s) => setStorage(s))
      .catch(() => setStorage(null));
  }, []);

  const patch = (body) =>
    saveSettings(body)
      .then((res) => {
        if (res && res.settings) setSettings(res.settings);
        if (res) setMeta(res);
        // O rodapé mostra "Salvo · há Xs" a partir daqui (dado real: o daemon
        // confirmou a gravação, não é otimismo da UI).
        setSavedAt(Date.now());
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
    const baseUrl = urls[p.id] !== undefined ? urls[p.id] : p.baseUrl;
    setBusy((b) => ({ ...b, [p.id]: "models" }));
    listModels({ provider: p.id, baseUrl })
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
    const baseUrl = urls[p.id] !== undefined ? urls[p.id] : p.baseUrl;
    setBusy((b) => ({ ...b, [p.id]: "test" }));
    setReports((r) => ({ ...r, [p.id]: null }));
    const payload = { provider: p.id, model };
    if (apiKey) payload.apiKey = apiKey;
    if (baseUrl) payload.baseUrl = baseUrl;
    testProvider(payload)
      .then((res) => {
        const report = (res && res.report) || {};
        const parts = [];
        if (report.latencyMs != null) parts.push(tr("settings.latency", { ms: report.latencyMs }));
        if (report.model) parts.push(report.model);
        const text = report.ok ? parts.join(" · ") || "ok" : report.code || report.detail || "failed";
        setReports((r) => ({ ...r, [p.id]: { ok: !!report.ok, text } }));
        if (report.ok && (apiKey || baseUrl)) reload();
      })
      .catch((err) => setReports((r) => ({ ...r, [p.id]: { ok: false, text: err.message } })))
      .finally(() => setBusy((b) => ({ ...b, [p.id]: null })));
  };

  const v2 = (on) => (on ? tr("settings.on") : tr("settings.off"));

  /* ------------ cartão de provider (Credenciais) ------------ */
  const providerCard = (p) => {
    const isActive = settings && settings.activeProvider === p.id;
    const pending = busy[p.id];
    const report = reports[p.id];
    const opts = modelOptions(p);
    const value = chosen[p.id] || (isActive ? settings.activeModel : p.defaultModel) || opts[0] || "";
    const isCustom = p.id === "custom" || p.id.startsWith("custom-") || !["deepseek", "openai", "anthropic", "gemini", "groq", "openrouter", "together", "xai", "mistral", "ollama", "lmstudio", "llama-server"].includes(p.id);

    return React.createElement(
      Panel,
      { key: p.id },
      // Cabeçalho do cartão: identidade + estado + ações.
      React.createElement(
        "div",
        { style: { ...inline("tighter-2"), justifyContent: "space-between", marginBottom: "var(--encore-spacing-tighter-2, 8px)" } },
        React.createElement(
          "div",
          { style: inline("tighter-4") },
          React.createElement(Text, { variant: TEXT.bodyBold }, names[p.id] !== undefined ? names[p.id] : (p.name || p.id)),
          React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, `${p.id} · ${p.kind}`),
          isActive ? React.createElement(Badge, { tone: "accent", text: tr("settings.active") }) : null,
          p.hasKey ? React.createElement(Badge, { text: tr("settings.keySet") }) : p.needsKey ? React.createElement(Badge, { tone: "danger", text: tr("settings.keyMissing") }) : null,
        ),
        React.createElement(
          "div",
          { style: inline("tighter-4") },
          isActive ? null : React.createElement(Button, { kind: "secondary", onClick: () => useProvider(p) }, tr("settings.use")),
          React.createElement(
            Button,
            {
              kind: "tertiary",
              disabled: isActive,
              title: isActive ? tr("prefs.removeProviderActive") : tr("prefs.removeProvider"),
              onClick: () =>
                deleteProvider(p.id)
                  .then(() => {
                    setAddedIds((prev) => {
                      const next = new Set(prev);
                      next.delete(p.id);
                      return next;
                    });
                    return reload();
                  })
                  .then(() => notify(tr("settings.saved")))
                  .catch((err) => notify(err.message, "error")),
            },
            tr("prefs.removeProvider"),
          ),
        ),
      ),
      // Nome de exibição (editável para providers customizados)
      isCustom
        ? React.createElement(Row, {
            label: tr("prefs.customName"),
            control: React.createElement(
              "div",
              { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
              React.createElement(TextInput, {
                value: names[p.id] !== undefined ? names[p.id] : (p.name || p.id),
                placeholder: "ex: llama-server, vLLM, Localhost",
                ariaLabel: tr("prefs.customName"),
                style: { minWidth: 260 },
                onCommit: (v) => {
                  setNames((n) => ({ ...n, [p.id]: v }));
                  saveProvider({ id: p.id, name: v })
                    .then(() => {
                      notify(tr("settings.saved"));
                      return reload();
                    })
                    .catch((err) => notify(err.message, "error"));
                },
              }),
            ),
          })
        : null,
      // Protocolo da API (editável para providers customizados)
      isCustom
        ? React.createElement(Row, {
            label: tr("prefs.customKind"),
            control: React.createElement(
              "div",
              { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
              React.createElement(Select, {
                value: p.kind || "openai-compat",
                options: ["openai-compat", "ollama", "anthropic", "gemini"],
                labels: {
                  "openai-compat": "OpenAI-compatible (llama-server, vLLM, etc.)",
                  "ollama": "Ollama",
                  "anthropic": "Anthropic",
                  "gemini": "Google Gemini",
                },
                ariaLabel: tr("prefs.customKind"),
                style: { minWidth: 260 },
                onSelect: (k) => {
                  saveProvider({ id: p.id, kind: k })
                    .then(() => {
                      notify(tr("settings.saved"));
                      return reload();
                    })
                    .catch((err) => notify(err.message, "error"));
                },
              }),
            ),
          })
        : null,
      // Endpoint URL (baseUrl)
      React.createElement(Row, {
        label: tr("prefs.baseUrl"),
        control: React.createElement(
          "div",
          { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
          React.createElement(TextInput, {
            value: urls[p.id] !== undefined ? urls[p.id] : p.baseUrl || "",
            placeholder: p.id === "llama-server" || isCustom ? "http://127.0.0.1:8080/v1" : p.id === "lmstudio" ? "http://127.0.0.1:1234/v1" : p.id === "ollama" ? "http://127.0.0.1:11434" : "https://api...",
            ariaLabel: tr("prefs.baseUrl"),
            style: { minWidth: 260 },
            onCommit: (v) => {
              setUrls((u) => ({ ...u, [p.id]: v }));
              saveProvider({ id: p.id, baseUrl: v })
                .then(() => {
                  notify(tr("settings.saved"));
                  return reload();
                })
                .catch((err) => notify(err.message, "error"));
            },
          }),
        ),
      }),
      // Modelo: TextInput para digitação direta + Select se houver opções descobertas + Botão Refresh
      React.createElement(Row, {
        label: tr("settings.model"),
        control: React.createElement(
          "div",
          { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
          React.createElement(TextInput, {
            value: value,
            placeholder: "ex: default, llama-3.2, mistral",
            ariaLabel: tr("settings.model"),
            style: { minWidth: 160, maxWidth: 220 },
            onCommit: (m) => {
              selectModel(p, m);
              saveProvider({ id: p.id, defaultModel: m })
                .then(() => reload())
                .catch(() => {});
            },
          }),
          opts.filter((o) => o && o !== "").length > 0
            ? React.createElement(Select, {
                value: value,
                options: opts.filter((o) => o && o !== ""),
                ariaLabel: tr("settings.model"),
                onSelect: (m) => {
                  selectModel(p, m);
                  saveProvider({ id: p.id, defaultModel: m })
                    .then(() => reload())
                    .catch(() => {});
                },
                style: { maxWidth: 160 },
              })
            : null,
          React.createElement(Button, { kind: "secondary", disabled: pending === "models", onClick: () => loadModels(p) }, pending === "models" ? tr("settings.loading") : tr("settings.refreshModels")),
        ),
      }),
      // Chave de API: sempre disponível para custom ou quando needsKey/hasKey/keys
      (isCustom || p.needsKey || p.hasKey || keys[p.id] !== undefined)
        ? React.createElement(Row, {
            label: p.needsKey ? tr("settings.key") : `${tr("settings.key")} (${tr("settings.keyOptional")})`,
            description: !p.needsKey ? tr("settings.keyOptionalHint") : undefined,
            control: React.createElement(
              "div",
              { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
              React.createElement(TextInput, {
                type: "password",
                value: keys[p.id] || "",
                placeholder: tr("settings.keyPlaceholder"),
                ariaLabel: tr("settings.key"),
                style: { minWidth: 180 },
                onCommit: (v) => setKeys((k) => ({ ...k, [p.id]: v })),
              }),
              React.createElement(Button, { kind: "secondary", disabled: pending === "key", onClick: () => saveKey(p) }, tr("settings.saveKey")),
              p.hasKey ? React.createElement(Button, { kind: "tertiary", disabled: pending === "key", onClick: () => removeKey(p) }, tr("settings.removeKey")) : null,
            ),
          })
        : null,
      React.createElement(Row, {
        label: "",
        control: React.createElement(
          "div",
          { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
          React.createElement(Button, { kind: "secondary", disabled: pending === "test", onClick: () => runTest(p) }, pending === "test" ? tr("settings.testing") : tr("settings.test")),
          report ? React.createElement(Badge, { tone: report.ok ? "accent" : "danger", text: `${report.ok ? "OK" : tr("error.title")} · ${report.text}` }) : null,
        ),
      }),
    );
  };

  /* ------------ páginas simples (uma linha nativa cada) ------------ */
  const mutationSection = () =>
    React.createElement(Row, {
      label: tr("settings.mutationPolicy"),
      control: React.createElement(Select, { value: settings.mutationPolicy, options: MUTATION_POLICIES, ariaLabel: tr("settings.mutationPolicy"), onSelect: (v) => patch({ mutationPolicy: v }), style: { maxWidth: 220 } }),
    });

  const searchSection = () =>
    React.createElement(Row, {
      label: tr("settings.webSearch"),
      control: React.createElement(Select, { value: settings.webSearch, options: WEB_SEARCH, ariaLabel: tr("settings.webSearch"), onSelect: (v) => patch({ webSearch: v }), style: { maxWidth: 220 } }),
    });

  const limitsSection = () =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Row, {
        label: tr("settings.chatHistoryTurns"),
        control: React.createElement(NumberInput, { value: settings.chatHistoryTurns, ariaLabel: tr("settings.chatHistoryTurns"), onCommit: (n) => patch({ chatHistoryTurns: n }) }),
      }),
      React.createElement(Row, {
        label: tr("settings.maxToolSteps"),
        control: React.createElement(NumberInput, { value: settings.maxToolSteps, ariaLabel: tr("settings.maxToolSteps"), onCommit: (n) => patch({ maxToolSteps: n }) }),
      }),
    );

  const behaviourSection = () =>
    React.createElement(
      React.Fragment,
      null,
      ...[
        ["settings.suggestions", "suggestions"],
        ["settings.autoRouting", "autoRouting"],
        ["settings.debug", "debug"],
      ].map(([key, field]) =>
        React.createElement(Row, {
          key: field,
          label: tr(key),
          description: v2(settings[field]),
          control: React.createElement(Toggle, { value: settings[field], ariaLabel: tr(key), onSelected: (v) => patch({ [field]: v }) }),
        }),
      ),
    );

  // Endpoints: hoje só o upstream do chat é configurável (o resto vive no
  // provider, na página Credenciais). Nada de campo decorativo.
  const endpointsSection = () =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Row, {
        label: tr("prefs.pageEndpoints"),
        description: `${tr("settings.tabSetup")} · ${BASE}`,
        control: React.createElement(TextInput, {
          value: settings.chatUpstream || "",
          placeholder: "ws://127.0.0.1:8338/ws",
          ariaLabel: tr("prefs.pageEndpoints"),
          style: { maxWidth: 320 },
          onCommit: (v) => patch({ chatUpstream: v }),
        }),
      }),
    );

  /* ---------- páginas do protótipo (Perfis, Papéis, Overrides, Instruções,
     MCP, Armazenamento, Diagnóstico) ---------- */

  const profiles = (settings && settings.profiles) || [];
  const roleProfiles = (settings && settings.roleProfiles) || {};
  const overrides = (settings && settings.sessionOverrides) || {};

  const saveProfiles = (list) => patch({ profiles: list });

  const addProfile = () => {
    const base = providers.find((p) => p.id === settings.activeProvider) || providers[0] || {};
    const id = "p" + Date.now().toString(36);
    saveProfiles(
      profiles.concat([
        {
          id,
          name: tr("prefs.profiles").split(" ")[0] + " " + (profiles.length + 1),
          provider: base.id || settings.activeProvider,
          model: settings.activeModel,
        },
      ])
    );
  };

  const removeProfile = (id) => {
    if (profiles.length <= 1) {
      notify(tr("prefs.onlyProfile"), "error");
      return;
    }
    saveProfiles(profiles.filter((p) => p.id !== id));
  };

  const testOne = (id) => {
    setLatencies((prev) => ({ ...prev, [id]: tr("prefs.testing") }));
    testProfile(id)
      .then((res) => {
        // Latência MEDIDA; sem medida a linha fica em "—".
        setLatencies((prev) => ({ ...prev, [id]: res && res.latencyMs ? res.latencyMs + " ms" : "—" }));
        setSettings((prev) => ({ ...prev, profiles: prev.profiles.map((p) => (p.id === id ? { ...p, latencyMs: (res && res.latencyMs) || null } : p)) }));
      })
      .catch((err) => {
        setLatencies((prev) => ({ ...prev, [id]: "—" }));
        notify(err.message, "error");
      });
  };

  const eraseNow = (scope, what) => {
    eraseStorage(scope)
      .then(() => {
        notify(tr("prefs.erased", { what }));
        return getStorage().then((s) => setStorage(s));
      })
      .catch((err) => notify(err.message, "error"));
  };

  const providerFor = (id) => (providers || []).find((x) => x.id === id) || { id, models: [] };

  const profilesSection = () =>
    React.createElement(
      "div",
      { style: spaced },
      profiles.map((p) => {
        const pObj = providerFor(p.provider);
        const mOpts = modelOptions(pObj);
        const provOpts = (providers || []).map((x) => x.id);
        const provLabels = Object.assign({}, ...(providers || []).map((x) => ({ [x.id]: x.name || x.id })));
        const isActiveProfile = settings.activeProfile === p.id;

        return React.createElement(
          Panel,
          { key: p.id },
          React.createElement(
            "div",
            { style: { ...inline("tighter-2"), justifyContent: "space-between", marginBottom: "var(--encore-spacing-tighter-2, 8px)" } },
            React.createElement(
              "div",
              { style: inline("tighter-4") },
              React.createElement(TextInput, {
                value: p.name,
                ariaLabel: tr("prefs.profiles"),
                style: { width: 160 },
                onCommit: (name) => saveProfiles(profiles.map((x) => (x.id === p.id ? { ...x, name } : x))),
              }),
              isActiveProfile ? React.createElement(Badge, { tone: "accent", text: tr("prefs.active") }) : null,
              React.createElement(
                Text,
                { variant: TEXT.caption, color: COLOR.subdued },
                latencies[p.id] || (p.lastTest ? (p.lastTest.ok ? p.lastTest.latencyMs + " ms" : tr("prefs.lastTestFail")) : tr("prefs.noTest")),
              ),
            ),
            React.createElement(
              "div",
              { style: inline("tighter-4") },
              isActiveProfile ? null : React.createElement(Button, { kind: "secondary", onClick: () => patch({ activeProfile: p.id }) }, tr("prefs.use")),
              React.createElement(Button, { kind: "secondary", onClick: () => testOne(p.id) }, tr("prefs.test")),
              React.createElement(Button, { kind: "tertiary", onClick: () => removeProfile(p.id) }, tr("prefs.remove")),
            ),
          ),
          React.createElement(Row, {
            label: tr("settings.tabSetup"),
            control: React.createElement(
              "div",
              { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
              React.createElement(Select, {
                value: p.provider,
                options: provOpts,
                labels: provLabels,
                ariaLabel: tr("settings.tabSetup"),
                style: { maxWidth: 200 },
                onSelect: (newProv) => {
                  const targetObj = providerFor(newProv);
                  const newModel = targetObj.defaultModel || (targetObj.models && targetObj.models[0]) || "";
                  const updated = profiles.map((x) => (x.id === p.id ? { ...x, provider: newProv, model: newModel } : x));
                  saveProfiles(updated);
                  if (isActiveProfile) patch({ activeProvider: newProv, activeModel: newModel });
                },
              }),
              React.createElement(Select, {
                value: p.model,
                options: mOpts,
                ariaLabel: tr("settings.model"),
                style: { maxWidth: 240 },
                onSelect: (newModel) => {
                  const updated = profiles.map((x) => (x.id === p.id ? { ...x, model: newModel } : x));
                  saveProfiles(updated);
                  if (isActiveProfile) patch({ activeModel: newModel });
                },
              }),
            ),
          }),
          React.createElement(Row, {
            label: tr("prefs.baseUrl"),
            control: React.createElement(
              "div",
              { style: { ...inline("tighter-2"), justifyContent: "flex-end", width: "100%" } },
              React.createElement(TextInput, {
                value: p.baseUrl || "",
                placeholder: pObj.baseUrl || "http://127.0.0.1:8080/v1",
                ariaLabel: tr("prefs.baseUrl"),
                style: { maxWidth: 320 },
                onCommit: (newUrl) => {
                  const val = (newUrl || "").trim() || null;
                  const updated = profiles.map((x) => (x.id === p.id ? { ...x, baseUrl: val } : x));
                  saveProfiles(updated);
                },
              }),
            ),
          }),
        );
      }),
      React.createElement("div", null, React.createElement(Button, { kind: "primary", onClick: addProfile }, tr("prefs.addProfile"))),
    );

  const roleSelect = (role, labelText) =>
    React.createElement(Row, {
      key: role,
      label: labelText,
      control: React.createElement(
        Select,
        {
          value: roleProfiles[role] || "",
          ariaLabel: labelText,
          style: { maxWidth: 220 },
          options: [""].concat(profiles.map((p) => p.id)),
          labels: Object.assign({ "": tr("prefs.roleInherit") }, ...profiles.map((p) => ({ [p.id]: p.name }))),
          onSelect: (value) => {
            const next = Object.assign({}, roleProfiles);
            if (value) next[role] = value;
            else delete next[role];
            patch({ roleProfiles: next });
          },
        },
      ),
    });

  const rolesSection = () =>
    React.createElement(
      React.Fragment,
      null,
      roleSelect("chat", tr("prefs.roleChat")),
      roleSelect("curation", tr("prefs.roleCuration")),
    );

  const overridesSection = () => {
    const ids = Object.keys(overrides);
    return ids.length
      ? React.createElement(
          "div",
          { style: spaced },
          ids.map((sid) =>
            React.createElement(
              "div",
              { key: sid, style: { ...inline("tighter-2"), justifyContent: "space-between" } },
              React.createElement(
                "div",
                { style: { ...inline("tighter-2"), flex: 1, minWidth: 0 } },
                React.createElement(Text, { variant: TEXT.caption, as: "code", style: { overflow: "hidden", textOverflow: "ellipsis" } }, sid),
                React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, (profiles.find((p) => p.id === overrides[sid]) || {}).name || overrides[sid]),
              ),
              React.createElement(
                Button,
                {
                  kind: "tertiary",
                  onClick: () => {
                    const next = Object.assign({}, overrides);
                    delete next[sid];
                    patch({ sessionOverrides: next });
                  },
                },
                tr("prefs.remove"),
              ),
            ),
          ),
        )
      : React.createElement(Hint, null, tr("prefs.overridesNone"));
  };

  const instructionsSection = () =>
    React.createElement(TextArea, {
      value: settings.instructions || "",
      placeholder: tr("prefs.instructionsPlaceholder"),
      ariaLabel: tr("prefs.instructions"),
      rows: 6,
      onCommit: (v) => patch({ instructions: v }),
    });

  const mcpSection = () =>
    React.createElement(
      "div",
      { style: spaced },
      React.createElement(Row, {
        label: tr("prefs.mcpEnabled"),
        description: tr("prefs.mcpEnabledHint"),
        control: React.createElement(Toggle, { value: settings.mcpEnabled !== false, ariaLabel: tr("prefs.mcpEnabled"), onSelected: (v) => patch({ mcpEnabled: v }) }),
      }),
      React.createElement(McpPanel, { onToast: notify, enabled: settings.mcpEnabled !== false }),
    );

  const storageSection = () =>
    React.createElement(
      "div",
      { style: spaced },
      React.createElement(
        "div",
        { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--encore-spacing-tighter-2, 8px)" } },
        ...[
          [tr("prefs.storageDb"), storage ? Math.round(((storage.db && storage.db.bytes) || 0) / 1024) + " KiB · " + ((storage.db && storage.db.rows && storage.db.rows.conversations) || 0) + " msg" : tr("settings.loading")],
          [tr("prefs.storageSessions"), storage ? String((storage.sessions && storage.sessions.files) || 0) : tr("settings.loading")],
          [tr("prefs.storageProbes"), storage ? String((storage.probes && storage.probes.files) || 0) : tr("settings.loading")],
        ].map(([k, v]) =>
          React.createElement(
            "div",
            { key: k },
            React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued, as: "div" }, k),
            React.createElement(Text, { variant: TEXT.body, as: "div" }, v),
          ),
        ),
      ),
      React.createElement(
        "div",
        { style: inline("tighter-2") },
        React.createElement(Button, { kind: "secondary", onClick: () => eraseNow("history", tr("prefs.eraseHistory")) }, tr("prefs.eraseHistory")),
        React.createElement(Button, { kind: "secondary", onClick: () => eraseNow("sessions", tr("prefs.eraseSessions")) }, tr("prefs.eraseSessions")),
        React.createElement(Button, { kind: "secondary", onClick: () => eraseNow("snapshots", tr("prefs.eraseSnapshots")) }, tr("prefs.eraseSnapshots")),
      ),
    );

  const diagSection = () => {
    const rt = (meta && meta.runtime) || {};
    const rows = [
      [tr("prefs.diagVersion"), (meta && meta.version) || "—"],
      [tr("prefs.diagDataDir"), rt.dataDir || "—"],
      [tr("prefs.diagPort"), rt.port == null ? "—" : String(rt.port)],
      [tr("prefs.diagClients"), rt.clients == null ? "—" : String(rt.clients)],
    ];
    return React.createElement(
      "div",
      { style: spaced },
      rows.map(([k, v]) =>
        React.createElement(
          "div",
          { key: k, style: { ...inline("tighter-2"), alignItems: "baseline" } },
          React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued, style: { minWidth: 130 } }, k),
          React.createElement(Text, { variant: TEXT.body, style: { fontFamily: "var(--encore-bodyMono-font-stack, ui-monospace, monospace)", wordBreak: "break-all" } }, v),
        ),
      ),
      React.createElement(
        "div",
        null,
        React.createElement(
          Button,
          {
            kind: "secondary",
            onClick: () =>
              probe()
                .then((res) => {
                  const file = (res && res.body && res.body.file) || (res && res.file) || "probe.json";
                  notify(tr("prefs.probeDone", { file }));
                })
                .catch((err) => notify(err.message, "error")),
          },
          tr("prefs.runProbe"),
        ),
      ),
    );
  };

  const addCustomProvider = () => {
    const id = "custom-" + Date.now().toString(36);
    saveProvider({
      id,
      name: "Custom API",
      kind: "openai-compat",
      baseUrl: "http://127.0.0.1:8080/v1",
      defaultModel: "default",
    })
      .then(() => {
        setAddedIds((prev) => new Set(prev).add(id));
        return reload();
      })
      .then(() => notify(tr("settings.saved")))
      .catch((err) => notify(err.message, "error"));
  };

  // Credenciais: mostramos só o que está EM USO (tem chave, é o ativo, configurado em disco) ou
  // que acabou de ser adicionado para configuração.
  const activeProviderId = (settings && settings.activeProvider) || "";
  const providerList = providers || [];
  const configuredProviders = providerList.filter(
    (p) => p.configured === true || p.hasKey === true || p.id === activeProviderId || addedIds.has(p.id)
  );
  const availableProviders = providerList.filter(
    (p) => !configuredProviders.some((c) => c.id === p.id)
  );

  const credentialsSection = () =>
    React.createElement(
      "div",
      { style: spaced },
      configuredProviders.length
        ? configuredProviders.map(providerCard)
        : React.createElement(Hint, null, tr("prefs.noProviders")),
      React.createElement(
        "div",
        { style: { ...inline("tighter-2"), justifyContent: "flex-end", flexWrap: "wrap", gap: "8px" } },
        React.createElement(
          Button,
          {
            kind: "secondary",
            onClick: addCustomProvider,
          },
          tr("prefs.addCustomProvider"),
        ),
        availableProviders.length
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                Select,
                {
                  value: addId,
                  ariaLabel: tr("prefs.pickProvider"),
                  style: { maxWidth: 220 },
                  options: [""].concat(availableProviders.map((p) => p.id)),
                  labels: Object.assign({ "": tr("prefs.pickProvider") }, ...availableProviders.map((p) => ({ [p.id]: p.name || p.id }))),
                  onSelect: setAddId,
                },
              ),
              React.createElement(
                Button,
                {
                  kind: "primary",
                  disabled: !addId,
                  onClick: () => {
                    const selectedId = addId;
                    saveProvider({ id: selectedId })
                      .then(() => {
                        setAddedIds((prev) => new Set(prev).add(selectedId));
                        return reload();
                      })
                      .then(() => {
                        setAddId("");
                        notify(tr("settings.saved"));
                      })
                      .catch((err) => notify(err.message, "error"));
                  },
                },
                tr("prefs.addProvider"),
              ),
            )
          : null,
      ),
    );

  let body;
  if (error) {
    body = React.createElement(
      "div",
      { className: "ds-banner ds-banner--error" },
      tr("settings.unavailable", { url: BASE }),
      React.createElement(Text, { as: "div", variant: TEXT.caption, style: { fontFamily: "var(--encore-bodyMono-font-stack, ui-monospace, monospace)", marginTop: 4 } }, error),
    );
  } else if (!providers || !settings) {
    body = React.createElement(Text, { color: COLOR.subdued }, tr("settings.loading"));
  } else {
    // Roteador de seções — uma página por vez, como no protótipo (sem abas).
    // Cada página é uma lista de linhas no grid nativo (`ds-row`).
    const PAGES = {
      perfis: profilesSection,
      papeis: rolesSection,
      overrides: overridesSection,
      credenciais: credentialsSection,
      endpoints: endpointsSection,
      mutacao: mutationSection,
      limites: limitsSection,
      comportamento: behaviourSection,
      instrucoes: instructionsSection,
      mcp: mcpSection,
      busca: searchSection,
      armazenamento: storageSection,
      diagnostico: diagSection,
    };
    const render = PAGES[active] || PAGES.credenciais;
    body = React.createElement(
      "div",
      { style: spaced },
      React.createElement(SectionTitle, null, tr(prefsCrumb(active) ? prefsCrumb(active).labelKey : "settings.title")),
      render(),
    );
  }

  // Rodapé "Salvo · há Xs": o carimbo só aparece DEPOIS que o daemon confirmou.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!savedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [savedAt]);
  const elapsed = savedAt ? Math.max(0, Math.round((now - savedAt) / 1000)) : 0;
  const elapsedText = elapsed <= 1 ? tr("prefs.justNow") : tr("prefs.secondsAgo", { n: elapsed });

  const crumb = prefsCrumb(active);
  const crumbText = crumb ? tr(crumb.groupKey) + " › " + tr(crumb.labelKey) : "";
  // "Restaurar seção" só existe onde há um RESET de verdade — nos demais casos o
  // botão não aparece, em vez de fingir que restaura (não conhecemos os defaults
  // da config pelo daemon).
  const RESET = {
    perfis: () => patch({ profiles: [] }),
    papeis: () => patch({ roleProfiles: {} }),
    overrides: () => patch({ sessionOverrides: {} }),
    instrucoes: () => patch({ instructions: "" }),
  };
  const resetFn = RESET[active];

  // Cabeçalho de página: título + trilha, como o `h1` da tela nativa de Settings.
  const header = React.createElement(
    "div",
    { style: { ...inline("tighter-2"), paddingBottom: "var(--encore-spacing-base, 16px)" } },
    React.createElement(Text, { as: "h1", variant: TEXT.title, style: { margin: 0 } }, tr("settings.title")),
    crumbText ? React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, crumbText) : null,
    React.createElement(
      "div",
      { style: { marginLeft: "auto", ...inline("tighter-4") } },
      resetFn
        ? React.createElement(
            Button,
            {
              kind: "secondary",
              onClick: () => {
                resetFn();
                notify(tr("prefs.restored"));
              },
            },
            tr("prefs.restoreSection"),
          )
        : null,
      inlineView ? null : React.createElement(IconButton, { label: tr("settings.close"), onClick: onClose }, icon(ICON.close, 16) || React.createElement("span", null, "✕")),
    ),
  );

  const footer = React.createElement(
    "div",
    { style: { ...inline("tighter-2"), marginTop: "auto", paddingTop: "var(--encore-spacing-tighter-2, 8px)", borderTop: "1px solid var(--decorative-subdued)" } },
    React.createElement("span", { style: { width: 8, height: 8, borderRadius: "50%", background: savedAt ? "var(--essential-bright-accent)" : "var(--text-subdued)" } }),
    React.createElement(Text, { variant: TEXT.caption, color: COLOR.subdued }, savedAt ? tr("prefs.savedAgoTime", { when: elapsedText }) : tr("prefs.sourceOfTruth")),
  );

  if (inlineView) {
    return React.createElement(
      "div",
      { className: "euterpe-app", style: { position: "relative", flex: 1, minWidth: 0, minHeight: 0, height: "100%", display: "flex", flexDirection: "column", background: "transparent", overflow: "hidden" } },
      React.createElement(
        "div",
        { className: "ds-page", style: { flex: 1, minHeight: 0, overflowY: "auto", width: "100%", boxSizing: "border-box" } },
        header,
        React.createElement(Divider, { style: { marginBottom: "var(--encore-spacing-base, 16px)" } }),
        body,
        footer,
      ),
    );
  }

  return React.createElement(
    "div",
    { className: "euterpe-app", style: { position: "fixed", inset: 0, zIndex: "var(--encore-z-index-dialog, 9999)", background: "rgba(0,0,0,.55)", display: "flex", justifyContent: "center", alignItems: "flex-start" } },
    React.createElement(
      "div",
      { className: "ds-card", style: { margin: "6vh 12px", width: "min(680px, 94vw)", maxHeight: "86vh", overflowY: "auto", background: "var(--background-base, #121212)", borderRadius: "var(--encore-corner-radius-larger-2, 8px)", boxShadow: "var(--encore-overlay-box-shadow, 0 20px 50px rgba(0,0,0,.5))" } },
      React.createElement(
        "div",
        { className: "ds-page", style: { display: "flex", flexDirection: "column", gap: "var(--encore-spacing-base, 16px)" } },
        header,
        React.createElement(Divider, { style: { marginBottom: "var(--encore-spacing-base, 16px)" } }),
        body,
        footer,
      ),
    ),
  );
}
