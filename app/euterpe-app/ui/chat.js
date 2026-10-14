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
import { copyText, euterpeLogo, renderMarkdown } from "./markdown.js";
import { icon, ICON, InlineIcon } from "./icons.js";
import { useSessions } from "./sessions.js";
import { SettingsPanel, PREFS_SECTIONS } from "./settings.js";
import { Rail } from "./rail.js";
import { ROTATE_MS, thinkingVerb, tip, toolFlavor, TOOL_FLAVOR } from "../lib/voice.js";

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
  /* Euterpe design tokens — aliases da camada semântica do Encore (o DS do
     próprio client: --background-*, --text-*, --essential-*, --decorative-*),
     definida em \`xpui-snapshot.css\` sob \`.encore-dark-theme\`. Fonte primária =
     token nativo; o \`--spice-*\` do spicetify fica só como rede para temas que
     redefinem apenas a camada dele. */
  --euterpe-bg: var(--background-base, var(--spice-main, #121212));
  --euterpe-surface: var(--background-elevated-base, var(--spice-card, #1f1f1f));
  --euterpe-surface-raised: var(--background-elevated-highlight, var(--spice-main-elevated, #2a2a2a));
  --euterpe-text: var(--text-base, var(--spice-text, #ffffff));
  --euterpe-subtext: var(--text-subdued, var(--spice-subtext, #b3b3b3));
  --euterpe-accent: var(--essential-bright-accent, var(--spice-button, #1ed760));
  --euterpe-accent-active: var(--text-bright-accent, var(--spice-button-active, #1ed760));
  --euterpe-on-accent: #000000;
  --euterpe-divider: var(--decorative-subdued, rgba(255,255,255,.1));
  --euterpe-border: var(--essential-subdued, rgba(255,255,255,.25));
  --euterpe-shadow: var(--encore-overlay-box-shadow, 0 4px 12px 0 #0000004d);
  --euterpe-text-muted: var(--text-subdued, rgba(255,255,255,.5));
  --euterpe-text-dim: var(--text-subdued, rgba(255,255,255,.78));
  --euterpe-status: var(--text-subdued, rgba(255,255,255,.55));
  --euterpe-surface-soft: var(--background-tinted-base, rgba(255,255,255,.1));
  --euterpe-btn-bg: var(--background-tinted-highlight, rgba(255,255,255,.14));
  --euterpe-code-bg: var(--background-tinted-highlight, rgba(255,255,255,.14));
  --euterpe-message-bot-bg: var(--background-tinted-base, rgba(255,255,255,.1));
  --euterpe-message-user-bg: color-mix(in srgb, var(--essential-bright-accent) 22%, transparent);
  /* Tints do accent: o Encore não expõe "accent translúcido", então derivamos do
     token com \`color-mix\` (o client já usa color-mix/oklch no próprio CSS). */
  --euterpe-chip-bg: color-mix(in srgb, var(--essential-bright-accent) 16%, transparent);
  --euterpe-chip-border: color-mix(in srgb, var(--essential-bright-accent) 35%, transparent);
  --euterpe-accent-soft: color-mix(in srgb, var(--essential-bright-accent) 20%, transparent);
  --euterpe-accent-soft-2: color-mix(in srgb, var(--essential-bright-accent) 14%, transparent);
  --euterpe-accent-border-strong: color-mix(in srgb, var(--essential-bright-accent) 40%, transparent);
  --euterpe-danger: var(--essential-negative, #f15e6c);
  --euterpe-danger-soft: color-mix(in srgb, var(--essential-negative) 20%, transparent);
  /* Aviso/atenção (escopo fixado, "sem perfil") e métricas do shell. */
  --euterpe-warn: var(--essential-warning, #ffa42b);
  --euterpe-warn-soft: color-mix(in srgb, var(--essential-warning) 16%, transparent);
  --euterpe-warn-border: color-mix(in srgb, var(--essential-warning) 40%, transparent);
  --euterpe-rail-w: 236px;
  --euterpe-nav-w: 208px;
  --euterpe-radius: var(--encore-corner-radius-larger-2, 8px);
}
/* Painel estreito: o rail de CONVERSAS sai de cena em vez de espremer o chat.
   O rail de AJUSTES (prefs) é a navegação da view — esse nunca some, senão a
   tela de Preferências ficaria sem como trocar de seção. */
@media (max-width: 900px) {
  .euterpe-rail-chat { display: none !important; }
}
@media (max-width: 1100px) {
  .euterpe-rail-chat { width: min(var(--euterpe-rail-w), 26%) !important; }
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
}

/* =====================================================================
   Camada DS — componentes copiados da tela de configurações NATIVA.
   Origem: %APPDATA%\\Spotify\\Apps\\xpui\\xpui-routes-desktop-settings.css
   (a classe com hash de origem está no comentário de cada bloco). Cada
   declaração é a nativa; o hex do nativo virou token do Encore — quando o
   hex não tem token equivalente, ele fica e está marcado.
   Tudo escopado em .euterpe-app: o CSS é autocontido (não depende de qual
   chunk de rota o client carregou) e não vaza para o resto do client.
   ===================================================================== */

/* Geometria dos componentes do Encore: tudo é border-box (padding/border não
   somam à largura declarada — sem isso, width: 100% estoura o container). */
.euterpe-app .ds-btn,
.euterpe-app .ds-item,
.euterpe-app .ds-input,
.euterpe-app .ds-select,
.euterpe-app .ds-number,
.euterpe-app .ds-code,
.euterpe-app .ds-panel { box-sizing: border-box; }

/* Página de settings — nativo .eaI8kab5_P8z2G4MpLNF */
.euterpe-app .ds-page {
  display: flex;
  flex-direction: column;
  gap: var(--encore-spacing-looser-2, 24px);
  max-width: 900px;
  margin: 0 auto;
  padding: var(--encore-spacing-looser-3, 32px);
}
/* Linha — nativo .z7oJkATptNVcFF7p1Ey5 (label 2fr / controle 1fr) */
.euterpe-app .ds-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-looser-2, 24px);
}
.euterpe-app .ds-row--stack { grid-template-columns: 1fr; gap: var(--encore-spacing-base, 16px); }
.euterpe-app .ds-row-label { display: flex; align-items: center; gap: var(--encore-spacing-tighter-4, 4px); }
/* nativo .vBaJoIm3jlVn2f4rX55w */
.euterpe-app .ds-row-label--col { align-items: flex-start; flex-direction: column; }
/* nativo .hYBulhw84qf5Y0JaP4Ef */
.euterpe-app .ds-row-control { display: flex; align-items: center; justify-content: flex-end; position: relative; }
/* Painel — nativo .OHz_B95KwGKYmOBNHxAw */
.euterpe-app .ds-panel {
  display: flex;
  flex-direction: column;
  gap: var(--encore-spacing-base, 16px);
  padding: var(--encore-spacing-looser, 20px);
  background-color: var(--background-highlight, #1f1f1f);
  border-radius: var(--encore-spacing-tighter-2, 8px);
}
/* Separador — nativo .Znly1B7531a9qH3m5hNR:before */
.euterpe-app .ds-divider { background-color: var(--decorative-subdued, #292929); block-size: 1px; inline-size: 100%; }

/* Escala de texto do Encore (fallback do TextComponent quando o spicetify não o
   expõe; também vale para os tokens de tipografia dos componentes copiados). */
.euterpe-app .ds-text { color: var(--text-base, #fff); }
.euterpe-app .ds-text[data-color="textSubdued"] { color: var(--text-subdued, #b3b3b3); }
.euterpe-app .ds-text[data-color="textBrightAccent"] { color: var(--text-bright-accent, #1ed760); }
.euterpe-app .ds-text[data-color="textNegative"] { color: var(--text-negative, #f3727f); }
.euterpe-app .ds-text[data-color="textWarning"] { color: var(--text-warning, #ffa42b); }
.euterpe-app .ds-text[data-variant="titleLarge"] { font-size: var(--encore-text-size-larger-2, 1.5rem); font-weight: 700; }
.euterpe-app .ds-text[data-variant="titleMedium"] { font-size: var(--encore-text-size-larger, 1.25rem); font-weight: 700; }
.euterpe-app .ds-text[data-variant="titleSmall"] { font-size: var(--encore-text-size-base, 1rem); font-weight: 700; }
.euterpe-app .ds-text[data-variant="bodyMediumBold"] { font-size: var(--encore-text-size-smaller, .8125rem); font-weight: 700; }
.euterpe-app .ds-text[data-variant="bodyMedium"] { font-size: var(--encore-text-size-smaller, .8125rem); font-weight: 400; }
.euterpe-app .ds-text[data-variant="bodySmall"] { font-size: var(--encore-text-size-smaller, .8125rem); font-weight: 400; }
.euterpe-app .ds-text[data-variant="bodySmallBold"] { font-size: var(--encore-text-size-smaller, .8125rem); font-weight: 700; }
.euterpe-app .ds-text[data-variant="marginal"] { font-size: var(--encore-text-size-smaller-2, .6875rem); font-weight: 400; letter-spacing: .24px; }
.euterpe-app .ds-text[data-variant="marginalBold"] { font-size: var(--encore-text-size-smaller-2, .6875rem); font-weight: 700; }

/* Toggle — nativo .cmooBkNUnL3kDryS9pkl / .UD4xyfw1t2473YaX2GGP / .mQCNH1EgZXIvKeJzLs5t
   (o Spicetify.ReactComponent.Toggle traz o proprio CSS; este bloco existe para o
   fallback e para o caso de o componente nao estar exposto.) */
.euterpe-app .ds-toggle { display: inline-flex; align-items: center; position: relative; }
.euterpe-app .ds-toggle:focus-within { outline: var(--encore-focus-outline-width, 3px) auto var(--encore-focus-outline-color, #ed2c3f); outline-offset: var(--encore-focus-outline-offset, -2px); }
.euterpe-app .ds-toggle-input { opacity: 0; pointer-events: none; position: absolute; }
/* nativo: #535353 (off) / #1db954 (on) / #b3b3b3 + #1ed760 (hover) */
.euterpe-app .ds-toggle-track {
  background-color: var(--essential-subdued, #7c7c7c);
  border-radius: var(--encore-border-radius-rounded, 500px);
  width: 42px;
  height: 24px;
  position: relative;
  transition: background-color .1s;
}
.euterpe-app .ds-toggle-knob {
  border-radius: inherit;
  background: var(--text-base, #fff);
  width: 20px;
  height: 20px;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: background-color .1s, left .1s, right .1s, width .1s;
}
.euterpe-app .ds-toggle:hover .ds-toggle-input:not(:disabled):not(:active) ~ .ds-toggle-track { background-color: var(--text-subdued, #b3b3b3); }
.euterpe-app .ds-toggle-input:checked ~ .ds-toggle-track { background-color: var(--essential-bright-accent, #1ed760); }
.euterpe-app .ds-toggle-input:checked:hover:not(:disabled):not(:active) ~ .ds-toggle-track { background-color: var(--text-bright-accent, #1ed760); }
.euterpe-app .ds-toggle-input:checked ~ .ds-toggle-track .ds-toggle-knob { left: auto; right: 2px; }
.euterpe-app .ds-toggle-input:disabled ~ .ds-toggle-track { opacity: var(--encore-opacity-disabled, .4); cursor: not-allowed; }

/* Select — nativo .HYu1OCQf_h6Fufkb2mpc (é um <select> cru, como na tela nativa) */
.euterpe-app .ds-select {
  letter-spacing: .24px;
  color: var(--text-subdued, #b3b3b3);
  cursor: pointer;
  background-color: var(--background-elevated-base, #1f1f1f);
  border: 0;
  border-inline-end: 12px solid transparent;
  border-radius: var(--encore-corner-radius-base, 4px);
  width: 100%;
  height: 32px;
  padding-inline: var(--encore-spacing-tighter, 12px) var(--encore-spacing-looser, 20px);
  font-family: var(--encore-body-font-stack, inherit);
  font-size: 14px;
  font-weight: 400;
  line-height: 20px;
}
.euterpe-app .ds-select:hover { background-color: var(--background-elevated-highlight, #2a2a2a); color: var(--text-base, #fff); }
.euterpe-app .ds-select:disabled { cursor: not-allowed; color: var(--essential-subdued, #7c7c7c); }
.euterpe-app .ds-select:disabled:hover { background-color: var(--background-elevated-base, #1f1f1f); color: var(--essential-subdued, #7c7c7c); }

/* Input de número — nativo .eOlT6GLRc7WLovDmo0N5 (42x32, centrado) */
.euterpe-app .ds-number {
  height: 32px;
  min-width: 42px;
  text-align: center;
  color: var(--text-base, #fff);
  background-color: var(--background-tinted-base, #ffffff1a);
  border: 1px solid transparent;
  border-radius: var(--encore-corner-radius-base, 4px);
  font-family: inherit;
  font-size: 14px;
}
/* Input de texto — nativo .xRlmHYZxGuqPnl5ttwel (h40, radius 4) */
.euterpe-app .ds-input {
  color: var(--text-base, #fff);
  background-color: var(--background-tinted-base, #ffffff1a);
  border: 1px solid transparent;
  border-radius: var(--encore-corner-radius-base, 4px);
  width: 100%;
  height: 40px;
  padding: 0 var(--encore-spacing-tighter, 12px);
  font-family: inherit;
  font-size: 14px;
}
.euterpe-app .ds-input::placeholder { color: var(--text-subdued, #b3b3b3); }
.euterpe-app .ds-input:hover { background-color: var(--background-tinted-highlight, #ffffff24); }
.euterpe-app .ds-input:focus,
.euterpe-app .ds-select:focus,
.euterpe-app .ds-number:focus { outline: var(--encore-focus-outline-width, 3px) auto var(--encore-focus-outline-color, #ed2c3f); outline-offset: var(--encore-focus-outline-offset, -2px); }
.euterpe-app .ds-textarea { height: auto; min-height: 96px; padding: var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter, 12px); resize: vertical; line-height: 1.5; }
/* Snippet de terminal (código copiável) — nativo usa o mesmo --background-tinted. */
.euterpe-app .ds-code {
  margin: 0;
  padding: var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter, 12px);
  background-color: var(--background-tinted-base, #ffffff1a);
  border-radius: var(--encore-corner-radius-base, 4px);
  font-family: var(--encore-bodyMono-font-stack, ui-monospace, monospace);
  font-size: var(--encore-text-size-smaller-2, .6875rem);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-base, #fff);
}
/* Botão "copiar" ancorado no canto do snippet. Fica DEPOIS das regras de botão
   para vencer o position: relative do .ds-btn na mesma especificidade. */

/* Botões — nativo .e-10860-legacy-button / -primary / -secondary / -tertiary.
   (O prefixo de versão do Encore é substituído pela nossa classe .ds-btn.) */
.euterpe-app .ds-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--encore-spacing-tighter-4, 4px);
  margin: 0;
  border: 0;
  background-color: transparent;
  border-radius: var(--encore-border-radius-rounded, 500px);
  color: var(--text-base, #fff);
  font-family: var(--encore-body-font-stack, inherit);
  font-size: var(--encore-text-size-smaller, .8125rem);
  font-weight: 700;
  line-height: 1;
  text-align: center;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  position: relative;
  will-change: transform;
  transition-duration: var(--encore-shortest-3, 90ms);
  transition-timing-function: var(--encore-productive, cubic-bezier(.3,0,0,1));
  transition-property: background-color, border-color, color, transform, opacity;
}
.euterpe-app .ds-btn:hover:not(:disabled) { transform: scale(var(--encore-button-hover-scale, 1.04)); }
.euterpe-app .ds-btn:active:not(:disabled) { transform: scale(1); }
.euterpe-app .ds-btn:disabled { opacity: var(--encore-opacity-disabled, .5); cursor: not-allowed; transform: scale(1); }
.euterpe-app .ds-btn:focus-visible { outline: var(--encore-focus-outline-width, 3px) auto var(--encore-focus-outline-color, #ed2c3f); outline-offset: var(--encore-focus-outline-offset, -2px); }
/* tamanhos — nativo .legacy-button--small / --medium / --large */
.euterpe-app .ds-btn--small { padding: var(--encore-spacing-tighter-4, 4px) var(--encore-spacing-base, 16px); min-block-size: var(--encore-control-size-smaller, 32px); }
.euterpe-app .ds-btn--medium { padding: var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-looser-2, 24px); min-block-size: var(--encore-control-size-base, 48px); }
.euterpe-app .ds-btn--large { padding: var(--encore-spacing-tighter, 12px) var(--encore-spacing-looser-3, 32px); min-block-size: var(--encore-control-size-larger, 56px); font-size: var(--encore-text-size-base, 1rem); }
/* variantes */
.euterpe-app .ds-btn--primary { background-color: var(--essential-bright-accent, #1ed760); color: #000; }
.euterpe-app .ds-btn--primary:hover:not(:disabled) { background-color: var(--text-bright-accent, #1ed760); }
.euterpe-app .ds-btn--primary:active:not(:disabled) { background-color: var(--background-press, #000); color: var(--text-base, #fff); }
.euterpe-app .ds-btn--secondary { background-color: transparent; border: var(--encore-border-width-hairline, 1px) solid var(--essential-subdued, #7c7c7c); }
.euterpe-app .ds-btn--secondary:hover:not(:disabled) { border-color: var(--essential-base, #fff); }
.euterpe-app .ds-btn--secondary:active:not(:disabled) { border-color: var(--essential-subdued, #7c7c7c); opacity: var(--encore-opacity-active, .7); }
.euterpe-app .ds-btn--tertiary { color: var(--text-subdued, #b3b3b3); }
.euterpe-app .ds-btn--tertiary:hover:not(:disabled) { color: var(--text-base, #fff); }
.euterpe-app .ds-btn--tertiary:active:not(:disabled) { opacity: var(--encore-opacity-active, .7); }
.euterpe-app .ds-btn--danger { background-color: var(--essential-negative, #ed2c3f); color: #000; }

/* Botão de ícone — nativo .Ko0lJ2Y55KMdy1D9Ja8C */
.euterpe-app .ds-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--encore-spacing-tighter-2, 8px);
  background-color: transparent;
  border: 0;
  border-radius: 50%;
  color: var(--text-base, #fff);
  cursor: pointer;
}
.euterpe-app .ds-icon-btn:hover,
.euterpe-app .ds-icon-btn:focus,
.euterpe-app .ds-icon-btn:active { transform: scale(1.1); }

/* Item de lista clicável — nativo .prjR_iTGqF382pirm2ml (hover #ffffff1a, active press) */
.euterpe-app .ds-item {
  background: 0 0;
  border: none;
  border-radius: var(--encore-corner-radius-larger, 6px);
  width: 100%;
  padding: 0;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}
.euterpe-app .ds-item:hover,
.euterpe-app .ds-item:focus-visible { background-color: var(--background-tinted-base, #ffffff1a); }
.euterpe-app .ds-item:active { background-color: var(--background-elevated-press, #191919); }
.euterpe-app .ds-item[data-active="true"] { background-color: var(--background-tinted-highlight, #ffffff24); }

/* Badge — mesma geometria do badge nativo; cor totalmente por token. */
.euterpe-app .ds-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--encore-spacing-tighter-4, 4px);
  padding: 0 var(--encore-spacing-tighter-2, 8px);
  border-radius: var(--encore-corner-radius-smaller, 2px);
  font-size: var(--encore-text-size-smaller-2, .6875rem);
  font-weight: 700;
  letter-spacing: .2px;
  white-space: nowrap;
  text-transform: uppercase;
}
.euterpe-app .ds-badge--neutral { background-color: var(--background-tinted-highlight, #ffffff24); color: var(--text-base, #fff); }
.euterpe-app .ds-badge--accent { background-color: var(--essential-bright-accent, #1ed760); color: #000; }
.euterpe-app .ds-badge--danger { background-color: var(--essential-negative, #ed2c3f); color: #000; }
.euterpe-app .ds-badge--warning { background-color: var(--essential-warning, #ffa42b); color: #000; }

/* Faixa de aviso/erro — nativo .pbUCYjfrxYPcoHiO29W3 / .Yr9KNwq8wcBEv1GfmvBG */
.euterpe-app .ds-banner {
  color: #fff;
  background: var(--essential-announcement, #1278f2);
  border-radius: var(--encore-corner-radius-base, 4px);
  padding: var(--encore-spacing-tighter-2, 8px) var(--encore-spacing-tighter, 12px);
  font-size: var(--encore-text-size-smaller, .8125rem);
}
.euterpe-app .ds-banner--error { background-color: var(--essential-negative, #ed2c3f); }

/* Botão "copiar" do snippet (ver comentário acima: precisa vir por último). */
.euterpe-app .ds-snippet-copy { position: absolute; top: var(--encore-spacing-tighter-4, 4px); right: var(--encore-spacing-tighter-4, 4px); }`;
    document.head.appendChild(s);
  } catch (err) {
    // O <style> é best-effort. Sem log, uma falha aqui deixa a UI inteira sem a
    // camada DS em silêncio (foi o que aconteceu com um template quebrado).
    console.warn("[euterpe] injectStyles falhou:", err);
  }
}

/* ---------- helpers locais ---------- */

function ToolCard({ card }) {
  const running = card.endedAt == null;
  const ms = (card.endedAt || Date.now()) - card.startedAt;
  const status = running ? tr("tool.running") : tr("tool.ok");
  const dot = running ? "var(--euterpe-accent)" : "var(--euterpe-text-muted)";
  // Sabor por ferramenta (BRAND-VOICE.md §6): quando o `chat.status` traz o nome
  // CRU da tool (snake_case), o rótulo principal vira a linha de sabor e o nome
  // técnico continua visível ao lado — ele já salvou um diagnóstico neste repo
  // (duration_ms: 0 em cartão "falho" que nunca rodou).
  const raw = String(card.name || "");
  const canFlavor = Boolean(TOOL_FLAVOR[raw]) || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(raw);
  const label = canFlavor ? toolFlavor(raw) : raw || tr("status.thinking");
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
      React.createElement("span", { style: { fontWeight: 600, color: "var(--euterpe-text)" } }, label),
      canFlavor
        ? React.createElement("span", { style: { color: "var(--euterpe-text-muted)", fontSize: 10.5 } }, raw)
        : null,
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
  const [providers, setProviders] = useState([]);
  const [activeProvider, setActiveProvider] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [modelList, setModelList] = useState([]);
  // Voz (registro de Espera): o verbo é sorteado QUANDO a espera começa e gira
  // por um intervalo — nunca dentro do render, senão o texto pisca a cada
  // re-render (armadilha documentada no BRAND-VOICE.md §12.10).
  const [activeVerb, setActiveVerb] = useState("");
  const [activeTip, setActiveTip] = useState("");
  const verbRef = useRef("");
  // --- shell: views, rail e chip de perfil ---
  const [view, setView] = useState("chat");
  const [railOpen, setRailOpen] = useState(true);
  const [railQuery, setRailQuery] = useState("");
  const [popOpen, setPopOpen] = useState(false);
  const [prefsSection, setPrefsSection] = useState("perfis");
  const [prefsQuery, setPrefsQuery] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState("");
  const [roleProfiles, setRoleProfiles] = useState({});
  const [sessionOverrides, setSessionOverrides] = useState({});

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
        setProfiles(act.profiles || []);
        setActiveProfile(act.activeProfile || "");
        setRoleProfiles(act.roleProfiles || {});
        setSessionOverrides(act.sessionOverrides || {});
      })
      .catch((err) => toast(err.message, "error"));
  };

  useEffect(() => {
    refreshProviders();
  }, []);

  /* ---------- perfis (B): o chip mostra o PERFIL, não o par solto ---------- */

  const profileById = (id) => profiles.find((p) => p.id === id) || null;
  const currentProfile = profileById(activeProfile) || profiles[0] || null;
  const sessionProfileId = (sessionId) => {
    if (sessionId && sessionOverrides[sessionId]) return sessionOverrides[sessionId];
    if (roleProfiles.chat) return roleProfiles.chat;
    return activeProfile;
  };
  const isPinned = !!(currentId && sessionOverrides[currentId]);
  const overrideIds = new Set(Object.keys(sessionOverrides));
  const hasKey = providers.some((p) => p && p.hasKey);

  const applyProfile = (id, pin) => {
    if (pin) {
      const next = { ...sessionOverrides };
      if (id) next[currentId] = id;
      else delete next[currentId];
      setSessionOverrides(next);
      saveSettings({ sessionOverrides: next }).catch((err) => toast(err.message, "error"));
      toast(id ? tr("profile.pinned", { name: (profileById(id) || {}).name || id }) : tr("profile.unpinned"));
      return;
    }
    setActiveProfile(id);
    saveSettings({ activeProfile: id })
      .then(() => refreshProviders())
      .catch((err) => toast(err.message, "error"));
    toast(tr("profile.applied", { name: (profileById(id) || {}).name || id }));
  };

  const togglePin = () => {
    if (!currentId) return;
    if (isPinned) applyProfile(null, true);
    else applyProfile(sessionProfileId(currentId), true);
  };

  // Fecha o popover ao clicar fora (o chip faz stopPropagation).
  useEffect(() => {
    if (!popOpen) return undefined;
    const close = () => setPopOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [popOpen]);

  /* ---------- voz: espera rotativa (BRAND-VOICE.md §5) ---------- */

  const working = streaming || tools.some((t) => t.endedAt == null);

  useEffect(() => {
    if (!working) {
      setActiveVerb("");
      setActiveTip("");
      verbRef.current = "";
      return undefined;
    }
    verbRef.current = thinkingVerb(verbRef.current);
    setActiveVerb(verbRef.current);
    const rotate = setInterval(() => {
      verbRef.current = thinkingVerb(verbRef.current);
      setActiveVerb(verbRef.current);
    }, ROTATE_MS);
    // A dica só entra depois de alguns segundos: tarefa curta nunca vê dica.
    const tipTimer = setTimeout(() => setActiveTip(tip()), 5000);
    return () => {
      clearInterval(rotate);
      clearTimeout(tipTimer);
    };
  }, [working]);

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
    position: "relative",
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
    // Em painel estreito o bloco de ações desce para a segunda linha em vez de
    // estourar a largura (era `flexShrink: 0` — o chip saía da tela).
    flexWrap: "wrap",
    rowGap: "8px",
  };
  const brandStyle = {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    minWidth: 0,
    flex: "1 1 auto",
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
  const chipStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 260,
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden",
    whiteSpace: "nowrap",
    border: "1px solid var(--euterpe-chip-border)",
    background: "var(--euterpe-chip-bg)",
    borderRadius: 500,
  };
  const viewTabsStyle = {
    display: "inline-flex",
    border: "1px solid var(--euterpe-divider)",
    borderRadius: 8,
    overflow: "hidden",
    background: "var(--euterpe-surface-soft)",
    marginLeft: 8,
    flexShrink: 0,
  };
  const viewTabStyle = (active) => ({
    background: active ? "var(--euterpe-accent-soft)" : "transparent",
    border: "none",
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    color: active ? "var(--euterpe-text)" : "var(--euterpe-subtext)",
    cursor: "pointer",
    fontFamily: "inherit",
  });
  const popStyle = {
    position: "absolute",
    top: 56,
    right: 12,
    zIndex: 60,
    width: 320,
    background: "var(--euterpe-surface-raised)",
    border: "1px solid var(--euterpe-divider)",
    borderRadius: 10,
    boxShadow: "var(--euterpe-shadow)",
    padding: 8,
  };
  const popTitleStyle = {
    fontSize: 10.5,
    fontWeight: 800,
    letterSpacing: ".6px",
    textTransform: "uppercase",
    color: "var(--euterpe-text-muted)",
    padding: "2px 6px 6px",
  };
  const popItemStyle = (on) => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 8px",
    borderRadius: 8,
    cursor: "pointer",
    background: on ? "var(--euterpe-accent-soft)" : "transparent",
  });
  const railToggleStyle = {
    background: "transparent",
    border: "1px solid var(--euterpe-divider)",
    borderRadius: 6,
    color: "var(--euterpe-subtext)",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1,
    padding: "4px 6px",
    flexShrink: 0,
  };
  // Badge de escopo do composer: diz de quem é o ajuste (global ou só desta
  // conversa) — protótipo, item 4 de "o que mudou vs hoje".
  const scopeBadgeStyle = (pinned) => ({
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10.5,
    color: pinned ? "var(--euterpe-warn)" : "var(--euterpe-text-muted)",
    lineHeight: 1.2,
  });
  const linkStyle = {
    background: "none",
    border: "none",
    color: "var(--euterpe-accent)",
    cursor: "pointer",
    fontSize: 10.5,
    padding: 0,
    fontFamily: "inherit",
    textDecoration: "underline",
  };
  const headerActionsStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    // Encolhe e quebra linha; `flexShrink: 0` aqui empurrava o chip para fora da
    // área visível em painéis estreitos.
    flexShrink: 1,
    minWidth: 0,
    flexWrap: "wrap",
    justifyContent: "flex-end",
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

  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
    return -1;
  })();

  const prefsPanel = view === "prefs" || view === "onb"
    ? React.createElement(SettingsPanel, { inline: true, section: view === "onb" ? "credenciais" : prefsSection, onClose: () => setView("chat"), onToast: toast })
    : null;

  const toastsPanel = toasts.length
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
    : null;

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
          "button",
          {
            style: railToggleStyle,
            onClick: () => setRailOpen((v) => !v),
            title: tr("rail.toggle"),
            "aria-label": tr("rail.toggle"),
          },
          railOpen ? React.createElement(InlineIcon, { name: ICON.collapse, size: 14 }) : React.createElement(InlineIcon, { name: ICON.expand, size: 14 }),
        ),
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
          // Navegação por views: a área troca de conteúdo, nada abre por cima.
          React.createElement(
            "div",
            { style: viewTabsStyle },
            [
              ["chat", tr("view.chat")],
              ["prefs", tr("view.prefs")],
              ...(!hasKey ? [["onb", tr("view.onboarding")]] : []),
            ].map(([id, label]) =>
              React.createElement(
                "button",
                { key: id, style: viewTabStyle(view === id), onClick: () => setView(id) },
                label
              )
            )
          ),
          // UM controle de modelo: o chip de perfil (substitui os dois selects).
          React.createElement(
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              style: chipStyle,
              onClick: (e) => {
                e.stopPropagation();
                if (!hasKey) {
                  setView("onb");
                  return;
                }
                setPopOpen((v) => !v);
              },
              title: tr("profile.available"),
            },
            currentProfile
              ? [
                  React.createElement(InlineIcon, { key: "bolt", name: ICON.profile, size: 14, style: { color: "var(--euterpe-warn)", flexShrink: 0 } }),
                  React.createElement("span", { key: "name", style: { fontWeight: 700 } }, currentProfile.name),
                  React.createElement(
                    "span",
                    { key: "mid", style: { color: "var(--euterpe-subtext)", fontSize: 11 } },
                    `${currentProfile.provider}/${currentProfile.model}`
                  ),
                  isPinned ? React.createElement(InlineIcon, { key: "pin", name: ICON.pinned, size: 12, style: { color: "var(--euterpe-warn)", flexShrink: 0 } }) : null,
                  React.createElement(InlineIcon, { key: "caret", name: ICON.chevronRight, size: 10, style: { flexShrink: 0, transform: popOpen ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform .15s ease" } }),
                ]
              : [tr("profile.none"), React.createElement(InlineIcon, { key: "caret", name: ICON.chevronRight, size: 10, style: { flexShrink: 0, transform: popOpen ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform .15s ease" } })]
          ),
          React.createElement(
            "button",
            {
              className: "euterpe-btn euterpe-btn-ghost",
              onClick: clear,
              title: tr("action.clearTitle"),
              "aria-label": tr("action.clear"),
            },
            // `x` existe no icon set do client (77 ícones). O fallback textual
            // existe porque `nativeIcon` devolve null para nome inexistente —
            // foi assim que este botão ficou invisível com "ban".
            icon(ICON.close, 14) || React.createElement("span", null, "✕")
          )
        )
      ),
      // Popover de perfis: ancorado no chip, não é modal.
      popOpen && currentProfile
        ? React.createElement(
            "div",
            { style: popStyle, onClick: (e) => e.stopPropagation() },
            React.createElement("div", { style: popTitleStyle }, tr("profile.available")),
            profiles.map((p) =>
              React.createElement(
                "div",
                { key: p.id, style: popItemStyle(p.id === activeProfile), onClick: () => applyProfile(p.id, false) },
                React.createElement(
                  "div",
                  { style: { flex: 1, minWidth: 0 } },
                  React.createElement(
                    "div",
                    { style: { fontSize: 12.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 } },
                    React.createElement(InlineIcon, { name: ICON.profile, size: 14, style: { color: "var(--euterpe-warn)", flexShrink: 0 } }),
                    p.name + (p.role === "curation" ? " · " + tr("profile.roleCuration") : "")
                  ),
                  React.createElement("div", { style: { fontSize: 11, color: "var(--euterpe-subtext)" } }, `${p.provider} · ${p.model}`)
                ),
                // Latência MEDIDA no último teste; "—" enquanto não houver.
                React.createElement(
                  "span",
                  { style: { fontSize: 10.5, color: "var(--euterpe-text-muted)" } },
                  p.latencyMs ? `${p.latencyMs} ms` : "—"
                ),
                p.id === activeProfile ? React.createElement(InlineIcon, { key: "k", name: ICON.check, size: 12, style: { color: "var(--euterpe-accent)", flexShrink: 0 } }) : null
              )
            ),
            React.createElement("div", { style: { height: 1, background: "var(--euterpe-divider)", margin: "6px 4px" } }),
            React.createElement(
              "div",
              {
                style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 6px", cursor: "pointer" },
                onClick: togglePin,
              },
              React.createElement(InlineIcon, { name: ICON.pinned, size: 14, style: { color: isPinned ? "var(--euterpe-warn)" : "var(--euterpe-text-muted)", flexShrink: 0 } }),
              React.createElement(
                "div",
                null,
                React.createElement("div", { style: { fontSize: 12, fontWeight: 700 } }, tr("profile.fix")),
                React.createElement(
                  "div",
                  { style: { fontSize: 10.5, color: "var(--euterpe-text-muted)", lineHeight: 1.35 } },
                  tr("profile.fixHint")
                )
              )
            ),
            React.createElement("div", { style: { height: 1, background: "var(--euterpe-divider)", margin: "6px 4px" } }),
            React.createElement(
              "button",
              {
                style: { background: "none", border: "none", color: "var(--euterpe-accent)", cursor: "pointer", fontSize: 11.5, padding: "2px 8px", fontFamily: "inherit" },
                onClick: () => {
                  setPopOpen(false);
                  setView("prefs");
                },
              },
              tr("profile.manage")
            )
          )
        : null
    ),
    // Rail + conteúdo: a coluna esquerda substitui a faixa de abas de conversa.
    // O pane do chat fica OCULTO quando outra view está ativa, mas continua
    // MONTADO — desmontá-lo derrubaria o WebSocket e perderia a resposta em voo.
    React.createElement(
      "div",
      { style: { display: "flex", flex: 1, minHeight: 0, minWidth: 0 } },
      railOpen
        ? view === "chat"
          ? React.createElement(Rail, {
              mode: "chat",
              tr,
              conversations: {
                query: railQuery,
                onQuery: setRailQuery,
                conversations: sessions,
                currentId,
                overrideIds,
                onOpen: (id) => {
                  setSuggestions([]);
                  setTools([]);
                  openSession(id);
                },
                onClose: (id) => {
                  // Fechar a conversa ativa troca a thread: os chips da anterior
                  // não podem vazar para a próxima.
                  if (id === currentId) setSuggestions([]);
                  closeSession(id);
                },
                onNew: () => {
                  setSuggestions([]);
                  setTools([]);
                  newSession();
                },
              },
            })
          : view === "onb"
            ? React.createElement(Rail, {
                mode: "onb",
                tr,
                steps: {
                  activeStep: 0,
                  labels: [
                    tr("onb.step1"),
                    tr("onb.step2"),
                    tr("onb.step3"),
                  ],
                  note: tr("onb.note"),
                  onSkip: () => setView("chat"),
                },
              })
            : React.createElement(Rail, {
                mode: "prefs",
                tr,
                prefs: {
                  query: prefsQuery,
                  onQuery: setPrefsQuery,
                  activePage: prefsSection,
                  onSelect: setPrefsSection,
                  // Fonte única das seções: o mesmo PREFS_SECTIONS que o roteador
                  // do painel usa (sem lista duplicada que possa divergir).
                  sections: PREFS_SECTIONS.map((group) => ({
                    label: tr(group.labelKey),
                    warn: group.warn,
                    items: group.items.map((item) => ({ id: item.id, label: tr(item.labelKey) })),
                  })),
                },
              })
        : null,
      React.createElement(
        "div",
        {
          style: {
            display: view === "chat" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          },
        },
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
      working && !streaming
        ? React.createElement(
            "div",
            { style: { color: "var(--euterpe-status)", fontSize: "12px" } },
            activeVerb
          )
        : null,
      working && !streaming && activeTip
        ? React.createElement(
            "div",
            { style: { color: "var(--euterpe-text-muted)", fontSize: 11, marginTop: 2 } },
            activeTip
          )
        : null,
      status && !streaming && !working
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
      { style: { display: "flex", flexDirection: "column", gap: 6, paddingBottom: "16px" } },
      React.createElement(
        "div",
        { style: scopeBadgeStyle(isPinned) },
        React.createElement(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
          React.createElement(InlineIcon, { name: ICON.profile, size: 14, style: { color: "var(--euterpe-warn)", flexShrink: 0 } }),
          ((currentProfile && currentProfile.name) || tr("profile.none")) + " · " + (isPinned ? tr("profile.inConversation") : tr("profile.global"))
        ),
        React.createElement("button", { style: linkStyle, onClick: togglePin }, isPinned ? tr("profile.backToGlobal") : tr("profile.useOnlyHere"))
      ),
      React.createElement(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "flex-end" } },
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
    )
    )
  ),
  prefsPanel
),
toastsPanel
);
}
