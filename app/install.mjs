#!/usr/bin/env node
// Instala o daemon nativo e a extensão. Comandos recebem argumentos sem shell.
import { execFileSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync, statSync, chmodSync, renameSync, unlinkSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { layout, binaryCandidates, parseOptions } from './install-platform.mjs'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(appDir, '..')

function run(command, args, options = {}) {
  console.log('\n$ ' + command + ' ' + args.join(' '))
  return execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
}

// Não confia apenas no PID declarado via HTTP: verifica o executável no SO.
function processExecutable(pid) {
  if (process.platform === 'linux') return readlinkSync('/proc/' + pid + '/exe')
  if (process.platform === 'darwin') return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-Process -Id $env:EUTERPE_CHECK_PID -ErrorAction Stop).Path'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, EUTERPE_CHECK_PID: String(pid) },
  }).trim()
}

function sameExecutable(a, b) {
  const canonical = p => {
    const value = realpathSync.native(p)
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  return canonical(a) === canonical(b)
}

async function install(options) {
  if (/^(1|true|yes)$/.test(process.env.EUTERPE_PORTABLE || '')) {
    throw new Error('Para instalar, desative EUTERPE_PORTABLE. Para uso portátil, execute o binário diretamente com --ensure.')
  }
  const platform = layout(process.platform, process.env, homedir(), existsSync)
  const data = resolve(platform.data)
  const exe = join(data, platform.exeName)
  const env = { ...process.env, EUTERPE_DATA_DIR: data }
  const candidates = binaryCandidates(repoRoot, process.platform, process.arch, process.env, options.daemon)
  const source = candidates.find(p => existsSync(p) && statSync(p).isFile())
  if (!source) throw new Error('Daemon não encontrado. Rode cargo build --release em core/ ou use --daemon. Procurado em:\n' + candidates.join('\n'))
  // Falha antes de alterar a instalação se o binário não for executável neste host.
  const version = execFileSync(source, ['version'], { encoding: 'utf8', windowsHide: true }).trim()
  if (!version.startsWith('euterpe ')) throw new Error('Binário inválido: ' + source)
  const spicetify = process.env.SPICETIFY_BIN || 'spicetify'
  const dest = resolve(options.spicetifyDir || execFileSync(spicetify, ['path', 'userdata'], {
    encoding: 'utf8', windowsHide: true,
  }).trim())
  if (!existsSync(dest) || !statSync(dest).isDirectory()) throw new Error('Diretório do Spicetify inválido: ' + dest)
  run(process.execPath, [join(appDir, 'build.mjs')], { cwd: appDir })

  mkdirSync(data, { recursive: true })
  // A migração acontece antes do primeiro start, que criaria um banco vazio.
  const dbSource = join(repoRoot, 'agent', 'data', 'euterpe.db')
  const dbDest = join(data, 'euterpe.db')
  if (existsSync(dbSource) && !existsSync(dbDest)) {
    if (existsSync(dbSource + '-wal')) throw new Error('Encerre o agente Node antes de migrar o SQLite (WAL presente).')
    copyFileSync(dbSource, dbDest)
  }
  let config = {}
  const configPath = join(data, 'config.json')
  if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8'))
  const host = env.HOST || config.HOST || '127.0.0.1'
  const port = Number(env.PORT || config.PORT || 8337)
  if (host !== '127.0.0.1' || port !== 8337) throw new Error('A extensão requer HOST=127.0.0.1 e PORT=8337. Ajuste o ambiente/config.json antes de instalar.')
  const base = 'http://' + host + ':' + port
  const health = async () => {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw new Error('health inválido')
      return await response.json()
    } catch { return null }
  }

  const running = await health()
  if (running) {
    const samePath = typeof running.executable === 'string' &&
      (process.platform === 'win32' ? resolve(running.executable).toLowerCase() === exe.toLowerCase() : resolve(running.executable) === exe)
    if (running.app !== 'euterpe' || !samePath || !Number.isSafeInteger(running.pid) || running.pid <= 0) {
      throw new Error('Existe um processo na porta 8337 que não pode ser atualizado com segurança (possivelmente Euterpe antigo). Encerre essa instância e execute o instalador novamente.')
    }
    if (!sameExecutable(processExecutable(running.pid), exe)) throw new Error('O PID informado não pertence ao executável instalado. Encerre a instância manualmente.')
    process.kill(running.pid, 'SIGTERM')
    let alive = true
    for (let attempt = 0; attempt < 60; attempt++) {
      try { process.kill(running.pid, 0) }
      catch (error) {
        if (error.code !== 'ESRCH') throw error
        alive = false
        break
      }
      await delay(250)
    }
    if (alive) throw new Error('O processo ainda não encerrou. Nenhum executável foi substituído.')
    if (await health()) throw new Error('Daemon ainda ativo após solicitar encerramento; instalação interrompida.')
  }

  if (resolve(source) !== exe) {
    // Rename no Unix evita ETXTBSY e garante que nunca se execute uma cópia parcial.
    const staged = exe + '.install-' + process.pid
    try {
      copyFileSync(source, staged)
      if (process.platform !== 'win32') chmodSync(staged, 0o755)
      renameSync(staged, exe)
    } finally {
      if (existsSync(staged)) unlinkSync(staged)
    }
  }
  if (options.startup) run(exe, ['install-startup'], { env })
  else run(exe, ['install-startup', '--remove'], { env })
  run(exe, ['--ensure'], { env })

  const customApp = join(dest, 'CustomApps', 'euterpe-app')
  const extensions = join(dest, 'Extensions')
  mkdirSync(customApp, { recursive: true })
  mkdirSync(extensions, { recursive: true })
  copyFileSync(join(appDir, 'euterpe-app/dist/index.js'), join(customApp, 'index.js'))
  copyFileSync(join(appDir, 'euterpe-app/manifest.json'), join(customApp, 'manifest.json'))
  copyFileSync(join(appDir, 'euterpe-extension/euterpe.js'), join(extensions, 'euterpe.js'))
  run(spicetify, ['config', 'custom_apps', 'euterpe-app'])
  run(spicetify, ['config', 'extensions', 'euterpe.js'])
  try { run(spicetify, ['apply']) }
  catch { run(spicetify, ['backup', 'apply']) }
  const stdio = JSON.stringify({ mcpServers: { euterpe: { command: exe, args: ['mcp', '--stdio'], env: { EUTERPE_DATA_DIR: data } } } }, null, 2)
  console.log('\nInstalado: ' + version + '\nDados: ' + data + '\nAutostart: ' + (options.startup ? 'ativado' : 'desativado') + '\nDaemon iniciado. Reabra o Spotify.\nMCP HTTP: ' + base + '/mcp\nMCP stdio:\n' + stdio)
}

try {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) console.log('node app/install.mjs [--daemon CAMINHO] [--spicetify-dir DIRETORIO] [--no-startup]\nInstala e inicia agora. --no-startup também remove um autostart anterior.')
  else await install(options)
} catch (err) {
  console.error('\nErro: ' + err.message)
  process.exitCode = 1
}
