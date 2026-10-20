// Regras puras compartilhadas pelo instalador e seus testes por plataforma.
import { win32, posix } from 'node:path'

export function layout(platform, env, home, exists = () => false) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Plataforma não suportada: ${platform}`)
  const path = platform === 'win32' ? win32 : posix
  const nonempty = (key) => env[key]?.trim() ? env[key] : undefined
  let data = nonempty('EUTERPE_DATA_DIR')
  if (!data) {
    if (platform === 'win32') {
      if (!nonempty('APPDATA')) throw new Error('APPDATA não está definido')
      data = path.join(env.APPDATA, 'euterpe')
    } else {
      const legacy = path.join(nonempty('XDG_DATA_HOME') || path.join(home, '.local/share'), 'euterpe')
      data = platform === 'darwin' && !exists(legacy)
        ? path.join(home, 'Library/Application Support/Euterpe') : legacy
    }
  }
  return { data, exeName: platform === 'win32' ? 'euterpe.exe' : 'euterpe' }
}

export function nativeTargets(platform, arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  if (!cpu) throw new Error(`Arquitetura não suportada: ${arch}`)
  if (platform === 'win32') return [`${cpu}-pc-windows-msvc`, `${cpu}-pc-windows-gnullvm`, ...(arch === 'x64' ? [`${cpu}-pc-windows-gnu`] : [])]
  if (platform === 'linux') return [`${cpu}-unknown-linux-gnu`, `${cpu}-unknown-linux-musl`]
  if (platform === 'darwin') return [`${cpu}-apple-darwin`]
  throw new Error(`Plataforma não suportada: ${platform}`)
}

export function binaryCandidates(root, platform, arch, env = {}, explicit) {
  const path = platform === 'win32' ? win32 : posix
  if (explicit || env.EUTERPE_BIN) return [path.resolve(explicit || env.EUTERPE_BIN)]
  const targets = nativeTargets(platform, arch)
  if (env.CARGO_BUILD_TARGET && !targets.includes(env.CARGO_BUILD_TARGET)) {
    throw new Error('CARGO_BUILD_TARGET não corresponde à plataforma/arquitetura em execução; use --daemon para um binário nativo')
  }
  const targetDir = env.CARGO_TARGET_DIR ? path.resolve(env.CARGO_TARGET_DIR) : path.join(root, 'core', 'target')
  const name = platform === 'win32' ? 'euterpe.exe' : 'euterpe'
  return [
    ...(env.CARGO_BUILD_TARGET ? [path.join(targetDir, env.CARGO_BUILD_TARGET, 'release', name)] : []),
    path.join(targetDir, 'release', name),
    ...targets.map(target => path.join(targetDir, target, 'release', name)),
  ]
}

export function parseOptions(args) {
  const result = { startup: true }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-startup') result.startup = false
    else if (arg === '--help') result.help = true
    else if (arg === '--daemon' || arg === '--spicetify-dir') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Falta o valor de ${arg}`)
      result[arg === '--daemon' ? 'daemon' : 'spicetifyDir'] = value
    } else throw new Error(`Opção desconhecida: ${arg}`)
  }
  return result
}
