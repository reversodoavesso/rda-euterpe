// Camada DS — componentes "copiados" da tela de configurações NATIVA do Spotify.
//
// Fonte da verdade (lida do client instalado, Spotify 1.3.4.258.gc60b10b0946a):
//   %APPDATA%\Spotify\Apps\xpui\xpui-routes-desktop-settings.js    → estrutura
//   %APPDATA%\Spotify\Apps\xpui\xpui-routes-desktop-settings.css   → declarações
//   %APPDATA%\Spotify\Apps\xpui\xpui-snapshot.css                  → tokens Encore
//   %APPDATA%\Local\spicetify\jsHelper\spicetifyWrapper.js         → o que o spicetify expõe
//
// O que foi copiado de onde:
//   linha de setting   .z7oJkATptNVcFF7p1Ey5  → `ds-row` (grid 2fr/1fr, gap 8px 24px)
//   rótulo+descrição   .vBaJoIm3jlVn2f4rX55w  → `ds-row-label--col`
//   célula do controle .hYBulhw84qf5Y0JaP4Ef  → `ds-row-control`
//   painel             .OHz_B95KwGKYmOBNHxAw → `ds-panel`
//   toggle             .UD4xyfw1t2473YaX2GGP  → `ds-toggle-track` (`Spicetify.ReactComponent.Toggle`)
//   select             .HYu1OCQf_h6Fufkb2mpc  → `ds-select`
//   input numérico     .eOlT6GLRc7WLovDmo0N5  → `ds-number`
//   input de texto     .xRlmHYZxGuqPnl5ttwel  → `ds-input`
//   botão de ícone     .Ko0lJ2Y55KMdy1D9Ja8C  → `ds-icon-btn`
//   item de lista      .prjR_iTGqF382pirm2ml  → `ds-item`
//
// Regras desta camada:
//  1. Texto/toggle/botões vêm de `Spicetify.ReactComponent` — os componentes
//     nativos que o spicetify expõe (contrato conferido no wrapper e no uso que o
//     próprio client faz). Quando o componente não existe na versão instalada, o
//     fallback é o markup nativo copiado (fail-closed: nunca inventa estilo).
//  2. Select/input/textarea/linha/painel NÃO estão em `Spicetify.ReactComponent`;
//     são markup + CSS, exatamente como a tela nativa faz (`<select>` cru + classe).
//     O CSS vive em `chat.js#injectStyles` sob `.euterpe-app .ds-*`.
//  3. Nenhuma cor/espaço/raio hard-coded: só token nativo (`--encore-*`,
//     `--background-*`, `--text-*`, `--essential-*`, `--decorative-*`). Os hex que
//     a tela nativa usa ficam no comentário do CSS, para auditoria.
const { React } = Spicetify;

const h = React.createElement;

/** Resolve `Spicetify.ReactComponent` na hora do render (o wrapper monta depois). */
function rc() {
  return (Spicetify && Spicetify.ReactComponent) || {};
}

/**
 * Um componente React pode ser **função** ou **objeto** (forwardRef/memo).
 * Quase tudo em `Spicetify.ReactComponent` é `forwardRef` — ou seja, OBJETO.
 * Checar só `typeof === "function"` fazia a camada inteira cair no fallback em
 * silêncio (e o fallback ignorava `as`, o que colava rótulo e valor).
 */
function isRenderable(c) {
  return !!c && (typeof c === "function" || typeof c === "object");
}

/** `variant` do `TextComponent` nativo — só os valores que o client usa. */
export const TEXT = {
  hero: "titleLarge",
  title: "titleMedium",
  section: "bodyMediumBold", // títulos de seção em Settings
  subtitle: "titleSmall",
  label: "bodyMedium", // rótulo de linha com controle (par nativo do toggle)
  body: "bodySmall",
  bodyBold: "bodySmallBold",
  caption: "marginal", // descrição de linha
  captionBold: "marginalBold",
  quote: "balladBold",
};

/** `semanticColor` do `TextComponent` nativo. */
export const COLOR = {
  base: "textBase",
  subdued: "textSubdued",
  accent: "textBrightAccent",
  negative: "textNegative",
  warning: "textWarning",
};

/** Tamanhos de botão nativos (`size` em ButtonPrimary/Secondary/Tertiary). */
export const SIZE = { small: "small", medium: "medium", large: "large" };

/**
 * Texto. Componente nativo quando disponível; senão `<span>` com `data-variant`/
 * `data-color` (o CSS `.ds-text[data-*]` reproduz a escala Encore).
 */
export function Text({ variant = TEXT.body, color = COLOR.base, as, className, style, children, ...rest }) {
  const TC = rc().TextComponent;
  if (isRenderable(TC)) {
    return h(TC, { variant, semanticColor: color, as, className, style, ...rest }, children);
  }
  // Fallback: honra `as` (o `as="div"` é o que faz rótulo e valor empilharem).
  return h(as || "span", { className: `ds-text${className ? " " + className : ""}`, "data-variant": variant, "data-color": color, style, ...rest }, children);
}

/**
 * Linha de configuração: rótulo (+ descrição) à esquerda, controle à direita.
 * Espelha `<div data-settings-row class="z7oJkATptNVcFF7p1Ey5">` da tela nativa.
 */
export function Row({ label, description, control, htmlFor, stack, children }) {
  return h(
    "div",
    { className: `ds-row${stack ? " ds-row--stack" : ""}`, "data-settings-row": "true" },
    h(
      "div",
      { className: "ds-row-label ds-row-label--col" },
      label == null ? null : typeof label === "string" ? h(Text, { as: "label", variant: TEXT.label, htmlFor }, label) : label,
      description == null
        ? null
        : typeof description === "string"
          ? h(Text, { as: "label", variant: TEXT.caption, color: COLOR.subdued, htmlFor }, description)
          : description,
    ),
    h("div", { className: "ds-row-control" }, control == null ? children : control),
  );
}

/** Título de seção (nativo: `as="h2" variant="bodyMediumBold"`). */
export function SectionTitle({ children, style }) {
  return h(Text, { as: "h2", variant: TEXT.section, color: COLOR.base, style, children });
}

/** Bloco de texto de apoio. */
export function Hint({ children, style }) {
  return h(Text, { as: "p", variant: TEXT.caption, color: COLOR.subdued, style: { margin: "0 0 8px", lineHeight: 1.5, ...style } }, children);
}

/** Painel (nativo: `--background-highlight` + padding `--encore-spacing-looser`). */
export function Panel({ children, className, style }) {
  return h("div", { className: `ds-panel${className ? " " + className : ""}`, style }, children);
}

/** Separador de 1px (`--decorative-subdued`, como a tela nativa). */
export function Divider({ style }) {
  return h("div", { className: "ds-divider", style });
}

/** Badge/chip de estado. Tons só de token: neutro (tinted) e perigo. */
export function Badge({ text, tone = "neutral", title, style }) {
  return h("span", { className: `ds-badge ds-badge--${tone}`, title, style }, text);
}

/** Botão nativo (`ButtonPrimary`/`Secondary`/`Tertiary`) com fallback copiado. */
export function Button({ kind = "secondary", size = SIZE.small, iconOnly, children, className, style, ...rest }) {
  const C = rc();
  const Native = kind === "primary" ? C.ButtonPrimary : kind === "tertiary" ? C.ButtonTertiary : C.ButtonSecondary;
  if (isRenderable(Native)) return h(Native, { size, iconOnly, className, style, ...rest }, children);
  return h(
    "button",
    { type: "button", className: `ds-btn ds-btn--${kind} ds-btn--${size}${className ? " " + className : ""}`, style, ...rest },
    children,
  );
}

/** Botão só de ícone (nativo: círculo, `scale(1.1)` no hover). */
export function IconButton({ label, children, className, style, ...rest }) {
  const C = rc();
  const TW = C.TooltipWrapper;
  const button = h(
    "button",
    { type: "button", className: `ds-icon-btn${className ? " " + className : ""}`, style, "aria-label": label, ...rest },
    children,
  );
  return isRenderable(TW) ? h(TW, { label, placement: "top" }, button) : button;
}

/** Select da tela nativa (`<select>` cru com a classe nativa; `onSelect(value)`). */
export function Select({ value, options, labels, onSelect, id, disabled, ariaLabel, className, style }) {
  return h(
    "select",
    {
      id,
      className: `ds-select${className ? " " + className : ""}`,
      style,
      value: value == null ? "" : value,
      disabled,
      "aria-label": ariaLabel,
      onChange: (e) => onSelect(e.target.value),
    },
    (options || []).map((opt) => h("option", { key: opt, value: opt }, labels && labels[opt] ? labels[opt] : opt)),
  );
}

//** Campo numérico — persiste no blur/Enter (evita um PUT por tecla). */
export function NumberInput({ value, onCommit, min = 0, width = 64, id, ariaLabel }) {
  const { useState, useEffect } = React;
  const [draft, setDraft] = useState(String(value == null ? "" : value));
  useEffect(() => setDraft(String(value == null ? "" : value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= min && n !== value) onCommit(Math.floor(n));
  };
  return h("input", {
    id,
    className: "ds-number",
    type: "number",
    min,
    "aria-label": ariaLabel,
    value: draft,
    style: { width },
    onChange: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => {
      if (e.key === "Enter") commit();
    },
  });
}

/** Campo de texto — mesma regra de persistência do NumberInput. */
export function TextInput({ value, onCommit, placeholder, width, id, ariaLabel, type = "text", className, style }) {
  const { useState, useEffect } = React;
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  return h("input", {
    id,
    className: `ds-input${className ? " " + className : ""}`,
    type,
    value: draft,
    placeholder,
    "aria-label": ariaLabel,
    style: { width, ...style },
    onChange: (e) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== value) onCommit(draft);
    },
    onKeyDown: (e) => {
      if (e.key === "Enter" && draft !== value) onCommit(draft);
    },
  });
}

/** Área de texto. Grava no blur (não a cada tecla). */
export function TextArea({ value, onCommit, placeholder, rows = 4, id, ariaLabel }) {
  const { useState, useEffect } = React;
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  return h("textarea", {
    id,
    className: "ds-input ds-textarea",
    rows,
    value: draft,
    placeholder,
    "aria-label": ariaLabel,
    onChange: (e) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== (value || "")) onCommit(draft);
    },
  });
}

/** Interruptor nativo. Fallback: markup `.ds-toggle*` copiado da tela nativa. */
export function Toggle({ value, onSelected, disabled, id, ariaLabel, className }) {
  const T = rc().Toggle;
  const handleToggle = (arg) => {
    const checked = arg && arg.target ? arg.target.checked : !!arg;
    if (onSelected) onSelected(checked);
  };
  if (isRenderable(T)) {
    return h(T, { value: !!value, onSelected: handleToggle, onChange: handleToggle, disabled, id, className, ariaLabel });
  }
  return h(
    "label",
    { className: `ds-toggle${className ? " " + className : ""}` },
    h("input", {
      id,
      className: "ds-toggle-input",
      type: "checkbox",
      disabled,
      checked: !!value,
      "aria-label": ariaLabel,
      onChange: (e) => handleToggle(e.target.checked),
    }),
    h("span", { className: "ds-toggle-track" }, h("span", { className: "ds-toggle-knob" })),
  );
}
