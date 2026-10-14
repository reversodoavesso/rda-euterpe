#!/usr/bin/env node
// Instala o Euterpe no Spotify (spicetify) + o daemon (euterpe.exe).
//
// Ordem: build do custom app (esbuild) → copiar bundle+manifest + extensão →
// configurar o spicetify → instalar o daemon (exe, autostart, migração do DB) →
// imprimir os snippets de MCP.
//
// O custom app instalado é o BUNDLE (`euterpe-app/dist/index.js`, D4): o
// `index.js` da fonte usa `import` e não resolve dentro do módulo webpack que o
// spicetify gera.
import { execSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const APP_URL = 'http://127.0.0.1:8337/mcp'

function spicetifyDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, 'spicetify') : null
  }
  return join(homedir(), '.config', 'spicetify')
}

// Mesma regra do daemon (core/src/paths.rs): EUTERPE_DATA_DIR manda; Windows usa
// %APPDATA%\euterpe; o resto cai no XDG.
function dataDir() {
  const override = process.env.EUTERPE_DATA_DIR
  if (override && override.trim()) return override
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'euterpe')
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'euterpe')
  return join(homedir(), '.local', 'share', 'euterpe')
}

function run(cmd) {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', shell: true })
}

function tryRun(cmd, label) {
  try {
    execSync(cmd, { stdio: 'inherit', shell: true })
    return true
  } catch {
    console.log(`warning: ${label} falhou (siga manualmente: ${cmd})`)
    return false
  }
}

function tryApply() {
  console.log(`\n$ spicetify apply`)
  try {
    execSync('spicetify apply', { stdio: 'inherit', shell: true })
    return true
  } catch {
    return false
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function buildApp() {
  const buildScript = join(__dirname, 'build.mjs')
  if (!existsSync(buildScript)) return
  if (!existsSync(join(__dirname, 'node_modules', 'esbuild'))) {
    throw new Error(`esbuild não instalado. Rode: cd "${__dirname}" && npm install`)
  }
  console.log('\nBuilding the custom app bundle (esbuild)')
  try {
    execSync('node build.mjs', { cwd: __dirname, stdio: 'inherit', shell: true })
  } catch (err) {
    throw new Error(`build falhou (${err.message}). Rode "cd app && npm install && node build.mjs" para ver o erro.`)
  }
}

function installCustomApp(customAppsDir) {
  const appDest = join(customAppsDir, 'euterpe-app')
  rmSync(appDest, { recursive: true, force: true })
  mkdirSync(appDest, { recursive: true })
  const files = [
    [join(__dirname, 'euterpe-app', 'dist', 'index.js'), join(appDest, 'index.js')],
    [join(__dirname, 'euterpe-app', 'manifest.json'), join(appDest, 'manifest.json')],
  ]
  for (const [src, dest] of files) {
    if (!existsSync(src)) throw new Error(`arquivo ausente: ${src} (rode "node app/build.mjs")`)
    copyFileSync(src, dest)
    console.log(`copied  ${src}  (${kb(statSync(src).size)})  ->  ${dest}`)
  }
}

function installExtension(extDir) {
  const extSrc = join(__dirname, 'euterpe-extension', 'euterpe.js')
  const extDest = join(extDir, 'euterpe.js')
  copyFileSync(extSrc, extDest)
  console.log(`copied  ${extSrc}  ->  ${extDest}`)
}

// Passo 4/5 do install: exe único + autostart + migração one-time do SQLite.
function installDaemon() {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })

  // O alvo desta máquina é `x86_64-pc-windows-gnu` (ver core/.cargo/config.toml),
  // então o binário aparece em `target/<triple>/release/`; mantemos também o
  // caminho "clássico" `target/release/` para quando o host for o default.
  const exeName = process.platform === 'win32' ? 'euterpe.exe' : 'euterpe'
  const exeCandidates = [
    join(repoRoot, 'core', 'target', 'x86_64-pc-windows-gnu', 'release', exeName),
    join(repoRoot, 'core', 'target', 'release', exeName),
  ]
  const exeSrc = exeCandidates.find((p) => existsSync(p))
  if (exeSrc) {
    const exeDest = join(dir, exeName)
    try {
      copyFileSync(exeSrc, exeDest)
      console.log(`copied  ${exeSrc}  ->  ${exeDest}`)
    } catch (err) {
      // EBUSY/EPERM: o daemon está em execução a partir desse caminho e o
      // Windows não deixa sobrescrever. Não é motivo para abortar a instalação
      // do mod (que já foi aplicada) — avisamos e seguimos.
      console.log(
        `\n(não consegui atualizar o daemon em ${exeDest}: ${err.code || err.message})\n` +
          ` pare o daemon (mesmo caminho, argumento --ensure cuida de subir de novo) e rode de novo.`
      )
    }
    tryRun(`"${exeDest}" install-startup`, 'euterpe install-startup (atalho de Startup)')
  } else {
    console.log(
      `\n(daemon não encontrado em:\n  ${exeCandidates.join('\n  ')}\n rode: cd core && cargo build --release)`
    )
  }

  const dbSrc = join(repoRoot, 'agent', 'data', 'euterpe.db')
  const dbDest = join(dir, 'euterpe.db')
  if (existsSync(dbSrc) && !existsSync(dbDest)) {
    copyFileSync(dbSrc, dbDest)
    console.log(`migrated  ${dbSrc}  ->  ${dbDest}`)
  } else if (existsSync(dbDest)) {
    console.log(`(histórico já existe em ${dbDest} — migração não é refeita)`)
  }
}

function printMcpSnippets() {
  const exe = join(dataDir(), process.platform === 'win32' ? 'euterpe.exe' : 'euterpe')
  const stdio = JSON.stringify({ mcpServers: { euterpe: { command: exe, args: ['mcp', '--stdio'] } } })
  console.log(`
MCP — registre o servidor no seu cliente (o daemon precisa estar rodando):

  opencode:     opencode mcp add euterpe --url ${APP_URL}
  claude-code:  claude mcp add --transport http euterpe ${APP_URL}
  json (stdio): ${stdio}
`)
}

function install() {
  const dest = spicetifyDir()
  if (!dest) throw new Error('Could not find the spicetify directory')
  if (!existsSync(dest)) throw new Error(`The spicetify directory does not exist: ${dest}`)

  const customAppsDir = join(dest, 'CustomApps')
  const extDir = join(dest, 'Extensions')
  mkdirSync(customAppsDir, { recursive: true })
  mkdirSync(extDir, { recursive: true })

  buildApp()
  installCustomApp(customAppsDir)
  installExtension(extDir)

  run('spicetify config custom_apps euterpe-app')
  run('spicetify config extensions euterpe.js')

  if (!tryApply()) {
    console.log('\nApply failed (likely a backup version mismatch). Recreating the backup and trying again...')
    run('spicetify backup apply')
    if (!tryApply()) throw new Error('spicetify apply failed after backup apply. Run "spicetify backup apply" manually.')
  }

  installDaemon()
  printMcpSnippets()

  console.log('Installed. Restart Spotify (if open) and open "Euterpe" in the sidebar.')
}

try {
  install()
} catch (err) {
  console.error(`\nError: ${err.message}`)
  process.exit(1)
}
