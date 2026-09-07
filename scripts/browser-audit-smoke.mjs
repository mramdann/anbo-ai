import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
const calls = [], checks = [], owned = new Set(), timers = new Set();
let sequence = 0, session, origin, before;
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
  calls.push(sample); return sample;
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
const html = `<!doctype html><meta charset="utf-8"><title>Coordinator browser regression fixture</title>
<style>body{margin:30px;font:16px system-ui}#hover{margin:50px;width:140px;height:50px;background:#ccc}#hover:hover{background:#afa}#offscreen{position:absolute;left:-9999px;top:0}</style>
<p>COORDINATOR_AUDIT_READY</p>
<button id="named" title="Tooltip only">Visible Button</button>
<label for="input">Field Label</label><input id="input" placeholder="Placeholder only">
<div id="hover">Hover here</div><p id="events">enter=0 over=0 move=0</p>
<button id="offscreen">Offscreen Button</button>
<button id="network">Start fetch</button><span id="netstate">ready</span>
<button id="plain">No dialog</button><span id="plain-count">0</span>
<button id="alert">Open alert</button><a id="download" href="/download.bin">Download audit fixture</a>
<section style="margin-top:75vh"><div id="drag-source" style="width:80px;height:40px;background:#acf">Source</div>
<div style="height:90px"></div><div id="drag-target" style="width:140px;height:50px;background:#cfa">Target</div></section>
<output id="drag-state">none</output>
<div style="height:150vh"></div><div id="far-target">Far target</div><div style="height:100vh"></div>
<script>
const hover = document.getElementById('hover'), counter={enter:0,over:0,move:0};
for(const [event,key] of [['mouseenter','enter'],['mouseover','over'],['mousemove','move']]) hover.addEventListener(event,()=>{counter[key]++;document.getElementById('events').textContent='enter='+counter.enter+' over='+counter.over+' move='+counter.move;});
document.getElementById('network').onclick=()=>{document.getElementById('netstate').textContent='loading';fetch('/slow-body').then(r=>r.text()).then(()=>{document.getElementById('netstate').textContent='NETWORK_DONE';});};
for(const level of ['log','info','warn','error','debug','trace']) console[level]('COORD_LEVEL_'+level);
console.assert(false,'COORD_LEVEL_assert');console.assert(true,'COORD_ASSERT_MUST_NOT_LOG');
let plainClicks=0; document.getElementById('plain').onclick=()=>{document.getElementById('plain-count').textContent=++plainClicks;};
document.getElementById('alert').onclick=()=>alert('AUDIT_DIALOG');
let from='none',down=0,up=0;
document.addEventListener('mousedown',e=>{from=e.target.id;down++;document.getElementById('drag-state').textContent=from+':'+down+':'+up;});
document.addEventListener('mouseup',e=>{up++;document.getElementById('drag-state').textContent=from+'>'+e.target.id+':'+down+':'+up;});
</script>`;
const server = http.createServer((request, response) => {
  if (request.url === '/download.bin') {
    response.writeHead(200, { 'Content-Type':'application/octet-stream', 'Content-Disposition':'attachment; filename="audit.bin"', 'Content-Length':65536 });
    response.write(Buffer.alloc(32768,65));
    const timer=setTimeout(()=>{timers.delete(timer);if(!response.destroyed)response.end(Buffer.alloc(32768,66));},800);
    timers.add(timer);return;
  }
  response.writeHead(200, { 'Content-Type': request.url === '/slow-body' ? 'text/plain' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (request.url === '/slow-body') {
    response.write('body-start\n');
    const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) response.end('body-end'); }, 2500);
    timers.add(timer); return;
  }
  response.end(html);
});
async function closeOwned(tabId) {
  const tabs = await ok('browser_tabs', {});
  const tab = tabs.tabs.find(item => item.tabId === tabId);
  if (tab && ![tab.url, tab.pendingUrl].some(url => url?.startsWith(`${origin}/`))) throw Error(`Refusing to close changed tab ${tabId}`);
  if (tab) {
    const controlId = [...calls].reverse().find(item => item.value?.tabId === tabId && item.value?.controlId)?.value.controlId;
    if (controlId) await ok('browser_end_session', {tabId, controlId});
    await ok('browser_close', { workspace, tabId });
  }
  owned.delete(tabId);
}
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'anbo-browser-audit-verifier', version: '1' } });
  before = await ok('browser_tabs', {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const { tabId } = await ok('browser_open', { workspace, url: `${origin}/fixture` }); owned.add(tabId);
  await ok('browser_wait', { tabId, condition: 'text', text: 'COORDINATOR_AUDIT_READY', timeout: 5000 });
  const find = (value, extra = {}) => ok('browser_find', { tabId, by: 'css', value, timeout: 1500, ...extra });
  const ref = async selector => (await find(selector)).matches[0].ref;
  const snapshot = await ok('browser_snapshot', { tabId });
  check('snapshot keeps visible button label', snapshot.snapshot.includes('<button> Visible Button'), snapshot.snapshot);
  const button = await call('browser_find', { tabId, by: 'role', value: 'button', name: 'Visible Button', exact: true, timeout: 800 });
  check('role locator uses content before title', !button.error && button.value.matches?.length === 1, button);
  const input = (await find('#input')).matches[0];
  const inputText = await ok('browser_get_text', { tabId, ref: input.ref });
  check('accessible input name matches across read and find', input.name === 'Field Label' && inputText.text === input.name, { input, inputText });
  for (const modifiers of [['Control','Shift'], ['Meta','Shift'], ['Alt','Shift'], ['Control']]) {
    const inputRef = await ref('#input');
    await ok('browser_type', { tabId, ref: inputRef, text: 'seed' });
    await ok('browser_key', { tabId, key: 'q', modifiers });
    const value = (await find('#input')).matches[0].value;
    check(`shortcut ${modifiers.join('+')} does not insert text`, value === 'seed', value);
  }
  const typingRef = await ref('#input');
  await ok('browser_type', { tabId, ref: typingRef, text: 'seed' });
  await ok('browser_key', { tabId, key: 'q', modifiers: ['Shift'] });
  const shifted = (await find('#input')).matches[0].value;
  check('Shift-only printable letter is uppercase', shifted === 'seedQ', shifted);
  for (const key of ['.', '@', '/']) await ok('browser_key', { tabId, key });
  const punctuation = (await find('#input')).matches[0].value;
  check('punctuation remains printable', punctuation.endsWith('.@/'), punctuation);
  const hoverRef = await ref('#hover');
  const hover = await ok('browser_hover', { tabId, ref: hoverRef });
  const events = (await find('#events')).matches[0].text;
  check('one native hover produces one event set', hover.cssHover === true && events === 'enter=1 over=1 move=1', { hover, events });
  const offscreenRef = await ref('#offscreen');
  const offscreen = await call('browser_click', { tabId, ref: offscreenRef });
  check('offscreen error is not reported as covered', Boolean(offscreen.error) && /outside.*viewport|out of.*viewport/i.test(String(offscreen.error)), offscreen);
  const missing = await call('browser_find', { tabId, by: 'css', value: '#does-not-exist', timeout: 800 });
  check('empty locator explains no matching element', Boolean(missing.error) && /no matching|no .*matches|no element/i.test(String(missing.error)), missing);
  const logs = await ok('browser_console_logs', { tabId });
  for (const level of ['log','info','warn','error','debug','trace','assert']) {
    check(`console ${level} captured with its level`, logs.logs.some(entry => entry.level === level && entry.msg.includes(`COORD_LEVEL_${level}`)));
  }
  check('truthy console.assert is not captured', !logs.logs.some(entry => entry.msg.includes('COORD_ASSERT_MUST_NOT_LOG')));
  await ok('browser_click', { tabId, ref: await ref('#network') });
  const network = await call('browser_wait', { tabId, condition: 'load', loadState: 'networkIdle', timeout: 10000 });
  const networkText = (await find('#netstate')).matches[0].text;
  check('network idle waits for pending response body', !network.error && networkText === 'NETWORK_DONE', { network, networkText });
  for (const condition of [
    {condition:'load',loadState:'complete'},
    {condition:'text',text:'COORDINATOR_AUDIT_READY'},
    {waitFor:{text:'COORDINATOR_AUDIT_READY',timeout:2000,stableFor:200}},
  ]) {
    const wait=await ok('browser_wait',{tabId,...condition,diagnostics:true});
    check('wait diagnostics records a bounded phase',wait.timings?.length>0 && wait.timings.length<=24,wait);
  }
  const waitError=await call('browser_wait',{tabId,condition:'text',text:'NEVER_MATCHES_7C_AUDIT',timeout:500,diagnostics:true});
  check('wait timeout retains error code and phase',/\[timeout\]/.test(String(waitError.error)) && /"phase":"condition"/.test(String(waitError.error)),waitError);
  const plain=await ok('browser_dialog',{tabId,ref:await ref('#plain'),dialogAction:'accept'});
  check('no-dialog distinguishes dispatched click from opened dialog',plain.ok===false && plain.clickDispatched===true && plain.dialogOpened===false && plain.kind===null,plain);
  check('no-dialog click occurs once only',(await find('#plain-count')).matches[0].text==='1');
  const alert=await ok('browser_dialog',{tabId,ref:await ref('#alert'),dialogAction:'accept'});
  check('real dialog still handled',alert.ok===true && alert.dialogOpened===true && alert.clickDispatched===true && alert.message==='AUDIT_DIALOG',alert);
  for (const reverse of [false,true,false]) {
    const pair=await find('#drag-source, #drag-target',{limit:2});
    const [source,target]=reverse ? [...pair.matches].reverse() : pair.matches;
    const drag=await call('browser_drag',{tabId,sourceRef:source.ref,targetRef:target.ref});
    const state=(await find('#drag-state')).matches[0].text;
    const expected=reverse ? 'drag-target>drag-source:' : 'drag-source>drag-target:';
    check('native drag presses source and releases destination after scrolling',!drag.error && state.startsWith(expected),{drag,state});
  }
  const beforeFar=(await find('#drag-state')).matches[0].text;
  const far=await find('#drag-source, #far-target',{limit:2});
  const rejected=await call('browser_drag',{tabId,sourceRef:far.matches[0].ref,targetRef:far.matches[1].ref});
  check('unreachable drag fails before mouse-down',Boolean(rejected.error) && /no mouse button was pressed/.test(String(rejected.error)),rejected);
  check('rejected drag has no input side effects',(await find('#drag-state')).matches[0].text===beforeFar);
  const download=await ok('browser_download',{tabId,workspace,ref:await ref('#download'),fileName:'audit-followup.bin'});
  const status=await call('browser_download_status',{workspace,downloadId:download.downloadId});
  check('download status accepts canonical workspace',!status.error && status.value.downloadId===download.downloadId,status);
  const other=await call('browser_download_status',{workspace:workspace+'/.anbo',downloadId:download.downloadId});
  check('download status still rejects a different canonical root',Boolean(other.error) && /different workspace/.test(String(other.error)),other);
  const done=await call('browser_download_wait',{workspace,downloadId:download.downloadId,timeout:10000});
  check('download wait verifies completed size',!done.error && done.value.status==='completed' && done.value.size===65536,done);
  check('display paths remain normalized',!status.error && status.value.workspace===workspace.replaceAll('\\','/') && !status.value.path.includes('\\'),status.value);
} catch (error) { check('suite completed', false, String(error)); }
finally {
  for (const tabId of [...owned]) { try { await closeOwned(tabId); } catch (error) { check('cleanup', false, String(error)); } }
  if (before) {
    const after = await ok('browser_tabs', {});
    check('original tabs and focus preserved', before.activeSpaceId === after.activeSpaceId && before.activeTabId === after.activeTabId && before.tabs.every(tab => after.tabs.some(item => item.tabId === tab.tabId)));
  }
  check('owned tabs closed', owned.size === 0);
  if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) });
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); server.close();
  const destination = resolve(output); await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ endpoint, workspace, checks, calls, unclosedTabs: [...owned] }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output: destination, passed: checks.filter(item => item.passed).length, total: checks.length }));
  if (checks.some(item => !item.passed)) process.exitCode = 1;
}
