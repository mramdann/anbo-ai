import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url') ?? 'http://127.0.0.1:7332/mcp');
const workspace = arg('workspace'), output = arg('output'), binary = arg('binary');
if (!workspace || !output || !binary || endpoint.hostname !== '127.0.0.1') throw Error('Pass loopback --mcp-url, --workspace, --output and --binary');
const publicSites = arg('public') === 'true', repeat = Number(arg('repeat') ?? 3);
const extended = arg('suite') === 'extended';
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw Error('repeat must be 1..10');
const calls = [], checks = [], trials = [], events = [], owned = new Set(), timers = new Set();
let session, sequence = 0, before, origin, failure;
const later = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
async function rpc(method, params) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(55000) });
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const data = await response.json();
  if (!response.ok || data.error) throw Error(JSON.stringify(data.error ?? response.status));
  return data.result;
}
async function call(name, args) {
  const started = performance.now(), envelope = await rpc('tools/call', { name, arguments: args });
  const raw = envelope.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let result; try { result = JSON.parse(raw); } catch { result = { message: raw }; }
  const sample = { name, args, wallMs: performance.now() - started, error: envelope.isError === true, result };
  calls.push(sample); return sample;
}
async function ok(name, args) { const sample = await call(name, args); if (sample.error) throw Error(JSON.stringify(sample)); return sample.result; }
function check(name, passed, detail) { const result = { name, passed: !!passed, detail }; checks.push(result); console.log(JSON.stringify(result)); }
const base = '<!doctype html><meta charset="utf-8"><title>Initial read fixture</title><style>body{font:16px sans-serif;margin:20px}</style>';
const content = '<h1>Committed destination</h1><a href="/target">Usable target</a><p>Initial read verified</p>';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const record = kind => events.push({ kind, path: url.pathname, trial: url.searchParams.get('trial'), at: performance.now() });
  const send = body => { record('bodySent'); res.end(base + body); };
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  record('request');
  if (url.pathname === '/headers') return later(800, () => send(content));
  if (url.pathname === '/long-headers') return later(6000, () => send(content));
  if (url.pathname === '/parser') { res.write(base + '<body>'); return later(800, () => { record('bodySent'); res.end(content); }); }
  if (url.pathname === '/redirect') { res.statusCode = 302; res.setHeader('Location', '/headers' + url.search); return res.end(); }
  if (url.pathname === '/replace') return send('<script>location.replace("/headers' + url.search + '")</script>');
  if (url.pathname === '/replace-during-read') return send('<body><script>setTimeout(()=>location.replace("/headers' + url.search + '"),180)</script>');
  if (url.pathname === '/empty') return send('<body></body>');
  if (url.pathname === '/missing') return send(content);
  if (url.pathname === '/never') return later(15000, () => send(content));
  if (url.pathname === '/hydrate') return send('<body><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",' + JSON.stringify(content) + '),700)</script>');
  if (url.pathname === '/resource') { res.setHeader('Content-Type', 'image/svg+xml'); return later(15000, () => res.end('<svg xmlns="http://www.w3.org/2000/svg"/>')); }
  if (url.pathname === '/stream') return send(content + '<img src="/resource" width="1" height="1">');
  if (url.pathname === '/target') return send('<h1>Clicked destination</h1>');
  send(content);
});
const binaryHash = await hash();
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-open-read', version: '1' } });
  before = await ok('browser_tabs', {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  async function trial(kind, mode, index, url, expected, find) {
    const id = `${kind}-${mode}-${index}`;
    const start = performance.now();
    const sample = await call('browser_open', { workspace, url: url ?? `${origin}/${kind}?trial=${id}`, ...(mode === 'snapshot' ? { snapshot: true } : { find: find ?? { by: 'role', value: 'heading', name: expected ?? 'Committed destination', exact: true, timeout: extended ? 10000 : 5000 } }), closeTab: true, endSession: true, ...(extended ? {diagnostics:true} : {}) });
    const result = sample.result;
    if (result.tabId && !result.closed) owned.add(result.tabId);
    const text = mode === 'snapshot' ? result.read?.snapshot ?? '' : JSON.stringify(result.read?.matches ?? []);
    const correct = !sample.error && result.readOk === true && result.closed === true && text.includes(expected ?? 'Committed destination') && (mode !== 'snapshot' || result.read?.totalItems > 0);
    trials.push({ id, kind, mode, wallMs: sample.wallMs, correct, readOk: result.readOk, readError: result.readError, totalItems: result.read?.totalItems, url: result.read?.url ?? result.page?.url, bodySentAfterMs: events.find(e => e.trial === id && e.kind === 'bodySent')?.at - start });
    check(id, correct, trials.at(-1));
    if (owned.has(result.tabId)) { await ok('browser_close', { workspace, tabId: result.tabId, endSession: true }); owned.delete(result.tabId); }
  }
  for (const kind of extended ? ['long-headers', 'replace-during-read'] : ['headers', 'parser', 'redirect', 'replace', 'hydrate', 'stream']) {
    for (const mode of ['snapshot', 'find']) for (let i = 1; i <= (extended ? 1 : repeat); i++) await trial(kind, mode, i);
  }
  const empty = await ok('browser_open', { workspace, url: origin + '/empty', snapshot: true, closeTab: true, endSession: true });
  if (!empty.closed) owned.add(empty.tabId);
  check('legitimate empty destination succeeds', empty.readOk && empty.closed && empty.read?.url === origin + '/empty' && empty.read?.totalItems === 0, empty);
  const missing = await ok('browser_open', { workspace, url: origin + '/missing', find: { by: 'role', value: 'button', name: 'absent', timeout: 150 }, closeTab: true });
  if (!missing.closed) owned.add(missing.tabId);
  check('unsuccessful read retains only its new tab', missing.readOk === false && missing.closed === false && (await ok('browser_tabs', {})).tabs.some(tab => tab.tabId === missing.tabId), missing);
  const invalid = await call('browser_open', { workspace, url: origin, closeTab: true });
  check('closeTab without read rejected before creation', invalid.error && (await ok('browser_tabs', {})).tabs.length === before.tabs.length + owned.size);
  const slow = await ok('browser_open', { workspace, url: origin + '/never', find: { by: 'role', value: 'heading', timeout: 150 }, closeTab: true });
  if (!slow.closed) owned.add(slow.tabId);
  check('uncommitted destination has bounded explicit read failure', slow.readOk === false && slow.closed === false, slow);
  for (const tabId of [...owned]) { await ok('browser_close', { workspace, tabId, endSession: true }); owned.delete(tabId); }
  if (extended) {
    for (const mode of ['find','snapshot']) {
      const live = await ok('browser_open', {workspace, url:origin+'/redirect', ...(mode === 'find' ? {find:{by:'role',value:'link',name:'Usable target',exact:true}} : {snapshot:true})});
      owned.add(live.tabId);
      const ref = mode === 'find' ? live.read?.matches?.[0]?.ref : live.read?.snapshot?.match(/\[(g\d+-e\d+)\] <a> Usable target/)?.[1];
      const click = ref ? await call('browser_click', {tabId:live.tabId,ref,reveal:0,waitFor:{text:'Clicked destination',timeout:5000}}) : null;
      check(mode+' refs from redirected initial read work immediately',live.readOk && ref && click && !click.error,click);
      await ok('browser_close',{workspace,tabId:live.tabId,endSession:true});owned.delete(live.tabId);
    }
    const invalidSelector = await ok('browser_open',{workspace,url:origin,find:{by:'css',value:'['},closeTab:true,diagnostics:true});
    if(!invalidSelector.closed)owned.add(invalidSelector.tabId);
    check('invalid selector fails without navigation recovery or close',invalidSelector.readOk===false && invalidSelector.closed===false && invalidSelector.timings?.filter(t=>t.phase==='initialDocument').length===1,invalidSelector);
    if(owned.has(invalidSelector.tabId)){await ok('browser_close',{workspace,tabId:invalidSelector.tabId,endSession:true});owned.delete(invalidSelector.tabId);}
  }
  if (publicSites) for (const [kind, url, expected] of [['hacker-news', 'https://news.ycombinator.com/', 'Hacker News'], ['youtube', 'https://www.youtube.com/', 'YouTube']]) {
    for (let i = 1; i <= repeat; i++) {
      if (extended) await trial(kind,'find',i,url,kind==='hacker-news'?'Hacker News':'Search',{by:'role',value:kind==='hacker-news'?'link':'button',name:kind==='hacker-news'?'Hacker News':'Search',exact:true,timeout:10000});
      else await trial(kind, 'snapshot', i, url, expected);
    }
  }
} catch (error) { failure = String(error); }
finally {
  for (const tabId of [...owned]) { const closed = await call('browser_close', { tabId, workspace, endSession: true }).catch(() => null); if (closed && !closed.error) owned.delete(tabId); }
  const after = await ok('browser_tabs', {}).catch(() => null);
  check('original tabs retained', !!before && !!after && JSON.stringify(before.tabs.map(t => t.tabId).sort()) === JSON.stringify(after.tabs.map(t => t.tabId).sort()));
  if (session) await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': session }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
check('binary unchanged', binaryHash === await hash());
const report = { createdAt: new Date().toISOString(), binaryHash, scriptHash:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), workspace, endpoint: String(endpoint), publicSites, repeat, extended, failure, checks, calls, trials, events, unclosedTabs: [...owned], notes: 'Serial native MCP. No window resizing. Held-response and public-site wall times include network readiness, not pure tool overhead. Public content is dynamic. No LLM benchmark.' };
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, passed: checks.filter(c => c.passed).length, total: checks.length, failure }));
if (failure || owned.size || checks.some(c => !c.passed)) process.exitCode = 1;
