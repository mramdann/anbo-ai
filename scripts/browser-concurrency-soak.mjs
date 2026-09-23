// Several agents driving the browser at once, each through its own MCP session
// and, when given, its own workspace. Every lane runs the same search -> result
// -> counter -> read flow on a local fixture with a lane-unique token, so a read
// that returns another lane's token is cross-talk, a counter that is not exactly
// 3 is a lost or doubled input, and the page's own frame meter shows whether a
// background tab is throttled. Run it with --lanes 1 first for the baseline.
//
//   node scripts/browser-concurrency-soak.mjs --mcp-url http://127.0.0.1:7332/mcp \
//     --workspaces D:/anbo-dev-local/sandbox,D:/anbo-dev-local --lanes 4 --rounds 5 \
//     --output ./concurrency-4.json
import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const arg = (name, fallback) => { const index = process.argv.indexOf('--' + name); return index < 0 ? fallback : process.argv[index + 1]; };
const endpoint = new URL(arg('mcp-url', 'http://127.0.0.1:7332/mcp'));
const workspaces = String(arg('workspaces', '')).split(',').map(s => s.trim()).filter(Boolean);
const lanes = Number(arg('lanes', 4)), rounds = Number(arg('rounds', 5)), output = arg('output');
const verbose = process.argv.includes('--verbose');
// Snapshot and a background-tab screenshot each round: the calls that timed out
// when real agents ran side by side. Screenshots land in each workspace under
// .anbo/artifacts/browser/concurrency-soak.
const heavy = process.argv.includes('--heavy');
if (!workspaces.length || !output || existsSync(output) || endpoint.hostname !== '127.0.0.1' || !(lanes >= 1) || !(rounds >= 1)) {
  throw Error('Pass --workspaces a,b (open in Anbo), --lanes N, --rounds R and a fresh --output');
}

const html = (title, body, script) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px sans-serif;margin:16px}button,input{padding:8px;margin:4px}</style>${body}
<p id="meter">meter starting</p>
<script>
// Frames and 100 ms ticks seen in the last second, written by the tick itself:
// a throttled tab shows few frames, few ticks and a stale "at".
const frames = [], ticks = [];
const frame = (t) => { frames.push(t); requestAnimationFrame(frame); };
requestAnimationFrame(frame);
setInterval(() => {
  const now = performance.now();
  ticks.push(now);
  while (frames.length && frames[0] < now - 1000) frames.shift();
  while (ticks.length && ticks[0] < now - 1000) ticks.shift();
  document.getElementById('meter').textContent =
    'frames=' + frames.length + ' ticks=' + ticks.length + ' visibility=' + document.visibilityState + ' at=' + Date.now();
}, 100);
${script}
</script>`;

function serve(req, res) {
  const url = new URL(req.url, 'http://fixture');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const token = String(url.searchParams.get('token') || '').replace(/[^\w-]/g, '');
  if (url.pathname === '/item') {
    return res.end(html(`Item ${token}`, `<h1>Item ${token}</h1><button id="count">Count 0</button>`,
      `let n = 0; document.getElementById('count').onclick = (e) => { e.currentTarget.textContent = 'Count ' + (++n); };`));
  }
  // A search box whose Enter moves the route inside the document and draws the
  // results a moment later, like the single-page apps the agents drive.
  return res.end(html(`Lane ${token}`, `<h1>Lane ${token} home</h1><input id="q" aria-label="Search lane"><div id="results"></div>`,
    `const q = document.getElementById('q');
q.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const word = q.value.trim();
  history.pushState({}, '', '/results?token=${token}&q=' + encodeURIComponent(word));
  document.title = 'Results ' + word;
  setTimeout(() => {
    document.getElementById('results').innerHTML = ['one', 'two', 'three'].map((n) =>
      '<h3><a href="/item?token=' + encodeURIComponent(word) + '&n=' + n + '">Result ' + word + ' ' + n + '</a></h3>').join('');
  }, 250);
});`));
}

const server = http.createServer(serve);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const samples = [], checks = [];
// Tabs the lanes hold right now, so each lane can reach for another lane's.
const live = new Map();
function check(lane, name, passed, detail) {
  const item = { lane, name, passed: !!passed, detail };
  checks.push(item);
  if (!passed) console.log(JSON.stringify(item));
}

function client(lane) {
  let session, sequence = 0;
  async function rpc(method, params) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      signal: AbortSignal.timeout(45000),
    });
    if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
    const envelope = await response.json();
    if (envelope.error) throw Error(JSON.stringify(envelope.error));
    return envelope.result;
  }
  async function call(name, args, { refusal = false } = {}) {
    const start = performance.now();
    let result, error;
    try {
      const envelope = await rpc('tools/call', { name, arguments: args });
      const text = envelope.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
      try { result = JSON.parse(text); } catch { result = { message: text }; }
      if (envelope.isError) error = result.message ?? text;
    } catch (cause) { error = String(cause); }
    const sample = { lane, name, ms: Math.round(performance.now() - start), error: error ? String(error).slice(0, 300) : undefined, refusal: refusal || undefined };
    samples.push(sample);
    if (verbose || (sample.error && !refusal) || sample.ms > 5000) console.log(JSON.stringify(sample));
    return { result, error, ms: sample.ms };
  }
  return { rpc, call };
}

async function runLane(lane) {
  const { rpc, call } = client(lane);
  const workspace = workspaces[lane % workspaces.length];
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `concurrency-lane-${lane}`, version: '1' } });
  for (let round = 0; round < rounds; round++) {
    const token = `L${lane}R${round}x${Math.random().toString(36).slice(2, 7)}`;
    const open = await call('browser_open', { workspace, url: `${origin}/lane?token=${token}`, find: { by: 'role', value: 'textbox', name: 'Search lane', timeout: 10000 } });
    const tabId = open.result?.tabId;
    if (open.error || !tabId) { check(lane, 'open', false, open.error); continue; }
    live.set(tabId, { lane, workspace });
    try {
      const input = open.result.read?.matches?.[0]?.ref;
      check(lane, 'open finds the lane input', input, open.result.read);
      const typed = await call('browser_type', { tabId, ref: input, text: token, submit: true, waitFor: { text: `Result ${token} one`, timeout: 10000 } });
      const results = typed.result?.page?.hints?.results ?? [];
      check(lane, 'search submits in one call', !typed.error && typed.result?.submitted, typed.error);
      check(lane, 'hints carry only this lane\'s results', results.length && results.every(r => r.name.includes(token)), results.map(r => r.name));
      const target = results[0]?.ref;
      const click = await call('browser_click', target
        ? { tabId, ref: target, waitFor: { url: '*item*', timeout: 10000 } }
        : { tabId, locator: { by: 'text', value: `Result ${token} one` }, waitFor: { url: '*item*', timeout: 10000 } });
      check(lane, 'result click lands on this lane\'s item', !click.error && click.result?.page?.hints?.heading === `Item ${token}`, click.error ?? click.result?.page?.hints?.heading);
      for (let i = 0; i < 3; i++) {
        const press = await call('browser_click', { tabId, locator: { by: 'css', value: '#count' } });
        if (press.error) check(lane, 'counter click', false, press.error);
      }
      const count = await call('browser_get_text', { tabId, locator: { by: 'css', value: '#count' } });
      check(lane, 'three clicks count exactly three', count.result?.text === 'Count 3', count.error ?? count.result?.text);
      const heading = await call('browser_get_text', { tabId, locator: { by: 'css', value: 'h1' } });
      check(lane, 'the read is this lane\'s page', heading.result?.text === `Item ${token}`, heading.error ?? heading.result?.text);
      const meter = await call('browser_get_text', { tabId, locator: { by: 'css', value: '#meter' } });
      const reading = /frames=(\d+) ticks=(\d+) visibility=(\w+) at=(\d+)/.exec(meter.result?.text ?? '');
      if (reading) {
        samples.push({ lane, name: 'meter', frames: +reading[1], ticks: +reading[2], visibility: reading[3], staleMs: Date.now() - +reading[4] });
      } else check(lane, 'meter reads', false, meter.error ?? meter.result?.text);
      if (heavy) {
        const snapshot = await call('browser_snapshot', { tabId });
        check(lane, 'snapshot is this lane\x27s page', !snapshot.error && JSON.stringify(snapshot.result).includes(`Item ${token}`), snapshot.error);
        const shot = await call('browser_screenshot', { tabId, context: 'concurrency-soak', label: token });
        check(lane, 'screenshot', !shot.error && shot.result?.path, shot.error);
      }
      // Another lane's live tab: refused across workspaces, shared within one.
      const [otherTab, other] = [...live].find(([id, held]) => id !== tabId && held.lane !== lane) ?? [];
      if (otherTab) {
        const reach = await call('browser_get_text', { tabId: otherTab, maxLength: 20 }, { refusal: other.workspace !== workspace });
        const gone = /tab_not_found|not found|closed/i.test(reach.error ?? '');
        if (!gone) {
          const refused = /tab_in_use/.test(reach.error ?? '');
          check(lane, other.workspace === workspace ? 'a lane may read a tab in its own workspace' : 'a lane is refused another workspace\x27s live tab',
            other.workspace === workspace ? !reach.error : refused, reach.error ?? 'read');
        }
      }
      const tabs = await call('browser_tabs', {});
      const listed = tabs.result?.tabs?.find?.(t => t.tabId === tabId || t.id === tabId);
      check(lane, 'the tab list names this tab with its workspace', !tabs.error && listed && listed.workspace, tabs.error ?? listed);
    } finally {
      live.delete(tabId);
      const close = await call('browser_close', { tabId, workspace, endSession: round === rounds - 1 });
      check(lane, 'close', !close.error, close.error);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: lanes }, (_, lane) => runLane(lane).catch(cause => check(lane, 'lane crashed', false, String(cause)))));
const wallMs = Math.round(performance.now() - started);
// The kept-warm browser host holds idle keep-alive sockets open, and close() alone waits for them.
server.close();
server.closeAllConnections();

const percentile = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const byTool = {};
for (const s of samples.filter(s => s.name !== 'meter')) (byTool[s.name] ??= []).push(s);
const tools = Object.fromEntries(Object.entries(byTool).map(([name, list]) => {
  const ms = list.map(s => s.ms);
  return [name, { n: list.length, errors: list.filter(s => s.error && !s.refusal).length, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: Math.max(...ms) }];
}));
const meters = samples.filter(s => s.name === 'meter');
const calls = samples.filter(s => s.name !== 'meter');
const summary = {
  lanes, rounds, workspaces, wallMs,
  calls: calls.length,
  callErrors: calls.filter(s => s.error && !s.refusal).length,
  refusals: calls.filter(s => s.refusal && /tab_in_use/.test(s.error ?? '')).length,
  callsPerSecond: Math.round(calls.length / (wallMs / 1000) * 10) / 10,
  checks: checks.length,
  failedChecks: checks.filter(c => !c.passed).length,
  meter: meters.length ? {
    framesP50: percentile(meters.map(m => m.frames), 0.5), framesMin: Math.min(...meters.map(m => m.frames)),
    ticksP50: percentile(meters.map(m => m.ticks), 0.5), ticksMin: Math.min(...meters.map(m => m.ticks)),
    staleMsMax: Math.max(...meters.map(m => m.staleMs)),
    hidden: meters.filter(m => m.visibility !== 'visible').length,
  } : null,
  tools,
};
await writeFile(output, JSON.stringify({ summary, checks: checks.filter(c => !c.passed), samples }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failedChecks || summary.callErrors ? 1 : 0;
