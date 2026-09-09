import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output');
if (!workspace || !output || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Pass --mcp-url loopback, --workspace and a fresh --output');
const calls = [], checks = [], owned = new Set(), controls = new Map(), commands = new Map(), benchmarks = [];
let sequence = 0, session, origin, frameOrigin, before;
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(20000) });
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const envelope = await response.json();
  if (!response.ok || envelope.error) throw Error(JSON.stringify(envelope.error ?? { status: response.status }));
  return envelope.result;
}
async function call(name, args = {}) {
  const start = performance.now(); let result, error;
  try {
    const envelope = await rpc('tools/call', { name, arguments: args });
    const raw = envelope.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { result = JSON.parse(raw); } catch { result = { message: raw }; }
    if (envelope.isError) error = result;
    if (result.controlId && args.tabId) controls.set(args.tabId, result.controlId);
  } catch (cause) { error = String(cause); }
  const sample = { name, args, wallMs: performance.now() - start, result, error }; calls.push(sample); return sample;
}
async function ok(name, args) { const sample = await call(name, args); if (sample.error) throw Error(JSON.stringify(sample.error)); return sample.result; }
function check(name, passed, detail) { const item = { name, passed: !!passed, detail }; checks.push(item); console.log(JSON.stringify(item)); }
async function scenario(name, fn) { try { await fn(); } catch (cause) { check(name, false, String(cause)); } }
const html = body => `<!doctype html><meta charset="utf-8"><title>Ref destination fixture</title><style>body{font:16px sans-serif;margin:16px}a,button,input{display:block;padding:10px;margin:6px}iframe{width:420px;height:280px}output{display:block}</style>${body}`;
function serve(req, res) {
  const url = new URL(req.url, 'http://fixture'); res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/command') { const id = url.searchParams.get('id'); commands.set(id, res); res.on('close', () => commands.delete(id)); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/parent') return res.end(html(`<iframe src="${url.searchParams.get('cross') === 'true' ? frameOrigin : origin}/fixture?${url.searchParams}"></iframe>`));
  const id = url.searchParams.get('id'), mode = url.searchParams.get('mode'), shadow = url.searchParams.get('shadow') === 'true';
  res.end(html(`<div id="host"></div><script>
    const root = ${shadow ? "document.getElementById('host').attachShadow({mode:'open'})" : "document.getElementById('host')"};
    root.innerHTML = '<a id="target" href="/first"><span id="child">Original link</span></a><button id="button">Play</button><input id="input" value="initial"><output id="state">INITIAL</output><output id="count">clicks:0</output>';
    const link = root.querySelector('#target'), child = root.querySelector('#child'), button = root.querySelector('#button'), input = root.querySelector('#input');
    let clicks = 0;
    for (const target of [link, button]) target.onclick = event => { event.preventDefault(); root.querySelector('#count').textContent = 'clicks:' + ++clicks; };
    const mode = ${JSON.stringify(mode)};
    if (mode?.startsWith('context')) {
      const item = document.createElement(mode.includes('custom') ? 'fixture-result' : 'article');
      item.id = 'item';
      root.prepend(item); item.append(link, button, input);
      if (mode.includes('custom')) root.append(document.createElement('fixture-result'));
      if (mode.includes('identity')) { item.setAttribute('data-item-id', 'one'); link.remove(); }
      if (mode.includes('hover')) button.onmouseenter = () => { link.href = '/second'; };
      button.onclick = event => { event.preventDefault(); root.querySelector('#count').textContent = 'clicks:' + ++clicks; };
    }
    if (mode === 'add') link.removeAttribute('href');
    if (mode === 'base') link.setAttribute('href', 'relative');
    if (mode === 'slot') { const host = document.createElement('div'); root.append(host); const shadow = host.attachShadow({mode:'open'}); shadow.innerHTML = '<a id="slotted-link" href="/first"><slot></slot></a>'; shadow.querySelector('a').onclick = link.onclick; host.append(child); }
    if (mode === 'hover') link.onmouseenter = () => { link.href = '/second'; root.querySelector('#state').textContent = 'MUTATED'; };
    if (mode === 'focus') link.onfocus = () => { link.href = '/second'; root.querySelector('#state').textContent = 'FOCUS MUTATED'; };
    if (mode === 'double') { const record = link.onclick; link.onclick = event => { record(event); link.href = '/second'; }; }
    fetch('/command?id=${id}').then(r => r.json()).then(() => {
      if (mode === 'context-identity') root.querySelector('#item').setAttribute('data-item-id', 'two');
      else if (mode === 'context-text') { child.textContent = 'Updated clock 00:02'; button.textContent = 'Pause'; input.value = 'updated'; }
      else if (mode === 'text') { child.textContent = 'Updated clock 00:02'; button.textContent = 'Pause'; input.value = 'updated'; }
      else if (mode === 'equivalent') link.setAttribute('href', new URL('/first', location.href).href);
      else if (mode === 'remove') link.removeAttribute('href');
      else if (mode === 'base') { const base = document.createElement('base'); base.href = '/changed/'; document.head.append(base); }
      else if (mode === 'slot') root.querySelector('div').shadowRoot.querySelector('a').href = '/second';
      else if (mode === 'query') link.href = '/first?video=other';
      else if (mode === 'fragment') link.href = '/first#other';
      else { link.href = '/second'; child.textContent = 'Different link'; }
      root.querySelector('#state').textContent = 'MUTATED';
    });
  </script>`));
}
const server = http.createServer(serve), frameServer = http.createServer(serve);
async function open(path) {
  const result = await ok('browser_open', { workspace, url: origin + path }); owned.add(result.tabId);
  if (result.controlId) controls.set(result.tabId, result.controlId);
  await ok('browser_wait', { tabId: result.tabId, condition: 'load', loadState: 'complete', timeout: 6000 }); return result.tabId;
}
async function find(tabId, selector) { return (await ok('browser_find', { tabId, by: 'css', value: selector, limit: 1, timeout: 3000 })).matches[0]; }
async function read(tabId, ref) { return (await ok('browser_get_text', { tabId, ref, maxLength: 1000 })).text; }
async function mutate(tabId, id, shadow = false) {
  const deadline = Date.now() + 3000; while (!commands.has(id) && Date.now() < deadline) await delay(25);
  if (!commands.has(id)) throw Error('Fixture command missing');
  commands.get(id).end('{}');
  await ok('browser_wait', shadow ? { tabId, waitFor: { text: 'MUTATED', timeout: 3000 } } : { tabId, condition: 'text', text: 'MUTATED', timeout: 3000 });
}
async function close(tabId) {
  const current = await ok('browser_get_url', { tabId }); if (!current.url.startsWith(origin + '/')) throw Error('Owned tab changed origin; refusing cleanup');
  if (controls.has(tabId)) await ok('browser_end_session', { tabId, controlId: controls.get(tabId) });
  await ok('browser_close', { tabId, workspace }); owned.delete(tabId);
}
function stats(samples) { const sorted = [...samples].sort((a, b) => a - b); return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; }
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anbo-ref-destination-smoke', version: '1' } });
  await ok('skills_read', { workspace, name: 'anbo' }); before = await ok('browser_tabs', {});
  await Promise.all([new Promise(r => server.listen(0, '127.0.0.1', r)), new Promise(r => frameServer.listen(0, '127.0.0.1', r))]);
  origin = 'http://127.0.0.1:' + server.address().port; frameOrigin = 'http://127.0.0.1:' + frameServer.address().port;
  const cases = [
    ['main', 'href', '#target'], ['descendant', 'href', '#child'], ['shadow', 'href', '#target'],
    ['same-frame', 'href', '#target'], ['cross-frame', 'href', '#target'], ['main', 'add', '#target'],
    ['main', 'remove', '#target'], ['main', 'base', '#target'], ['main', 'query', '#target'],
    ['main', 'fragment', '#target'], ['main', 'slot', '#child'],
  ];
  for (const [scope, mode, selector] of cases) await scenario(scope + ' ' + mode, async () => {
    const id = scope + '-' + mode, frame = scope.endsWith('frame');
    const tabId = await open(`${frame ? '/parent' : '/fixture'}?id=${id}&mode=${mode}&shadow=${scope === 'shadow'}&cross=${scope === 'cross-frame'}`);
    const target = await find(tabId, selector); await mutate(tabId, id, scope === 'shadow');
    const reading = await call('browser_get_text', { tabId, ref: target.ref });
    check(id + ' rejects changed destination on read', /stale_ref/.test(JSON.stringify(reading.error)), reading);
    const clicking = await call('browser_click', { tabId, ref: target.ref, diagnostics: true });
    check(id + ' rejects changed destination on click', /stale_ref/.test(JSON.stringify(clicking.error)), clicking);
    const count = await read(tabId, (await find(tabId, '#count')).ref);
    check(id + ' no click side effect', count === 'clicks:0', count);
    await ok('browser_click', { tabId, ref: (await find(tabId, selector)).ref });
    const updated = await read(tabId, (await find(tabId, '#count')).ref);
    check(id + ' fresh ref clicks exactly once', updated === 'clicks:' + (Number(count.split(':')[1]) + 1), updated);
    await close(tabId);
  });
  for (const mode of ['text', 'equivalent']) await scenario('compatible ' + mode, async () => {
    const tabId = await open('/fixture?id=' + mode + '&mode=' + mode);
    const target = await find(tabId, '#target'); await mutate(tabId, mode);
    const reading = await call('browser_get_text', { tabId, ref: target.ref });
    check(mode + ' preserves current link ref', !reading.error && reading.result.text === (mode === 'text' ? 'Updated clock 00:02' : 'Original link'), reading);
    const clicking = await call('browser_click', { tabId, ref: target.ref });
    check(mode + ' current ref still clicks', !clicking.error, clicking);
    await close(tabId);
  });
  await scenario('hover destination change', async () => {
    const tabId = await open('/fixture?id=hover&mode=hover');
    const target = await find(tabId, '#target');
    const click = await call('browser_click', { tabId, ref: target.ref, diagnostics: true });
    check('hover mutation rejects before mouse down', /stale_ref/.test(JSON.stringify(click.error)), click);
    check('hover mutation has no click side effect', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:0');
    await close(tabId);
  });
  await scenario('snapshot destination guard', async () => {
    const tabId = await open('/fixture?id=snapshot&mode=href');
    const snapshot = await ok('browser_snapshot', { tabId, maxChars: 4000 });
    const ref = snapshot.snapshot.match(/\[(g[\w-]+)\] <a> Original link/)?.[1];
    if (!ref) throw Error('Snapshot link ref missing');
    await mutate(tabId, 'snapshot');
    const click = await call('browser_click', { tabId, ref });
    check('snapshot link rejects changed destination', /stale_ref/.test(JSON.stringify(click.error)), click);
    check('snapshot link has no click side effect', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:0');
    await close(tabId);
  });
  for (const scope of ['same-frame', 'cross-frame']) await scenario('focus mutation ' + scope, async () => {
    const tabId = await open(`/parent?id=focus-${scope}&mode=focus&cross=${scope === 'cross-frame'}`);
    const click = await call('browser_click', { tabId, ref: (await find(tabId, '#target')).ref });
    check(scope + ' focus handler really changed the destination', await read(tabId, (await find(tabId, '#state')).ref) === 'FOCUS MUTATED');
    check(scope + ' focus mutation rejects before click', /stale_ref/.test(JSON.stringify(click.error)), click);
    check(scope + ' focus mutation has no click side effect', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:0');
    await close(tabId);
  });
  for (const scope of ['main', 'cross-frame']) await scenario('double click mutation ' + scope, async () => {
    const tabId = await open(`${scope === 'main' ? '/fixture' : '/parent'}?id=double-${scope}&mode=double&cross=true`);
    const click = await call('browser_double_click', { tabId, ref: (await find(tabId, '#target')).ref });
    check(scope + ' second click rejects a changed destination', /stale_ref/.test(JSON.stringify(click.error)), click);
    check(scope + ' partial double click is reported', /1 click\(s\) already dispatched/.test(JSON.stringify(click.error)), click);
    check(scope + ' changed destination gets no second click', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:1');
    await close(tabId);
  });
  await scenario('dynamic controls', async () => {
    const tabId = await open('/fixture?id=dynamic&mode=text');
    const found = await ok('browser_find', { tabId, by: 'css', value: '#button, #input', limit: 2, timeout: 3000 });
    const button = found.matches.find(m => m.tag === 'button'), input = found.matches.find(m => m.tag === 'input');
    await mutate(tabId, 'dynamic');
    check('dynamic button text stays readable', await read(tabId, button.ref) === 'Pause');
    const clicked = await call('browser_click', { tabId, ref: button.ref, diagnostics: true });
    check('dynamic button uses one combined pointer and identity guard', !clicked.error && clicked.result.timings.filter(t => t.phase === 'pointerGuard').length === 1, clicked);
    const typed = await call('browser_type', { tabId, ref: input.ref, text: 'verified value' });
    check('dynamic input keeps its ref', !typed.error && typed.result.valueVerified === true, typed);
    await close(tabId);
  });
  for (const [scope, mode] of [['main', 'context'], ['shadow', 'context'], ['same-frame', 'context'], ['cross-frame', 'context'], ['main', 'context-custom'], ['main', 'context-identity']]) await scenario(scope + ' ' + mode, async () => {
    const id = scope + '-' + mode;
    const tabId = await open(`${scope.endsWith('frame') ? '/parent' : '/fixture'}?id=${id}&mode=${mode}&shadow=${scope === 'shadow'}&cross=${scope === 'cross-frame'}`);
    const target = await find(tabId, '#button'); await mutate(tabId, id, scope === 'shadow');
    const click = await call('browser_click', { tabId, ref: target.ref, diagnostics: true });
    check(id + ' reused item control rejected', /stale_ref/.test(JSON.stringify(click.error)), click);
    check(id + ' no wrong item click', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:0');
    await ok('browser_click', { tabId, ref: (await find(tabId, '#button')).ref });
    check(id + ' fresh item control works once', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:1');
    await close(tabId);
  });
  await scenario('context hover mutation', async () => {
    const tabId = await open('/fixture?id=context-hover&mode=context-hover');
    const click = await call('browser_click', { tabId, ref: (await find(tabId, '#button')).ref, diagnostics: true });
    check('context changed on hover rejected', /stale_ref/.test(JSON.stringify(click.error)), click);
    check('context hover causes no click', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:0');
    await close(tabId);
  });
  await scenario('context dynamic labels', async () => {
    const tabId = await open('/fixture?id=context-text&mode=context-text');
    const found = await ok('browser_find', { tabId, by: 'css', value: '#button, #input', limit: 2 });
    await mutate(tabId, 'context-text');
    const button = found.matches.find(m => m.tag === 'button'), input = found.matches.find(m => m.tag === 'input');
    check('item toggle label remains valid', await read(tabId, button.ref) === 'Pause');
    await ok('browser_click', { tabId, ref: button.ref });
    const typed = await ok('browser_type', { tabId, ref: input.ref, text: 'retained input' });
    check('item input value remains valid', typed.valueVerified === true);
    await close(tabId);
  });
  await scenario('post-dispatch timeout does not replay input', async () => {
    const tabId = await open('/fixture?id=no-replay');
    const click = await call('browser_click', { tabId, ref: (await find(tabId, '#button')).ref, waitFor: { text: 'NEVER PRESENT', timeout: 500 }, diagnostics: true });
    check('dispatched click reports failed postcondition', /timeout/.test(JSON.stringify(click.error)) && /dispatch/i.test(JSON.stringify(click.error)), click);
    check('failed click postcondition dispatches exactly once', await read(tabId, (await find(tabId, '#count')).ref) === 'clicks:1');
    await close(tabId);
  });
  for (const selector of ['#target', '#button']) await scenario('benchmark ' + selector, async () => {
    const tabId = await open('/fixture?id=benchmark-' + selector.slice(1));
    const target = await find(tabId, selector);
    for (const tool of ['browser_get_text', 'browser_click']) {
      const samples = [];
      for (let i = 0; i < 35; i++) {
        const result = await call(tool, { tabId, ref: target.ref, ...(tool === 'browser_click' ? { diagnostics: true } : {}) });
        if (result.error) throw Error(JSON.stringify(result));
        if (i >= 5) samples.push(result);
      }
      const metric = { selector, tool, wallMs: stats(samples.map(s => s.wallMs)), durationMs: stats(samples.map(s => s.result.durationMs)) };
      benchmarks.push(metric); check('benchmark completes ' + selector + ' ' + tool, samples.length === 30, metric);
    }
    await close(tabId);
  });
} catch (cause) { check('suite completed', false, String(cause)); }
finally {
  for (const tabId of [...owned]) try { await close(tabId); } catch (cause) { check('cleanup', false, { tabId, error: String(cause) }); }
  const after = await call('browser_tabs', {});
  check('original tabs retained', !after.error && before?.tabs.every(t => after.result.tabs.some(a => a.tabId === t.tabId)));
  check('owned tabs closed', owned.size === 0);
  if (session) try { const r = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) }); check('session closed', r.ok); } catch (cause) { check('session closed', false, String(cause)); }
  server.closeAllConnections(); frameServer.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => frameServer.close(r))]);
  await writeFile(output, JSON.stringify({ timestamp: new Date().toISOString(), endpoint: String(endpoint), workspace, checks, benchmarks, calls, unclosedTabs: [...owned] }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, passed: checks.filter(c => c.passed).length, total: checks.length }));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
