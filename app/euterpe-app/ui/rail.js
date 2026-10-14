// Rail (coluna esquerda) do shell — BRAND-VOICE.md §12 e protótipo
// `prototype/ui-proposta.html`. Uma coluna só, três conteúdos:
//   chat  → conversas (busca, nova, agrupadas por dia, fechar, perfil próprio)
//   prefs → seções de ajuste (nav com grupos)
//   onb   → passos do primeiro uso
//
// Presentational: não fala com o daemon, não guarda estado de domínio. O
// `EuterpeApp` passa tudo — assim o WS não é remontado quando a view troca.
//
// Apresentação pelo DS: as linhas clicáveis são `ds-item` (hover/active nativos),
// os textos são o `TextComponent` nativo e as cores/espaços saem de token do
// Encore. Nenhum hex aqui.
//
// `React` vem de `Spicetify` (padrão dos outros módulos de UI — sessions.js,
// markdown.js). NÃO use `globalThis.React`: o client não o publica no global.
import { Badge, Button, Divider, Text, COLOR, TEXT } from "./ds.js";
import { InlineIcon, ICON } from "./icons.js";

const { React } = Spicetify;

export function Rail({ mode, tr, conversations, prefs, steps }) {
  const h = React.createElement;

  const railStyle = {
    // `min()` + a media query em injectStyles: em painel estreito o rail não
    // come a área do chat (ele some abaixo do breakpoint).
    width: "min(var(--euterpe-rail-w), 32%)",
    minWidth: 150,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderRight: "1px solid var(--decorative-subdued)",
    background: "var(--background-base)",
    marginRight: "var(--encore-spacing-base, 16px)",
  };
  const headStyle = { padding: "var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter-4, 4px)" };
  const searchStyle = {
    display: "flex",
    alignItems: "center",
    gap: "var(--encore-spacing-tighter-4, 4px)",
    background: "var(--background-tinted-base)",
    border: "1px solid transparent",
    borderRadius: "var(--encore-border-radius-rounded, 500px)",
    padding: "var(--encore-spacing-tighter-4, 4px) var(--encore-spacing-tighter, 12px)",
  };
  const inputStyle = {
    flex: 1,
    minWidth: 0,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-base)",
    fontFamily: "var(--encore-body-font-stack, inherit)",
    fontSize: "var(--encore-text-size-smaller, .8125rem)",
  };
  const captionStyle = {
    fontSize: "var(--encore-text-size-smaller-2, .6875rem)",
    fontWeight: 800,
    letterSpacing: ".6px",
    textTransform: "uppercase",
    color: "var(--text-subdued)",
    padding: "var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter, 12px) var(--encore-spacing-tighter-5, 2px)",
  };
  /** Linha clicável do rail: geometria própria + estados nativos do `ds-item`.
   *  Sem `margin`: o recuo vem do padding do container — margem + `width: 100%`
   *  estourava a largura e abria scroll horizontal no rail. */
  const rowStyle = (active) => ({
    display: "flex",
    alignItems: "center",
    gap: "var(--encore-spacing-tighter-4, 4px)",
    padding: "var(--encore-spacing-tighter-3, 6px) var(--encore-spacing-tighter, 12px)",
    width: "100%",
    fontSize: "var(--encore-text-size-smaller, .8125rem)",
    color: active ? "var(--text-base)" : "var(--text-subdued)",
  });
  /** Container rolável do rail: só vertical. Texto longo quebra com ellipsis em
   *  vez de forçar largura (era o que gerava a barra horizontal). */
  const scrollArea = {
    overflowY: "auto",
    overflowX: "hidden",
    minHeight: 0,
    minWidth: 0,
    padding: "0 var(--encore-spacing-tighter-3, 6px)",
  };
  const ellipsis = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  const Search = ({ placeholder, value, onChange }) =>
    h("div", { style: headStyle }, h("div", { style: searchStyle }, h("span", { style: { color: "var(--text-subdued)" } }, "⌕"), h("input", {
      style: inputStyle,
      placeholder,
      value,
      onChange: (e) => onChange(e.target.value),
      "aria-label": placeholder,
    })));

  /* ---------------- conversas ---------------- */
  const convs = () => {
    const { query = "", conversations: list = [], currentId, onOpen, onClose, onNew, overrideIds } = conversations;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((s) => (s.title || "").toLowerCase().includes(q))
      : list;
    // Agrupa por dia relativo (Hoje / Ontem / Anteriores) — o protótipo agrupa e
    // é o que dá escala quando há dezenas de conversas.
    const day = (s) => {
      const raw = s.updatedAt || s.createdAt;
      if (!raw) return "earlier";
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return "earlier";
      const today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      if (d.getTime() >= midnight) return "today";
      if (d.getTime() >= midnight - 86400000) return "yesterday";
      return "earlier";
    };
    const groups = [
      ["today", tr("rail.today")],
      ["yesterday", tr("rail.yesterday")],
      ["earlier", tr("rail.earlier")],
    ];
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } },
      h(Search, { placeholder: tr("rail.searchConversations"), value: query, onChange: conversations.onQuery }),
      h(
        "div",
        { style: { padding: "var(--encore-spacing-tighter-4, 4px) var(--encore-spacing-tighter-3, 6px)" } },
        h(
          Button,
          { kind: "secondary", style: { width: "100%" }, onClick: onNew, title: tr("rail.newConversation") },
          tr("rail.newConversation"),
        ),
      ),
      h(
        "div",
        { style: { ...scrollArea, paddingBottom: "var(--encore-spacing-tighter, 12px)" } },
        !list.length ? h("div", { style: { ...captionStyle, textTransform: "none", letterSpacing: 0 } }, tr("rail.none")) : null,
        !filtered.length && list.length
          ? h("div", { style: { ...captionStyle, textTransform: "none", letterSpacing: 0 } }, tr("rail.noResults"))
          : null,
        groups.map(([key, label]) => {
          const items = filtered.filter((s) => day(s) === key);
          if (!items.length) return null;
          return h(
            "div",
            { key },
            h("div", { style: captionStyle }, label),
            items.map((s) =>
              h(
                "div",
                {
                  key: s.id,
                  className: "ds-item",
                  "data-active": String(s.id === currentId),
                  style: rowStyle(s.id === currentId),
                  onClick: () => onOpen(s.id),
                  title: s.title,
                },
                h("span", { style: ellipsis }, s.title || "—"),
                overrideIds && overrideIds.has(s.id)
                  ? h(InlineIcon, { name: ICON.profile, size: 11, style: { color: "var(--essential-warning)", flexShrink: 0 } })
                  : null,
                h(
                  "button",
                  {
                    type: "button",
                    className: "euterpe-msg-action",
                    title: tr("action.closeSession"),
                    "aria-label": tr("action.closeSession"),
                    onClick: (e) => {
                      e.stopPropagation();
                      onClose(s.id);
                    },
                  },
                  "×",
                ),
              ),
            ),
          );
        }),
      ),
    );
  };

  /* ---------------- seções de ajuste ---------------- */
  const sections = () => {
    const { query = "", sections: groups = [], activePage, onSelect, onQuery } = prefs;
    const q = query.trim().toLowerCase();
    const visibleGroups = groups
      .map((group) => ({
        ...group,
        items: group.items.filter((it) => !q || it.label.toLowerCase().includes(q)),
      }))
      .filter((group) => group.items.length > 0);

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } },
      h(Search, { placeholder: tr("rail.searchSettings"), value: query, onChange: onQuery }),
      h(
        "div",
        { style: { ...scrollArea, paddingBottom: "var(--encore-spacing-tighter, 12px)" } },
        !visibleGroups.length && groups.length
          ? h("div", { style: { ...captionStyle, textTransform: "none", letterSpacing: 0 } }, tr("rail.noResults"))
          : null,
        visibleGroups.map((group, idx) =>
          h(
            React.Fragment,
            { key: group.label },
            idx > 0
              ? h(Divider, {
                  style: {
                    margin: "var(--encore-spacing-tighter-3, 6px) 0",
                  },
                })
              : null,
            h(
              "div",
              null,
              h("div", { style: captionStyle }, group.label),
              group.items.map((it) =>
                h(
                  "div",
                  {
                    key: it.id,
                    className: "ds-item",
                    "data-active": String(it.id === activePage),
                    style: rowStyle(it.id === activePage),
                    onClick: () => onSelect(it.id),
                  },
                  h("span", { style: ellipsis }, it.label),
                  it.badge ? h(Badge, { tone: group.warn ? "warning" : "neutral", text: it.badge }) : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };

  /* ---------------- passos do primeiro uso ---------------- */
  const stepRail = () => {
    const { activeStep, onSkip, note } = steps;
    const labels = steps.labels || [];
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } },
      h("div", { style: captionStyle }, tr("view.onboarding")),
      h(
        "div",
        { style: { padding: "var(--encore-spacing-tighter-4, 4px) var(--encore-spacing-tighter, 12px)", display: "flex", flexDirection: "column", gap: 2 } },
        labels.map((label, i) =>
          h(
            "div",
            {
              key: label,
              style: {
                display: "flex",
                gap: "var(--encore-spacing-tighter-2, 8px)",
                alignItems: "center",
                padding: "var(--encore-spacing-tighter-3, 6px) var(--encore-spacing-tighter-4, 4px)",
                fontSize: "var(--encore-text-size-smaller, .8125rem)",
              },
            },
            h(
              "span",
              {
                style: {
                  width: 18,
                  height: 18,
                  borderRadius: "var(--encore-border-radius-rounded, 500px)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: "var(--encore-text-size-smaller-3, .5625rem)",
                  fontWeight: 700,
                  flexShrink: 0,
                  background: i <= activeStep ? "var(--essential-bright-accent)" : "var(--background-tinted-base)",
                  color: i <= activeStep ? "#000" : "var(--text-subdued)",
                },
              },
              i < activeStep ? React.createElement(InlineIcon, { name: ICON.check, size: 10, style: { flexShrink: 0 } }) : String(i + 1)
            ),
            h(Text, { variant: TEXT.caption, color: i <= activeStep ? COLOR.base : COLOR.subdued }, label),
          ),
        ),
      ),
      note ? h(Text, { as: "div", variant: TEXT.caption, color: COLOR.subdued, style: { padding: "var(--encore-spacing-tighter, 12px) var(--encore-spacing-tighter, 12px) var(--encore-spacing-tighter-4, 4px)", lineHeight: 1.45 } }, note) : null,
      h(
        "div",
        { style: { marginTop: "auto", padding: "var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter, 12px)", borderTop: "1px solid var(--decorative-subdued)" } },
        h(Button, { kind: "tertiary", onClick: onSkip }, tr("view.chat")),
      ),
    );
  };

  return h(
    "aside",
    { className: "euterpe-rail euterpe-rail-" + mode, style: railStyle },
    mode === "prefs" ? sections() : mode === "onb" ? stepRail() : convs(),
  );
}
