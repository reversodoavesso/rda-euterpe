import test from 'node:test'
import assert from 'node:assert/strict'
import { layout, nativeTargets, binaryCandidates, parseOptions } from '../install-platform.mjs'
import { stdioSnippet } from '../euterpe-app/lib/mcp-config.js'

test('MCP preserva executável e dados de qualquer plataforma', () => {
  for (const executable of ['C:\\Users\\João\\euterpe.exe', '/home/a/euterpe', '/Users/a/Library/Application Support/Euterpe/euterpe']) {
    const server = JSON.parse(stdioSnippet({ executable, dataDir: '/dados especiais' })).mcpServers.euterpe
    assert.equal(server.command, executable)
    assert.deepEqual(server.args, ['mcp', '--stdio'])
    assert.equal(server.env.EUTERPE_DATA_DIR, '/dados especiais')
  }
  assert.equal(JSON.parse(stdioSnippet(null)).mcpServers.euterpe.command, 'euterpe')
})

test('diretórios de dados nativos e compatibilidade com instalação antiga no Mac', () => {
  assert.equal(layout('win32', { APPDATA: 'C:\\Users\\João\\AppData\\Roaming' }, '').data, 'C:\\Users\\João\\AppData\\Roaming\\euterpe')
  assert.equal(layout('linux', { XDG_DATA_HOME: '/dados com espaços' }, '/home/a').data, '/dados com espaços/euterpe')
  assert.equal(layout('darwin', {}, '/Users/a').data, '/Users/a/Library/Application Support/Euterpe')
  assert.equal(layout('darwin', {}, '/Users/a', p => p === '/Users/a/.local/share/euterpe').data, '/Users/a/.local/share/euterpe')
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal(layout(platform, { EUTERPE_DATA_DIR: '/override' }, '').data, '/override')
})

test('binários de outra plataforma/arquitetura não são candidatos', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const arch of ['x64', 'arm64']) {
      const paths = binaryCandidates('/repo', platform, arch)
      assert.ok(paths.every(p => !p.includes('windows') && !p.endsWith('.exe')))
      const opposite = arch === 'x64' ? 'aarch64' : 'x86_64'
      assert.ok(paths.every(p => !p.includes(opposite)))
      assert.ok(nativeTargets(platform, arch).length > 0)
    }
  }
  assert.throws(() => binaryCandidates('/repo', 'linux', 'x64', { CARGO_BUILD_TARGET: 'x86_64-pc-windows-gnu' }))
  assert.deepEqual(binaryCandidates('/repo', 'linux', 'x64', {}, '/prebuilt/euterpe'), ['/prebuilt/euterpe'])
  assert.throws(() => nativeTargets('linux', 'ia32'))
})

test('opções não aceitam typos nem argumentos ausentes', () => {
  assert.deepEqual(parseOptions(['--no-startup', '--daemon', '/a b/euterpe']), { startup: false, daemon: '/a b/euterpe' })
  assert.throws(() => parseOptions(['--daemon']))
  assert.throws(() => parseOptions(['--daemon', '--no-startup']))
  assert.throws(() => parseOptions(['--unknown']))
})
