// Build do Custom App Euterpe: esbuild → app/euterpe-app/dist/index.js
//
// Por que bundlar (PLAN-REFACTOR.md, D4): o spicetify injeta o arquivo do custom
// app dentro do corpo de um módulo webpack; um `import` relativo no arquivo
// copiado não resolve naquele contexto. O bundle evita depender do resolver do
// spicetify. `dist/` é gitignored: o artefato é gerado, nunca versionado.
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "euterpe-app", "index.js");
const outfile = join(here, "euterpe-app", "dist", "index.js");

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  // IIFE: o spicetify lê `render` do escopo do módulo; o bundle publica `render`
  // no global (ver comentário no fim de euterpe-app/index.js).
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  banner: {
    js: "// Euterpe custom app - artefato gerado por app/build.mjs (esbuild). Nao edite: a fonte vive em app/euterpe-app/.",
  },
});

const bytes = statSync(outfile).size;
let warnings = 0;
for (const item of Object.values(result.metafile.outputs)) warnings += item.warnings?.length ?? 0;
console.log(`built  ${relative(process.cwd(), outfile)}  ${bytes} bytes  (${(bytes / 1024).toFixed(1)} KiB)`);
if (warnings) console.log(`warnings: ${warnings}`);
for (const w of result.warnings) console.log(`  ${w.text}`);
