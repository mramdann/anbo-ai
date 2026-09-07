import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const output = argument('output');
if (!output) throw Error('Pass a fresh output path');
const endpoint = argument('mcp-url', 'http://127.0.0.1:7332/mcp');
const address = new URL(endpoint);
if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/mcp') throw Error('Only a loopback Anbo MCP endpoint is supported');
const workspace = argument('workspace');
if (!workspace) throw Error('Pass --workspace explicitly');
const title = 'Audit "quoted" title & Unicode: café 東京';
const checks = [], calls = [], owned = new Set(), held = new Set();
let sequence = 0, origin, session, before;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  session ||= response.headers.get('mcp-session-id');
  return response.json();
}
async function call(name, args) {
  const start = performance.now();
  const envelope = await rpc('tools/call', { name, arguments: args });
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  const sample = { name, args, wallMs: Math.round(performance.now() - start), value, error: envelope.error ?? (envelope.result?.isError ? value : null) };
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw Error(`${name}: ${JSON.stringify(sample.error)}`);
  return sample.value;
}
function check(name, passed, detail) {
  const item = { name, passed: Boolean(passed), detail };
  checks.push(item); console.log(JSON.stringify(item));
}
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/held/')) {
    held.add(response); response.on('close', () => held.delete(response));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><title>${title.replaceAll('&', '&amp;')}</title><body>COORDINATOR_PAGE_READY</body>`);
});
async function closeOwned(tabId) {
  const tabs = await ok('browser_tabs', {});
  const tab = tabs.tabs.find(item => item.tabId === tabId);
  if (tab && ![tab.url, tab.pendingUrl].some(url => url?.startsWith(`${origin}/`))) {
    throw Error(`Refusing to close changed tab ${tabId}`);
  }
  if (tab) await ok('browser_close', { workspace, tabId });
  owned.delete(tabId);
}
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'anbo-browser-audit-verifier', version: '1' } });
  before = await ok('browser_tabs', {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (let round = 1; round <= 3; round++) {
    let tabId;
    try {
      const url = `${origin}/ready/${round}?quote=%22test%22#section`;
      ({ tabId } = await ok('browser_open', { workspace, url })); owned.add(tabId);
      await ok('browser_wait', { tabId, condition: 'load', loadState: 'complete', timeout: 5000 });
      const loaded = await call('browser_page_info', { tabId });
      check(`loaded page exact title and URL ${round}`, !loaded.error && loaded.value.title === title && loaded.value.url === url, loaded);
      const pendingUrl = `${origin}/held/${round}`;
      await ok('browser_navigate', { tabId, url: pendingUrl });
      const deadline = Date.now() + 3000;
      while (!held.size && Date.now() < deadline) await delay(20);
      check(`held request reached server ${round}`, held.size > 0);
      const source = await call('browser_get_url', { tabId });
      check(`committed URL remains readable ${round}`, !source.error && source.value.url === url && source.wallMs < 1500, source);
      const pending = await call('browser_page_info', { tabId });
      check(`page info while response headers held ${round}`, !pending.error && pending.value.title === title && pending.value.url === url && pending.wallMs < 1500, pending);
      const tabs = await ok('browser_tabs', {});
      check(`page info does not stop navigation ${round}`, tabs.tabs.some(tab => tab.tabId === tabId && tab.loading && tab.pendingUrl === pendingUrl));
      await ok('browser_stop', { tabId });
      const stopped = await call('browser_page_info', { tabId });
      check(`page info after stop ${round}`, !stopped.error && stopped.value.title === title && stopped.value.url === url, stopped);
    } catch (error) { check(`scenario completed ${round}`, false, String(error)); }
    finally {
      if (tabId) { try { await closeOwned(tabId); } catch (error) { check(`close ${round}`, false, String(error)); } }
    }
  }
} finally {
  for (const tabId of [...owned]) { try { await closeOwned(tabId); } catch (error) { check('cleanup', false, String(error)); } }
  if (before) {
    const after = await ok('browser_tabs', {});
    check('original tabs and focus preserved', before.activeSpaceId === after.activeSpaceId && before.activeTabId === after.activeTabId && before.tabs.every(tab => after.tabs.some(item => item.tabId === tab.tabId)));
  }
  check('owned tabs closed', owned.size === 0);
  if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) });
  for (const response of held) response.destroy();
  server.closeAllConnections(); server.close();
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ endpoint, workspace, checks, calls, unclosedTabs: [...owned] }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output: destination, passed: checks.filter(item => item.passed).length, total: checks.length }));
  if (checks.some(item => !item.passed)) process.exitCode = 1;
}
