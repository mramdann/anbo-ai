import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url', 'http://127.0.0.1:7332/mcp'));
const workspace = arg('workspace'), output = arg('output');
if (!workspace || !output || existsSync(output)) throw Error('Pass --workspace and a fresh --output file');
if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || endpoint.pathname !== '/mcp') throw Error('Use a loopback MCP endpoint');
const checks = [], calls = [], owned = new Set(), timers = new Set(), completed = new Map();
let sequence = 0, session, origin, frameOrigin, before;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(20000),
  });
  session ||= response.headers.get('mcp-session-id');
  return response.json();
}
async function call(name, args) {
  const start = performance.now();
  const envelope = await rpc('tools/call', { name, arguments: args });
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  let value; try { value = JSON.parse(text); } catch { value = text; }
  const sample = { name, wallMs: Math.round(performance.now() - start), value, error: envelope.error ?? (envelope.result?.isError ? value : null) };
  calls.push(sample); return sample;
}
async function ok(name, args) { const result = await call(name, args); if (result.error) throw Error(JSON.stringify(result.error)); return result.value; }
function check(name, passed, detail) { const item = { name, passed: Boolean(passed), detail }; checks.push(item); console.log(JSON.stringify(item)); }
function serve(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  const id = url.searchParams.get('id') || 'none';
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: `/body?id=${id}` }); res.end(); return;
  }
  if (url.pathname === '/body' || url.pathname === '/never') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('start\n');
    if (url.pathname === '/never') { res.on('close', () => completed.set(id, performance.now())); return; }
    const timer = setTimeout(() => { timers.delete(timer); completed.set(id, performance.now()); res.end('finished'); }, 2400);
    timers.add(timer); return;
  }
  res.setHeader('Content-Type', 'text/html');
  const kind = url.searchParams.get('kind') || 'fetch';
  if (kind === 'frame') {
    res.end(`<!doctype html><title>Frame network fixture</title><p>NETWORK_FIXTURE</p><iframe src="${frameOrigin}/?id=${id}&kind=fetch"></iframe>`); return;
  }
  const action = kind === 'xhr'
    ? `const xhr=new XMLHttpRequest();xhr.open('GET','/body?id=${id}');xhr.onload=done;xhr.send();`
    : kind === 'abort'
      ? `const controller=new AbortController();fetch('/never?id=${id}',{signal:controller.signal}).then(r=>r.text()).catch(done);setTimeout(()=>controller.abort(),1200);`
      : `fetch('/${kind === 'redirect' ? 'redirect' : kind === 'timeout' ? 'never' : 'body'}?id=${id}').then(r=>r.text()).then(done);`;
  res.end(`<!doctype html><title>Network fixture</title><p>NETWORK_FIXTURE</p><output id="state">loading</output><script>const done=()=>document.querySelector('#state').textContent='NETWORK_FINISHED';${action}</script>`);
}
const server = http.createServer(serve), frameServer = http.createServer(serve);
async function close(tabId) {
  const tab = (await ok('browser_tabs', {})).tabs.find(item => item.tabId === tabId);
  if (tab && ![tab.url, tab.pendingUrl].some(url => url?.startsWith(origin + '/'))) throw Error('Owned tab changed origin; refusing cleanup');
  if (tab) await ok('browser_close', { workspace, tabId }); owned.delete(tabId);
}
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'anbo-network-smoke', version: '1' } });
  before = await ok('browser_tabs', {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => frameServer.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`; frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
  for (const kind of ['fetch', 'xhr', 'redirect', 'frame', 'abort', 'timeout']) {
    const id = `${kind}-${Date.now()}`;
    const { tabId } = await ok('browser_open', { workspace, url: `${origin}/?kind=${kind}&id=${id}` }); owned.add(tabId);
    await ok('browser_wait', { tabId, text: 'NETWORK_FIXTURE', timeout: 5000 });
    const result = await call('browser_wait', { tabId, condition: 'load', loadState: 'networkIdle', timeout: kind === 'timeout' ? 800 : 8000 });
    if (kind === 'timeout') {
      check('ongoing stream times out instead of false idle', Boolean(result.error) && String(result.error).includes('[timeout]'), result);
    } else {
      const ended = completed.get(id);
      check(`${kind}: response finishes before idle`, !result.error && ended != null && performance.now() - ended >= 450, { result, quietMs: ended == null ? null : Math.round(performance.now() - ended) });
      const again = await call('browser_wait', { tabId, condition: 'load', loadState: 'networkIdle', timeout: 1000 });
      check(`${kind}: idle read has no extra fixed delay`, !again.error && again.wallMs < 450, again);
      completed.delete(id);
      await ok('browser_reload', { tabId });
      await ok('browser_wait', { tabId, text: 'NETWORK_FIXTURE', timeout: 5000 });
      const reloaded = await call('browser_wait', { tabId, condition: 'load', loadState: 'networkIdle', timeout: 8000 });
      const reloadEnd = completed.get(id);
      check(`${kind}: observer survives reload`, !reloaded.error && reloadEnd != null && performance.now() - reloadEnd >= 450, reloaded);
    }
    await close(tabId);
  }
  await delay(50);
  check('all fixture tabs closed', owned.size === 0);
} catch (error) { check('suite completed', false, String(error)); }
finally {
  for (const tabId of [...owned]) { try { await close(tabId); } catch (error) { check('cleanup', false, String(error)); } }
  if (before) {
    const after = await ok('browser_tabs', {});
    check('original tabs and focus preserved', before.activeTabId === after.activeTabId && before.activeSpaceId === after.activeSpaceId && JSON.stringify(before.tabs.map(t=>t.tabId)) === JSON.stringify(after.tabs.map(t=>t.tabId)));
  }
  if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); frameServer.closeAllConnections(); server.close(); frameServer.close();
  await writeFile(output, JSON.stringify({ checks, calls, unclosedTabs: [...owned] }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: checks.filter(item=>item.passed).length, total: checks.length, output }));
  if (checks.some(item=>!item.passed)) process.exitCode = 1;
}
