#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function spicetifyDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, 'spicetify') : null
  }
  return join(homedir(), '.config', 'spicetify')
}

function run(cmd) {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', shell: true })
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

function install() {
  const dest = spicetifyDir()
  if (!dest) throw new Error('Could not find the spicetify directory')
  if (!existsSync(dest)) throw new Error(`The spicetify directory does not exist: ${dest}`)

  const customAppsDir = join(dest, 'CustomApps')
  const extDir = join(dest, 'Extensions')
  mkdirSync(customAppsDir, { recursive: true })
  mkdirSync(extDir, { recursive: true })

  const appSrc = join(__dirname, 'euterpe-app')
  const appDest = join(customAppsDir, 'euterpe-app')
  rmSync(appDest, { recursive: true, force: true })
  mkdirSync(appDest, { recursive: true })
  for (const f of ['index.js', 'manifest.json']) {
    copyFileSync(join(appSrc, f), join(appDest, f))
    console.log(`copied  ${join(appSrc, f)}  ->  ${appDest}`)
  }

  const extSrc = join(__dirname, 'euterpe-extension', 'euterpe.js')
  const extDest = join(extDir, 'euterpe.js')
  copyFileSync(extSrc, extDest)
  console.log(`copied  ${extSrc}  ->  ${extDest}`)

  run('spicetify config custom_apps euterpe-app')
  run('spicetify config extensions euterpe.js')

  if (!tryApply()) {
    console.log('\nApply failed (likely a backup version mismatch). Recreating the backup and trying again...')
    run('spicetify backup apply')
    if (!tryApply()) throw new Error('spicetify apply failed after backup apply. Run "spicetify backup apply" manually.')
  }

  console.log('\nInstalled. Restart Spotify (if open) and open "Euterpe" in the sidebar.')
}

try {
  install()
} catch (err) {
  console.error(`\nError: ${err.message}`)
  process.exit(1)
}
