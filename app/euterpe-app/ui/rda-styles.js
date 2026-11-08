// Keep RDA tokens and fonts inside the custom app, preserving the Spotify shell.
import tokens from "../../../web/dist/rda-tokens.css";
import inter from "../../../web/dist/fonts/inter-latin-wght-normal.woff2";
import archivo from "../../../web/dist/fonts/archivo-latin-wght-normal.woff2";
import firaCode from "../../../web/dist/fonts/fira-code-latin-wght-normal.woff2";

export function injectRdaStyles() {
  const id = "euterpe-rda-styles";
  document.getElementById(id)?.remove();
  const style = document.createElement("style");
  style.id = id;
  style.textContent = tokens
    .replace(/:root/g, ".euterpe-app")
    .replace(/\[data-theme="(dark|light)"\]/g, '.euterpe-app[data-theme="$1"]')
    .replace(/\bbody\s*\{/g, ".euterpe-app {")
    .replace(/:focus-visible/g, ".euterpe-app :focus-visible") + `
@font-face { font-family: Inter; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${inter}") format("woff2"); }
@font-face { font-family: Archivo; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${archivo}") format("woff2"); }
@font-face { font-family: 'Fira Code'; font-style: normal; font-weight: 300 700; font-display: swap; src: url("${firaCode}") format("woff2"); }
.euterpe-app { font-family: var(--rda-font-family-body); --encore-body-font-stack: var(--rda-font-family-body); --encore-bodyMono-font-stack: var(--rda-font-family-mono); }
.euterpe-app h1, .euterpe-app h2, .euterpe-app h3 { font-family: var(--rda-font-family-display); }
.euterpe-app code, .euterpe-app pre { font-family: var(--rda-font-family-mono); }
`;
  document.head.appendChild(style);
}
