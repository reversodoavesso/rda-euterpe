// Euterpe — Custom App (bootstrap).
//
// Este arquivo é bundlado por `app/build.mjs` (esbuild, formato IIFE) e o
// `install.mjs` copia o artefato para `<spicetify>/CustomApps/euterpe-app/index.js`.
// Tudo que é UI vive em `ui/*.js`; aqui só ficam o diagnóstico, o CSS do app e o
// registro no spicetify.
import { EuterpeApp, injectStyles } from "./ui/chat.js";

const { React } = Spicetify;

// TEMP DIAGNOSTICS — report app errors to the agent log (client.debug)
// and keep a copy on the page. Remove once the loading issue is fixed.
(function diag() {
  const report = (level, detail) => {
    try {
      if (window.euterpe && typeof window.euterpe.send === "function") {
        window.euterpe.send({ type: "client.debug", level, detail: "[euterpe-app] " + String(detail) });
      }
    } catch (_) {}
  };
  window.addEventListener("error", (e) => report("error", (e && e.message ? e.message : e) + " @ " + (e && e.filename ? e.filename : "?") + ":" + (e && e.lineno ? e.lineno : "?")));
  window.addEventListener("unhandledrejection", (e) => report("error", "unhandledrejection: " + (e && e.reason ? e.reason : e)));
})();

injectStyles();

function render() {
  try {
    return React.createElement(EuterpeApp);
  } catch (err) {
    try {
      if (window.euterpe && typeof window.euterpe.send === "function") {
        window.euterpe.send({ type: "client.debug", level: "error", detail: "[euterpe-app] RENDER FAIL: " + (err && err.stack ? err.stack : err) });
      }
    } catch (_) {}
    return React.createElement(
      "section",
      { className: "contentSpacing" },
      React.createElement("p", { style: { whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 } }, String(err && err.stack ? err.stack : err))
    );
  }
}

// O spicetify injeta este arquivo no corpo de um módulo webpack
// (`n.d(t,{default:()=>render})`) e resolve `render` do escopo do módulo. Um
// bundle IIFE não expõe bindings, então publicamos `render` no global: o getter
// do wrapper cai no escopo global quando não encontra o binding local.
globalThis.render = render;
