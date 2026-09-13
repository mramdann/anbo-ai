import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const arg = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? undefined : process.argv[index + 1]; };
const endpoint = new URL(arg('mcp-url'));
const workspace = arg('workspace'), output = arg('output'), label = arg('label');
const waitOnly = process.argv.includes('--wait-only');
const hitsOnly = process.argv.includes('--hits-only');
if (!workspace || !output || (waitOnly && hitsOnly) || !['before', 'after'].includes(label) || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') {
  throw Error('Pass --mcp-url loopback, --workspace, --label before|after and a fresh --output');
}
const calls = [], checks = [], summaries = [], owned = new Set(), pending = new Map();
let session, sequence = 0, origin, crossOrigin, initial;
async function rpc(method, params) {
  const response = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json', ...(session ? {'Mcp-Session-Id':session} : {})}, body:JSON.stringify({jsonrpc:'2.0', id:++sequence, method, params}), signal:AbortSignal.timeout(15000)});
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const result = await response.json();
  if (!response.ok || result.error) throw Error(JSON.stringify(result));
  return result.result;
}
async function call(name, args = {}) {
  const start = performance.now();
  const envelope = await rpc('tools/call', {name, arguments:args});
  const raw = envelope.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let result;
  try { result = JSON.parse(raw); } catch { result = {message:raw}; }
  const sample = {name, args, wallMs:performance.now() - start, result, error:envelope.isError === true};
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw Error(JSON.stringify(sample.result));
  return sample.result;
}
function check(name, passed, detail) {
  const result = {name, passed:!!passed, detail};
  checks.push(result);
  console.log(JSON.stringify(result));
}
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {n:sorted.length, p50:sorted[Math.ceil(sorted.length * .5) - 1], p95:sorted[Math.ceil(sorted.length * .95) - 1]};
}
function serve(req, res) {
  const url = new URL(req.url, 'http://fixture');
  const token = url.searchParams.get('token');
  if (url.pathname === '/command') {
    pending.set(token, res);
    res.on('close', () => pending.delete(token));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const kind = url.searchParams.get('kind');
  let body = '', script = '';
  if (url.pathname === '/scan') {
    const count = Number(url.searchParams.get('nodes'));
    if (![1000, 15000, 55000].includes(count)) { res.writeHead(400); res.end(); return; }
    body = '<i></i>'.repeat(count) + '<button id="target" data-testid="target">Benchmark target</button>';
  } else if (kind === 'frame') {
    body = `<iframe src="${crossOrigin}/?kind=main&token=${encodeURIComponent(token)}"></iframe>`;
  } else {
    body = '<div id="host"></div><input id="check" type="checkbox"><input id="rename" type="button" value="Waiting"><input id="field"><button id="existing">Existing target</button><button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>';
    script = `const kind=${JSON.stringify(kind)};const host=document.getElementById('host');let root=kind==='shadow'?host.attachShadow({mode:'open'}):host;
      fetch('/command?token=${encodeURIComponent(token)}').then(r=>r.text()).then(()=>{
        if(kind==='checked')document.getElementById('check').checked=true;
        else if(kind==='value')document.getElementById('rename').value='Ready target';
        else{if(kind==='late-shadow')root=host.attachShadow({mode:'open'});const button=document.createElement('button');button.id='target';button.textContent='Ready target';root.append(button);}
      });`;
  }
  res.end(`<!doctype html><meta charset="utf-8"><title>Locator cache fixture</title><style>i{display:none}iframe{width:600px;height:300px}</style>${body}<script>${script}</script>`);
}
const server = http.createServer(serve), frames = http.createServer(serve);
async function open(path) {
  const result = await ok('browser_open', {workspace, url:origin + path});
  owned.add(result.tabId);
  await ok('browser_wait', {tabId:result.tabId, condition:'load', loadState:'complete', timeout:5000});
  return result.tabId;
}
async function close(tabId) {
  const page = await ok('browser_get_url', {tabId});
  if (!page.url.startsWith(origin + '/')) throw Error('Owned tab changed origin; refusing cleanup');
  await ok('browser_close', {tabId, workspace, endSession:true});
  owned.delete(tabId);
}
try {
  await rpc('initialize', {protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'anbo-locator-cache-benchmark', version:'1'}});
  initial = await ok('browser_tabs');
  await Promise.all([new Promise(r => server.listen(0, '127.0.0.1', r)), new Promise(r => frames.listen(0, '127.0.0.1', r))]);
  origin = 'http://127.0.0.1:' + server.address().port;
  crossOrigin = 'http://127.0.0.1:' + frames.address().port;
  for (const nodes of waitOnly ? [] : [1000, 15000]) {
    const tabId = await open('/scan?nodes=' + nodes);
    const groups = new Map(['css', 'role', 'testId'].map(by => [by, []]));
    for (let round = 0; round < 35; round++) {
      for (const by of round % 2 ? ['testId', 'role', 'css'] : ['css', 'role', 'testId']) {
        const sample = await call('browser_find', {tabId, by, value:by === 'css' ? '#target' : by === 'role' ? 'button' : 'target', ...(by === 'role' ? {name:'Benchmark target'} : {}), exact:true, limit:1, timeout:3000});
        sample.scenario = {nodes, round, warmup:round < 5};
        if (round >= 5) groups.get(by).push(sample);
      }
    }
    for (const [by, samples] of groups) {
      check(`hit ${nodes} ${by}`, samples.every(s => !s.error && s.result.count === 1 && s.result.nodeLimitReached === false));
      const valid = samples.filter(s => !s.error);
      const summary = {kind:'hit', nodes, by, wallMs:stats(valid.map(s => s.wallMs)), nativeMs:stats(valid.map(s => s.result.durationMs))};
      summaries.push(summary); console.log(JSON.stringify(summary));
    }
    await close(tabId);
  }
  for (const kind of hitsOnly ? [] : ['main', 'shadow', 'late-shadow', 'frame', 'checked', 'value', 'absent']) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const token = `${kind}-${repeat}`;
      const tabId = await open(`/?kind=${kind}&token=${token}`);
      const deadline = Date.now() + 3000;
      while (!pending.has(token) && Date.now() < deadline) await delay(20);
      if (!pending.has(token)) throw Error('Fixture command was not connected');
      const args = {tabId, by:kind === 'value' ? 'role' : 'css', value:kind === 'checked' ? 'input:checked' : kind === 'value' ? 'button' : '#target', ...(kind === 'value' ? {name:'Ready target'} : {}), exact:true, limit:1, timeout:3000};
      const {tabId:targetTab, timeout, limit:_limit, ...locator} = args;
      const finding = call(waitOnly ? 'browser_wait' : 'browser_find', waitOnly ? {tabId:targetTab, locator, state:'visible', timeout} : args);
      if (kind !== 'absent') {
        await delay(500);
        pending.get(token)?.end('change');
      }
      const sample = await finding;
      const present = !sample.error && sample.result.count === 1;
      summaries.push({kind, repeat, wallMs:sample.wallMs, nativeMs:sample.result.durationMs, present, error:sample.error ? sample.result : null});
      check(`${kind} ${repeat}`, kind === 'absent' ? sample.error && /\[timeout\]/.test(JSON.stringify(sample.result)) : present, {wallMs:sample.wallMs, present, result:sample.result});
      await close(tabId);
    }
  }
  const tabId = await open('/?kind=absent&token=guards');
  const first = await ok('browser_find', {tabId, by:'css', value:'#field', limit:1});
  await ok('browser_find', {tabId, by:'css', value:'#existing', limit:1});
  const typed = await call('browser_type', {tabId, ref:first.matches[0].ref, text:'retained ref'});
  const read = await ok('browser_get_property', {tabId, ref:first.matches[0].ref, properties:['value']});
  check('retained ref still types', !typed.error && JSON.stringify(read).includes('retained ref'), read);
  const ambiguous = await call('browser_click', {tabId, locator:{by:'css', value:'.duplicate'}});
  check('ambiguous locator never dispatches', ambiguous.error && /ambiguous_target/.test(JSON.stringify(ambiguous.result)), ambiguous.result);
  await close(tabId);
  const capped = await open('/scan?nodes=55000');
  const cap = await call('browser_find', {tabId:capped, by:'css', value:'#target', timeout:400});
  check('node cap remains incomplete', cap.error && /nodeLimitReached=true/.test(JSON.stringify(cap.result)), cap.result);
  await close(capped);
} catch (error) {
  check('suite completed', false, String(error));
} finally {
  for (const tabId of [...owned]) {
    try { await close(tabId); } catch (error) { check('cleanup', false, String(error)); }
  }
  try {
    const final = await ok('browser_tabs');
    check('original browser tabs retained', initial?.tabs.every(t => final.tabs.some(a => a.tabId === t.tabId)));
    check('owned tabs closed', owned.size === 0);
  } catch (error) { check('final inspection', false, String(error)); }
  if (session) {
    try { const response = await fetch(endpoint, {method:'DELETE', headers:{'Mcp-Session-Id':session}}); check('MCP session closed', response.ok); }
    catch (error) { check('MCP session closed', false, String(error)); }
  }
  for (const listener of [server, frames]) listener.closeAllConnections();
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => frames.close(r))]);
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify({label, timestamp:new Date().toISOString(), endpoint:String(endpoint), method:waitOnly ? 'Native locator waits; 3 delayed mutations per case; no window changes' : hitsOnly ? 'Native hit replication; 5 warmups + 30 hit samples; no window changes' : 'Sequential native MCP; 5 warmups + 30 hit samples; 3 delayed mutations per case; no window changes', checks, summaries, calls}, null, 2), {flag:'wx'});
  console.log(JSON.stringify({output, passed:checks.filter(c => c.passed).length, total:checks.length}));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
