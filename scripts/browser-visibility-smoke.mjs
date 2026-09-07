import http from "node:http";
import { writeFile } from "node:fs/promises";

const argument = name => {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw Error(`Pass --${name} explicitly`);
  return value;
};
const workspace = argument("workspace"), output = argument("output");
const endpoint = new URL(argument("mcp-url"));
if (!process.argv.includes("--workspace") || !process.argv.includes("--output") || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") throw Error("Pass explicit loopback --mcp-url, --workspace and --output");
const calls = [], checks = [], owned = new Set();
let sequence = 0, before, after;
async function call(name, args) {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(20000) });
  const envelope = await response.json();
  const content = envelope.result?.content?.find(item => item.type === "text")?.text;
  let result;
  try { result = JSON.parse(content); } catch { result = { message: content }; }
  const error = envelope.error ?? (envelope.result?.isError ? result : undefined);
  calls.push({ name, args, result, error });
  if (!response.ok || error || !content) throw Error(JSON.stringify(error ?? { status: response.status }));
  return result;
}
function check(name, passed, details = {}) { const item = { name, passed: Boolean(passed), ...details }; checks.push(item); console.log(JSON.stringify(item)); }
const server = http.createServer((request, response) => {
  const kind = request.url.slice(1);
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end(`<!doctype html><title>Visibility fixture</title><style>button{margin:8px;padding:12px}#host{display:block}</style><button id="reveal">Reveal controls</button><output id="counter">0</output><div id="host"></div><script>
  const host=document.getElementById('host'), count=document.getElementById('counter'); let clicks=0;
  const button=document.createElement('button');button.id='target';button.textContent='Hidden candidate';button.onclick=()=>count.textContent=String(++clicks);
  if(${JSON.stringify(kind)}==='slot'){const root=host.attachShadow({mode:'open'});root.innerHTML='<div style="opacity:0"><slot></slot></div>';host.append(button);document.getElementById('reveal').onclick=()=>root.querySelector('div').style.opacity='1'}
  else {host.style.opacity='0';(${JSON.stringify(kind)}==='shadow'?host.attachShadow({mode:'open'}):host).append(button);document.getElementById('reveal').onclick=()=>host.style.opacity='1'}
  </script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function close(tabId) {
  const url = await call("browser_get_url", { tabId });
  if (!url.url.startsWith(`${origin}/`)) throw Error(`Refusing to close changed tab ${tabId}`);
  await call("browser_close", { tabId, workspace }); owned.delete(tabId);
}
try {
  before = await call("browser_tabs", {});
  for (const kind of ["ancestor", "shadow", "slot"]) {
    let tabId;
    const invoke = (name, args = {}) => call(name, { tabId, ...args });
    const find = async (value, extra = {}) => invoke("browser_find", { by: "css", value, limit: 1, timeout: 500, ...extra });
    try {
      ({ tabId } = await call("browser_open", { workspace, url: `${origin}/${kind}` })); owned.add(tabId);
      await invoke("browser_wait", { condition: "load", loadState: "complete", timeout: 5000 });
      let excluded = false;
      try { const found = await find("#target"); excluded = found.matches.length === 0; } catch (cause) { excluded = /timeout/.test(String(cause)); }
      check(`${kind}: default find excludes transparent descendant`, excluded);
      const hidden = (await find("#target", { includeHidden: true })).matches[0];
      check(`${kind}: explicit hidden find reports invisible`, hidden?.visible === false, { actual: hidden?.visible });
      const text = await invoke("browser_get_text", { ref: hidden.ref, maxLength: 100 });
      check(`${kind}: text read reports invisible`, text.visible === false, { actual: text });
      let waited = false;
      try { await invoke("browser_wait", { condition: "ref", ref: hidden.ref, state: "hidden", timeout: 200 }); waited = true; } catch {}
      check(`${kind}: hidden wait agrees`, waited);
      let refused = false;
      try { await invoke("browser_click", { ref: hidden.ref }); } catch (cause) { refused = /not_visible|actionable|visible/.test(String(cause)); }
      const counter = (await find("#counter")).matches[0];
      const count = await invoke("browser_get_text", { ref: counter.ref, maxLength: 50 });
      check(`${kind}: hidden click never dispatches`, refused && count.text === "0", { count: count.text, refused });
      const snapshot = await invoke("browser_snapshot", { maxChars: 2000 });
      check(`${kind}: snapshot excludes transparent controls`, !snapshot.snapshot.includes("Hidden candidate"));
      await invoke("browser_click", { ref: (await find("#reveal")).matches[0].ref });
      const revealed = (await find("#target", { timeout: 2000 })).matches[0];
      const shownText = await invoke("browser_get_text", { ref: revealed.ref, maxLength: 100 });
      check(`${kind}: revealed control becomes visible`, revealed.visible === true && shownText.visible === true);
      await invoke("browser_click", { ref: revealed.ref });
      const actual = await invoke("browser_get_text", { ref: (await find("#counter")).matches[0].ref, maxLength: 50 });
      check(`${kind}: revealed click delivered once`, actual.text === "1", { actual: actual.text });
    } catch (cause) { check(`${kind}: completed`, false, { error: String(cause) }); }
    finally { if (tabId !== undefined) try { await close(tabId); } catch (cause) { check(`${kind}: cleanup`, false, { error: String(cause) }); } }
  }
} catch (cause) {
  check("suite completed", false, { error: String(cause) });
} finally {
  for (const tabId of [...owned]) try { await close(tabId); } catch (cause) { check("cleanup", false, { error: String(cause) }); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  try { after = await call("browser_tabs", {}); } catch (cause) { check("final metadata", false, { error: String(cause) }); }
  check("original tabs and focus preserved", before && after && before.activeSpaceId === after.activeSpaceId && before.activeTabId === after.activeTabId && before.tabs.every(tab => after.tabs.some(item => item.tabId === tab.tabId)));
  check("owned tabs closed", owned.size === 0);
  await writeFile(output, JSON.stringify({ endpoint: String(endpoint), workspace, checks, calls, before, after, unclosedTabs: [...owned] }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, passed: checks.filter(item => item.passed).length, total: checks.length }));
  if (checks.some(item => !item.passed)) process.exitCode = 1;
}
