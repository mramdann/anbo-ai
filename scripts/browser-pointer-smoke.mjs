import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output');
if (!workspace || !output || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Pass --mcp-url loopback, --workspace and a fresh --output');
const calls = [], checks = [], requests = [], owned = new Set(), controls = new Map();
let sequence = 0, session, origin, before, after, benchmark;
async function rpc(method, params) {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(35000) });
  if (method === 'initialize') session = r.headers.get('Mcp-Session-Id');
  const value = await r.json(); if (!r.ok || value.error) throw Error(JSON.stringify(value.error)); return value.result;
}
async function call(name, args = {}) {
  const start = performance.now(); let result, error;
  try {
    const envelope = await rpc('tools/call', { name, arguments: args });
    const text = envelope.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { result = JSON.parse(text); } catch { result = { message: text }; }
    if (envelope.isError) error = result;
    const tabId = args.tabId ?? result?.tabId;
    if (tabId && result?.controlId) controls.set(tabId, result.controlId);
  } catch (cause) { error = String(cause); }
  const record = { name, args, wallMs: performance.now() - start, result, error }; calls.push(record); return record;
}
async function ok(name, args) { const r = await call(name, args); if (r.error) throw Error(JSON.stringify(r)); return r.result; }
function check(name, passed, detail) { const item = { name, passed: !!passed, detail }; checks.push(item); console.log(JSON.stringify(item)); }
async function scenario(name, fn) { try { await fn(); } catch (cause) { check(name, false, String(cause)); } }
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const mode = new URL(request.url, 'http://fixture').searchParams.get('mode') || 'visible';
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
  response.end(`<!doctype html><meta charset="utf-8"><title>Pointer fixture</title>
  <style>body{margin:0;font:14px sans-serif;height:2000px;scroll-behavior:smooth}button{width:120px;height:40px}#target{position:absolute;left:30px;top:70vh}#log{position:fixed;left:5px;top:5px;white-space:pre-wrap;pointer-events:none}#scroll{position:absolute;top:130px;width:320px;height:160px;overflow:auto;scroll-behavior:smooth}#scroll #target{position:static;margin-top:500px;margin-bottom:120px}#cover{position:fixed;inset:0;background:#eee;z-index:5}</style>
  <button id="target">Target</button><output id="log"></output>
  <script>
  const mode=${JSON.stringify(mode)}, target=document.querySelector('#target');
  const data={token:crypto.randomUUID(),down:0,clicks:0,last:null,route:'initial',scrollY:0,nestedScroll:0};
  const render=()=>{data.scrollY=scrollY;data.nestedScroll=document.querySelector('#scroll')?.scrollTop??0;document.querySelector('#log').textContent=JSON.stringify(data)};
  document.addEventListener('pointerdown',event=>{data.down++;data.last=event.target.id;data.trusted=event.isTrusted;render()},true);
  if(mode==='nested'){const scroller=document.createElement('div');scroller.id='scroll';document.body.append(scroller);scroller.append(target)}
  if(['move','cover','disable','hide'].includes(mode)) target.addEventListener('mouseenter',()=>{
    if(mode==='move')target.style.left='240px';
    if(mode==='cover'){const cover=document.createElement('div');cover.id='cover';document.body.append(cover)}
    if(mode==='disable')target.disabled=true;
    if(mode==='hide')target.style.opacity='0';
    data.changed=mode;render();
  },{once:true});
  target.onclick=()=>{
    data.clicks++;
    if(mode==='double')target.style.left='240px';
    if(mode==='spa'){history.pushState({},'', '/spa/details?kept=1#reviews');data.route='detail'}
    render();
  };
  addEventListener('popstate',()=>{data.route=location.pathname==='/spa/details'?'detail':'initial';render()});
  render();
  </script>`);
});
async function open(mode) {
  const result = await ok('browser_open', { workspace, url: origin + '/case?mode=' + mode }); owned.add(result.tabId);
  await ok('browser_wait', { tabId: result.tabId, condition: 'load', loadState: 'complete', timeout: 6000 }); return result.tabId;
}
async function find(tabId) { return (await ok('browser_find', { tabId, by: 'css', value: '#target', limit: 1, timeout: 2000 })).matches[0].ref; }
async function state(tabId) {
  const result = await ok('browser_find', { tabId, by: 'css', value: '#log', limit: 1 });
  return JSON.parse((await ok('browser_get_text', { tabId, ref: result.matches[0].ref, maxLength: 2000 })).text);
}
async function close(tabId) {
  if (controls.has(tabId)) await ok('browser_end_session', { tabId, controlId: controls.get(tabId) });
  await ok('browser_close', { tabId, workspace }); owned.delete(tabId);
}
async function uiUrl(tabId, expected) {
  let tab; const deadline = Date.now() + 2500;
  do { tab = (await ok('browser_tabs', {})).tabs.find(t => t.tabId === tabId); if (tab?.url === expected) return true; await delay(100); } while (Date.now() < deadline);
  return false;
}
const stats = samples => { const s = [...samples].sort((a,b) => a-b); return { n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1] }; };
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anbo-pointer-smoke', version: '1' } });
  await ok('skills_read', { workspace, name: 'anbo' }); before = await ok('browser_tabs', {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  for (const mode of ['visible','nested']) await scenario(mode, async () => {
    const tabId = await open(mode);
    const result = await call('browser_click', { tabId, ref: await find(tabId), diagnostics: true });
    const data = await state(tabId);
    check(mode + ' native click activates the correct target once', !result.error && data.clicks === 1 && data.down === 1 && data.last === 'target' && data.trusted, { result, data });
    check(mode + ' scroll reaches the target without shifting the document', data.scrollY === 0 && (mode === 'visible' ? data.nestedScroll === 0 : data.nestedScroll > 0), data);
    check(mode + ' one bounded pre-press guard', result.result?.timings?.filter(t => t.phase === 'pointerGuard').length === 1, result);
    await close(tabId);
  });
  for (const mode of ['move','cover','disable','hide']) await scenario(mode, async () => {
    const tabId = await open(mode);
    const result = await call('browser_click', { tabId, ref: await find(tabId), diagnostics: true });
    const data = await state(tabId);
    check(mode + ' rejects changed target before mouse down', /input_not_ready/.test(JSON.stringify(result.error)) && data.down === 0 && data.clicks === 0 && data.changed === mode, { result, data });
    check(mode + ' never retries mouse input', !result.result?.timings?.some(t => t.phase === 'mouseDown') && data.down === 0, result);
    if (mode === 'move') {
      await ok('browser_click', { tabId, ref: await find(tabId) });
      const fresh = await state(tabId); check('explicit recovery reaches moved target exactly once', fresh.clicks === 1 && fresh.down === 1 && fresh.last === 'target', fresh);
    }
    await close(tabId);
  });
  await scenario('double', async () => {
    const tabId = await open('double');
    const result = await call('browser_double_click', { tabId, ref: await find(tabId) });
    const data = await state(tabId);
    check('second press rejected after first click moves target', /input_not_ready/.test(JSON.stringify(result.error)) && /1 click\(s\) already dispatched/.test(JSON.stringify(result.error)) && data.clicks === 1 && data.down === 1, { result, data });
    await close(tabId);
  });
  await scenario('SPA metadata and retained document', async () => {
    const tabId = await open('spa'), initial = await state(tabId), initialUrl = origin + '/case?mode=spa', nextUrl = origin + '/spa/details?kept=1#reviews';
    const ref = await find(tabId);
    await ok('browser_click', { tabId, ref, waitFor: { url: nextUrl, timeout: 3000 } });
    check('background SPA source reaches tab metadata without a title change', await uiUrl(tabId, nextUrl));
    check('same-document URL changes preserve current refs', !(await call('browser_get_text', { tabId, ref })).error);
    await ok('browser_back', { tabId }); await ok('browser_wait', { tabId, waitFor: { url: initialUrl, timeout: 3000 } });
    check('SPA back reaches tab metadata', await uiUrl(tabId, initialUrl));
    await ok('browser_forward', { tabId }); await ok('browser_wait', { tabId, waitFor: { url: nextUrl, timeout: 3000 } });
    check('SPA forward reaches tab metadata', await uiUrl(tabId, nextUrl));
    const peer = await open('peer'); await close(peer);
    await ok('browser_wait', { tabId, waitFor: { url: nextUrl, stableFor: 1000, timeout: 2500 } });
    const data = await state(tabId);
    check('peer lifecycle preserves SPA URL and in-memory state', data.token === initial.token && data.route === 'detail' && data.clicks === 1, data);
    check('geometry does not reload the initial route', requests.filter(p => p === '/case?mode=spa').length === 1, requests);
    await close(tabId);
  });
  await scenario('warm click sample', async () => {
    const tabId = await open('benchmark'), ref = await find(tabId), samples = [];
    for (let i=0;i<35;i++) { const r = await call('browser_click', { tabId, ref, diagnostics: true }); if (r.error) throw Error(JSON.stringify(r)); if(i>=5)samples.push(r); }
    benchmark = { native: stats(samples.map(s => s.result.durationMs)), wall: stats(samples.map(s => s.wallMs)), guard: stats(samples.map(s => s.result.timings.find(t => t.phase === 'pointerGuard')?.durationMs ?? 0)) };
    const data = await state(tabId); check('warm sample dispatches 35 clicks without shifting the document', data.clicks === 35 && data.down === 35 && data.scrollY === 0, { data, benchmark });
    await close(tabId);
  });
} finally {
  for (const tabId of [...owned]) { try { await close(tabId); } catch (cause) { check('cleanup ' + tabId, false, String(cause)); } }
  try { after = await ok('browser_tabs', {}); } catch {}
  check('original tabs and active space retained', before && after && before.activeSpaceId === after.activeSpaceId && before.activeTabId === after.activeTabId && before.tabs.every(t => after.tabs.some(a => a.tabId === t.tabId)));
  check('owned tabs closed', owned.size === 0);
  if(session) { const r = await fetch(endpoint, { method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000) }); check('MCP session closed', r.ok); }
  server.closeAllConnections(); server.close();
  await writeFile(output, JSON.stringify({ endpoint:endpoint.href,workspace,checks,calls,requests,benchmark,before,after },null,2), { flag:'wx' });
  console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
  if(checks.some(c=>!c.passed))process.exitCode=1;
}
