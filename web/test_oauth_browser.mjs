/** Real Chromium regression: form -> local 200 -> cross-origin redirect chain. */
import { chromium } from '../../deploy/homologation/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'euterpe-mcp-browser-'));
const child = spawn('python', ['-u', '-c', `from server import make_server\nfrom test_server import FakeWorkers\ns=make_server(${JSON.stringify(directory)},('127.0.0.1',0),FakeWorkers())\nprint(s.server_port,flush=True)\ns.serve_forever()`], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, WEB_PUBLIC_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, port, stderr = '';
child.stderr.on('data', data => { stderr += data; });
const received = [];
const callbackServer = createServer((req, res) => {
  if (req.url.startsWith('/callback')) {
    res.writeHead(302, { Location: `http://localhost:${callbackServer.address().port}/complete${new URL(req.url, 'http://local.test').search}` });
  } else {
    received.push({ referer: req.headers.referer, url: req.url });
    res.setHeader('Content-Type', 'text/plain');
  }
  res.end('Callback received');
});
try {
  port = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(Number(String(data).trim())));
    child.once('exit', code => reject(Error(`gateway ${code}: ${stderr}`)));
  });
  await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: 'America/Sao_Paulo' });
  const origin = `http://127.0.0.1:${port}`;
  assert((await context.request.post(origin + '/api/account/register', { data: { username: 'oauth-browser', password: 'synthetic-password-123' } })).ok());
  const callback = `http://127.0.0.1:${callbackServer.address().port}/callback`;
  const client = await (await context.request.post(origin + '/oauth/register', { data: { client_name: 'Cliente de leitura e organização de biblioteca com nome longo para revisão de conexões MCP', redirect_uris: [callback] } })).json();
  const verifier = 'v'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
  for (const manual of [false, true]) {
    const page = await context.newPage(), csp = [];
    page.on('console', msg => { if (msg.text().includes('form-action')) csp.push(msg.text()); });
    if (manual) await page.route('**/oauth-return.js', route => route.abort());
    await page.goto(origin + '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'regression' }));
    if (!manual) {
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: fileURLToPath(new URL(`../../artifacts/euterpe-mcp-consent-${width}.png`, import.meta.url)), fullPage: true });
      }
    }
    await page.getByRole('button', { name: 'Autorizar acesso', exact: true }).click();
    if (manual) {
      await page.getByRole('heading', { name: 'Voltando ao aplicativo' }).waitFor();
      await page.getByRole('link', { name: 'Continuar', exact: true }).click();
    }
    await page.waitForURL(url => url.hostname === 'localhost' && url.pathname === '/complete', { timeout: 8000 });
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get('state'), 'regression');
    assert.equal(csp.length, 0);
    assert.equal(received.at(-1).referer, undefined);
    const result = await context.request.post(origin + '/oauth/token', { form: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback, code: params.get('code'), code_verifier: verifier } });
    assert.equal(result.status(), 200);
    await page.close();
  }
  const settings = await context.newPage();
  await settings.goto(origin);
  await settings.waitForFunction(() => state.user && (state.startup === null || state.startup?.status === 'error'));
  await settings.evaluate(async () => {
    const me = await (await fetch('/api/me')).json();
    state.user = me.user; state.csrf = me.csrf; state.startup = null; state.settings = {}; state.providers = []; state.view = 'settings'; render();
  });
  await settings.getByRole('heading', { name: 'Conexões MCP', exact: true }).waitFor();
  await settings.locator('#mcp-connections article').first().waitFor();
  for (const width of [320, 1440]) {
    await settings.setViewportSize({ width, height: 1000 });
    await settings.evaluate(() => document.fonts.ready);
    assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await settings.screenshot({ path: fileURLToPath(new URL(`../../artifacts/euterpe-mcp-settings-${width}.png`, import.meta.url)), fullPage: true });
    await settings.locator('#mcp-connections article').first().scrollIntoViewIfNeeded();
    await settings.screenshot({ path: fileURLToPath(new URL(`../../artifacts/euterpe-mcp-connections-${width}.png`, import.meta.url)), fullPage: true });
  }
  await settings.getByRole('button', { name: 'Revogar conexão', exact: true }).first().click();
  await settings.getByRole('button', { name: 'Confirmar revogação', exact: true }).click();
  await settings.locator('#mcp-connections').getByText('Revogada', { exact: true }).waitFor();
  await settings.route('**/api/mcp/connections', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await settings.getByRole('button', { name: 'Atualizar conexões', exact: true }).click();
  await settings.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor();
  await settings.unroute('**/api/mcp/connections');
  await settings.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await settings.locator('#mcp-connections article').first().waitFor();
  console.log(JSON.stringify({ status: 'passed', checks: ['chained-cross-origin-callback', 'manual-continuation', 'no-callback-referer', 'pkce-exchange', 'consent-and-settings-320-1440', 'owner-revocation', 'settings-error-retry'], production: false, geminiInteractive: false }));
} finally {
  await browser?.close();
  child.kill();
  await new Promise(resolve => callbackServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
