import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? undefined : process.argv[index + 1]; };
const output = arg('output'), workspace = arg('workspace'), binary = arg('binary');
const smoke = arg('smoke') === 'true';
if (!output?.endsWith('.json') || !workspace || !binary) throw Error('Fresh --output JSON, --workspace and --binary required');
const endpoint = 'http://127.0.0.1:7332/mcp', samples = [], checks = [];
let sequence = 0, session, tabId, origin, initialTabs;
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
const binaryHash = await hash();
const server = http.createServer((request, response) => {
  const mode = new URL(request.url, 'http://localhost').searchParams.get('mode') ?? 'empty';
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  const declared = ['declared-sync', 'declared-late-node', 'delayed-350', 'native-delayed-250'].includes(mode);
  response.end(`<!doctype html><meta charset="utf-8"><title>Autocomplete fixture</title><style>body{margin:20px;font:16px sans-serif}input,button{padding:8px}#state{display:block;white-space:pre}</style>
  <input id="query" ${mode === 'plain' ? '' : 'role="combobox"'} aria-label="Query" ${declared ? 'aria-controls="suggestions"' : ''} value="${mode === 'append' ? 'old' : ''}"><div id="container"></div><output id="state"></output>
  <script>
  const mode=${JSON.stringify(mode)},q=document.querySelector('#query'),container=document.querySelector('#container');let timer,inputs=0,changes=0,keys=0,chosen='';
  function state(){document.querySelector('#state').textContent=JSON.stringify({value:q.value,inputs,changes,keys,chosen,width:innerWidth,height:innerHeight})}
  function show(name){container.innerHTML='<div id="suggestions" role="listbox"><div role="option"></div></div>';const option=container.querySelector('[role=option]');option.textContent=name;option.onclick=()=>{chosen=name;state()};state()}
  if(mode==='preexisting')show('Unrelated old suggestion');
  if(['declared-sync','delayed-350','native-delayed-250'].includes(mode))container.innerHTML='<div id="suggestions" role="listbox" hidden></div>';
  q.oninput=e=>{inputs++;clearTimeout(timer);if(mode==='undeclared-sync'||mode==='declared-sync')show('Result '+q.value);if(mode==='declared-late-node')timer=setTimeout(()=>show('Result '+q.value),30);if(mode==='delayed-350')timer=setTimeout(()=>show('Result '+q.value),350);if(mode==='native-delayed-250'&&e.isTrusted)timer=setTimeout(()=>show('Result '+q.value),250);state()};
  q.onchange=()=>{changes++;state()};q.onkeydown=()=>{keys++;state()};state();
  </script>`);
});
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(15000) });
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const value = await response.json();
  if (!response.ok || value.error) throw Error(JSON.stringify(value.error ?? response.status));
  return value.result;
}
async function call(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  const raw = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (response.isError) throw Error(raw);
  return JSON.parse(raw);
}
const check = (name, passed, detail) => { checks.push({ name, passed: !!passed, detail }); console.log(JSON.stringify(checks.at(-1))); };
let environment;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-autocomplete-benchmark', version: '1' } });
  await call('skills_read', { workspace, name: 'anbo' }); initialTabs = await call('browser_tabs');
  tabId = (await call('browser_open', { workspace, url: origin + '/?mode=plain' })).tabId;
  for (const mode of ['plain', 'declared-sync', 'undeclared-sync', 'declared-late-node', 'delayed-350', 'native-delayed-250', 'empty', 'append', 'preexisting']) {
    for (let iteration = 0; iteration < (smoke ? 1 : 5); iteration++) {
      await call('browser_navigate', { tabId, url: origin + '/?mode=' + mode });
      await call('browser_wait', { tabId, condition: 'load', loadState: 'complete', timeout: 5000 });
      const ref = (await call('browser_find', { tabId, by: 'css', value: '#query', limit: 1 })).matches[0].ref;
      const started = performance.now();
      const result = await call('browser_type', { tabId, ref, text: 'test', ...(mode === 'append' ? { append: true } : {}), diagnostics: true });
      const wallMs = performance.now() - started;
      const data = JSON.parse((await call('browser_get_text', { tabId, locator: { by: 'css', value: '#state' } })).text);
      if (!environment) environment = { width: data.width, height: data.height };
      const expectedHints = !['plain', 'empty', 'append', 'preexisting'].includes(mode);
      const item = result.revealed?.items?.find(item => item.name === 'Result test');
      let actionable = !expectedHints;
      if (item) {
        await call('browser_click', { tabId, ref: item.ref, reveal: 0 });
        const clicked = JSON.parse((await call('browser_get_text', { tabId, locator: { by: 'css', value: '#state' } })).text);
        actionable = clicked.chosen === 'Result test';
      }
      const valid = result.valueVerified && data.value === (mode === 'append' ? 'oldtest' : 'test') && (expectedHints ? !!item && actionable : !result.revealed?.count);
      samples.push({ mode, iteration, warmup: !smoke && iteration === 0, wallMs, backendMs: result.durationMs, valid, actionable, nativeRetype: result.nativeRetype === true, timings: result.timings, hintCount: result.revealed?.count ?? 0, data });
      if (data.width !== environment.width || data.height !== environment.height) throw Error('Viewport changed');
    }
    const rows = samples.filter(s => s.mode === mode);
    check(mode + ' exact value and actionable/absent hints', rows.every(s => s.valid), { successes: rows.filter(s => s.valid).length, total: rows.length });
  }
  check('binary unchanged', await hash() === binaryHash, binaryHash);
} catch (error) { check('suite completed', false, String(error)); }
finally {
  if (tabId) try {
    const page = await call('browser_page_info', { tabId });
    if (!page.url.startsWith(origin + '/')) throw Error('Owned fixture changed origin');
    await call('browser_close', { tabId, workspace, endSession: true });
  } catch (error) { check('cleanup', false, String(error)); }
  if (initialTabs) try { const final = await call('browser_tabs'); check('original tabs retained', JSON.stringify(initialTabs.tabs.map(t => t.tabId).sort()) === JSON.stringify(final.tabs.map(t => t.tabId).sort())); } catch (error) { check('tabs', false, String(error)); }
  if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
const stats = rows => { const values = rows.map(s => s.wallMs).sort((a, b) => a - b); return { n: values.length, p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1] }; };
const summary = [...new Set(samples.map(s => s.mode))].map(mode => { const rows = samples.filter(s => s.mode === mode && !s.warmup); return { mode, ...stats(rows), passed: rows.filter(s => s.valid).length, replays: rows.filter(s => s.nativeRetype).length }; });
await writeFile(output, JSON.stringify({ date: new Date().toISOString(), binaryHash, environment, checks, summary, samples, method: smoke ? 'Single-sample correctness smoke per mode, not a latency benchmark.' : 'Local fixture loaded before timed type; one warmup and four measured samples per mode. Fresh document per sample, input ref prepared before timer. diagnostics enabled. No external network or window changes.' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, summary }));
if (checks.some(c => !c.passed)) process.exitCode = 1;
