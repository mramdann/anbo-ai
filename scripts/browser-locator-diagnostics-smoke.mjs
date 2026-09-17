import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output'), binary = arg('binary');
const baseline = arg('baseline') === 'true';
if (!workspace || !binary || !output?.endsWith('.json') || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Pass loopback --mcp-url, --workspace, --binary and fresh .json --output');
const checks = [], calls = [], samples = [], owned = new Set();
let session, sequence = 0, origin, initialTabs, finalTabs;
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(25000) });
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const envelope = await response.json();
  if (!response.ok || envelope.error) throw Error(JSON.stringify(envelope.error ?? response.status));
  return envelope.result;
}
async function call(name, args = {}) {
  const start = performance.now();
  const envelope = await rpc('tools/call', { name, arguments: args });
  const raw = envelope.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  let result;
  try { result = JSON.parse(raw); } catch { result = { message: raw }; }
  const record = { name, args, result, error: !!envelope.isError, wallMs: performance.now() - start };
  calls.push(record);
  return record;
}
async function ok(name, args) { const r = await call(name, args); if (r.error) throw Error(JSON.stringify(r)); return r.result; }
function check(name, passed, detail) { checks.push({ name, passed: !!passed, detail }); console.log(JSON.stringify(checks.at(-1))); if (!passed) throw Error(name); }
const css = value => ({ by: 'css', value, exact: true });
const role = (value, name, timeout = 900) => ({ by: 'role', value, name, exact: true, timeout });
const message = record => JSON.stringify(record.result);
const state = tabId => ok('browser_get_text', { tabId, locator: css('#state') }).then(r => JSON.parse(r.text));
async function open(path) {
  const { tabId } = await ok('browser_open', { workspace, url: origin + path });
  owned.add(tabId);
  await ok('browser_wait', { tabId, condition: 'load', loadState: 'complete', timeout: 8000 });
  return tabId;
}
async function close(tabId) {
  if (!owned.has(tabId)) throw Error('Unowned tab');
  const page = await ok('browser_page_info', { tabId });
  if (!page.url.startsWith(origin + '/')) throw Error('Fixture origin changed; refusing to close tab');
  await ok('browser_close', { tabId, workspace, endSession: true });
  owned.delete(tabId);
}
const fixture = `<!doctype html><html lang="id"><meta charset="utf-8"><title>Locator diagnostics QA</title>
<style>body{font:14px sans-serif;margin:12px}button,input{height:28px;margin:3px}#filler{display:none}</style>
<input id="search" role="combobox" aria-label="Telusuri Google Maps" value="fixture-private-value">
<button id="act">Jalankan</button><button id="arm">Prepare delayed label</button>
<button id="late" aria-label="Menunggu">Late target</button>
<button id="hidden" hidden>Hidden target</button><output id="state"></output>
<input class="duplicate" aria-label="Duplicate"><input class="duplicate" aria-label="Duplicate">
<div id="shadow"></div><div id="filler">${'<i></i>'.repeat(17000)}</div>
<script>
const data={clicks:0,lateClicks:0,inputEvents:0,trusted:true};
const search=document.querySelector('#search');
function render(){document.querySelector('#state').textContent=JSON.stringify({...data,value:search.value,width:innerWidth,height:innerHeight,nodes:document.querySelectorAll('*').length})}
search.oninput=()=>{data.inputEvents++;render()};document.querySelector('#act').onclick=e=>{data.clicks++;data.trusted&&=e.isTrusted;render()};
document.querySelector('#late').onclick=()=>{data.lateClicks++;render()};
document.querySelector('#arm').onclick=()=>setTimeout(()=>document.querySelector('#late').setAttribute('aria-label','Ready target'),1800);
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input role="searchbox" aria-label="Cari di bayangan">';render();
</script></html>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/frame') res.end('<!doctype html><title>Frame diagnostics QA</title><iframe src="/inner"></iframe>');
  else if (req.url === '/inner') res.end('<!doctype html><meta charset="utf-8"><input role="combobox" aria-label="Cari dalam bingkai">');
  else if (req.url === '/cap') res.end('<!doctype html><title>Capped diagnostics QA</title><input role="combobox" aria-label="Telusuri Google Maps"><div hidden>' + '<i></i>'.repeat(50100) + '</div>');
  else res.end(fixture);
});
const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anbo-locator-diagnostics-qa', version: '1' } });
  initialTabs = await ok('browser_tabs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  const tabId = await open('/main');
  const initial = await state(tabId);
  const wrong = await call('browser_type', { tabId, locator: role('combobox', 'Search Google Maps'), text: 'must not be typed' });
  check('wrong-language name never dispatches input or leaks the input value', wrong.error && message(wrong).includes('timeout') && !message(wrong).includes('fixture-private-value') && (await state(tabId)).inputEvents === 0, wrong);
  check('lookup timeout remains caller-controlled', wrong.wallMs >= 850 && wrong.wallMs < 4000, wrong.wallMs);
  check('direct-action error reports observed local name', baseline || (message(wrong).includes('Telusuri Google Maps') && message(wrong).includes('no input dispatched') && message(wrong).includes('not verified unique')), { baseline, observed: message(wrong).includes('Telusuri Google Maps') });
  const discovery = await ok('browser_find', { tabId, by: 'role', value: 'combobox', exact: true });
  check('only the observed local name matches', discovery.count === 1 && discovery.matches[0].name === 'Telusuri Google Maps', discovery.matches);
  await ok('browser_type', { tabId, locator: role('combobox', discovery.matches[0].name), text: 'Monas Jakarta' });
  check('recovery with observed locator dispatches once', (await state(tabId)).inputEvents === 1 && (await state(tabId)).value === 'Monas Jakarta');
  const ambiguous = await call('browser_type', { tabId, locator: role('textbox', 'Duplicate'), text: 'forbidden' });
  check('duplicate target is still rejected', ambiguous.error && message(ambiguous).includes('ambiguous_target'), ambiguous);
  const hidden = await call('browser_click', { tabId, locator: { ...css('#hidden'), timeout: 900 } });
  check('hidden target is diagnosed without relaxing visibility', hidden.error && (baseline || message(hidden).includes('not rendered')), hidden);
  check('hidden failure offers bounded visible alternatives for inspection only', baseline || (message(hidden).includes('Jalankan') && message(hidden).includes('inspection, not input') && message(hidden).includes('not equivalent or verified unique')), hidden);
  const hiddenInput = await call('browser_click', { tabId, locator: { ...css('#hidden'), includeHidden: true, timeout: 900 } });
  check('includeHidden never makes a hidden control actionable', hiddenInput.error && (await state(tabId)).clicks === 0 && (await state(tabId)).inputEvents === 1, hiddenInput);
  const unmet = await call('browser_wait', { tabId, locator: { by: 'css', value: '#search' }, state: 'unchecked', timeout: 500 });
  check('unmet state is not described as a missing target', unmet.error && !message(unmet).includes('confirmed absence') && (baseline || message(unmet).includes('element(s) matched')), unmet);
  const shadow = await call('browser_type', { tabId, locator: role('searchbox', 'Search shadow'), text: 'forbidden' });
  check('open-shadow mismatch gives observed name', shadow.error && (baseline || message(shadow).includes('Cari di bayangan')), shadow);
  await ok('browser_click', { tabId, locator: css('#arm') });
  const late = await ok('browser_click', { tabId, locator: role('button', 'Ready target', 4000) });
  check('a late matching label is still awaited and clicked once', late.ok && (await state(tabId)).lateClicks === 1, late);
  for (let i = 0; i < 25; i++) {
    for (const [scenario, name, args] of [
      ['find role/name, full scan', 'browser_find', { tabId, by: 'role', value: 'button', name: 'Jalankan', exact: true, limit: 20 }],
      ['type with direct locator', 'browser_type', { tabId, locator: role('combobox', 'Telusuri Google Maps'), text: 'value-' + i }],
      ['click with direct locator', 'browser_click', { tabId, locator: role('button', 'Jalankan') }],
    ]) {
      const r = await call(name, args);
      if (r.error) throw Error(JSON.stringify(r));
      samples.push({ scenario, warmup: i < 5, wallMs: r.wallMs, nativeMs: r.result.durationMs });
    }
  }
  const final = await state(tabId);
  check('heavy fixture, exact event counts and viewport preserved', initial.nodes >= 17000 && final.clicks === 25 && final.inputEvents === 26 && final.value === 'value-24' && final.trusted && initial.width === final.width && initial.height === final.height, { initial, final });
  await close(tabId);
  const frame = await open('/frame');
  const frameMiss = await call('browser_type', { tabId: frame, locator: role('combobox', 'Search frame'), text: 'forbidden' });
  check('child-frame mismatch gives observed name', frameMiss.error && (baseline || message(frameMiss).includes('Cari dalam bingkai')), frameMiss);
  await close(frame);
  const cap = await open('/cap');
  const capped = await call('browser_type', { tabId: cap, locator: role('combobox', 'Search Google Maps', 1800), text: 'forbidden' });
  check('incomplete coverage takes precedence over name hints', capped.error && message(capped).includes('nodeLimitReached=true') && !message(capped).includes('names seen here'), capped);
  await close(cap);
} catch (error) { checks.push({ name: 'suite completion', passed: false, detail: String(error) }); process.exitCode = 1; }
finally {
  for (const tabId of [...owned]) try { await close(tabId); } catch (error) { checks.push({ name: 'cleanup', passed: false, detail: String(error) }); }
  try {
    finalTabs = await ok('browser_tabs');
    const ids = response => response.tabs.map(tab => tab.tabId);
    checks.push({ name: 'original tabs retained', passed: Array.isArray(initialTabs?.tabs) && Array.isArray(finalTabs?.tabs) && ids(initialTabs).every(id => Number.isInteger(id) && ids(finalTabs).includes(id)) });
    checks.push({ name: 'owned tabs closed', passed: owned.size === 0 });
    const deleted = session && await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
    checks.push({ name: 'session closed', passed: !!deleted?.ok });
  } catch (error) { checks.push({ name: 'session cleanup', passed: false, detail: String(error) }); }
  server.closeAllConnections(); server.close();
  const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
  const summary = [...new Set(samples.map(s => s.scenario))].map(scenario => ({ scenario, ...stats(samples.filter(s => s.scenario === scenario && !s.warmup).map(s => s.wallMs)) }));
  await writeFile(output, JSON.stringify({ date: new Date().toISOString(), baseline, binaryHash, head, checks, summary, samples, calls, initialTabs, finalTabs }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, passed: checks.filter(c => c.passed).length, total: checks.length, summary }));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
