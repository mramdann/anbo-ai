import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const argument = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const endpoint = new URL(argument("mcp-url"));
const workspace = argument("workspace"), output = argument("output");
if (!workspace || !output || existsSync(output) || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw new Error("Pass --mcp-url loopback, --workspace, and a fresh --output");
}
const calls = [], checks = [], owned = new Set();
let sequence = 0, session, origin, initial;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }), signal: AbortSignal.timeout(15000),
  });
  if (method === "initialize") session = response.headers.get("Mcp-Session-Id");
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(JSON.stringify(result));
  return result.result;
}
async function call(name, args = {}) {
  const start = performance.now();
  const envelope = await rpc("tools/call", { name, arguments: args });
  const text = envelope.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
  let result;
  try { result = JSON.parse(text); } catch { result = { message: text }; }
  const sample = { name, args, result, wallMs: performance.now() - start, error: envelope.isError === true };
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw new Error(JSON.stringify(sample.result));
  return sample.result;
}
function check(name, passed, detail) {
  const result = { name, passed: !!passed, detail };
  checks.push(result);
  console.log(JSON.stringify(result));
}
const html = `<!doctype html><meta charset="utf-8"><title>Waiting</title>
<input id="query" aria-label="Query"><button id="count">Count</button>
<p id="keys">keys:0</p><p id="clicks">clicks:0</p><p id="state">waiting</p>
<script>
let keys=0,clicks=0,tick=0,timer;
document.querySelector('#count').onclick=()=>document.querySelector('#clicks').textContent='clicks:'+ ++clicks;
document.querySelector('#query').onkeydown=e=>{
 if(e.key!=='Enter')return;e.preventDefault();document.querySelector('#keys').textContent='keys:'+ ++keys;
 clearInterval(timer);document.title='Report 0';document.querySelector('#state').textContent='ready';
 setTimeout(()=>document.title='Other',80);
 setTimeout(()=>{document.title='Report 1';timer=setInterval(()=>document.title='Report '+ ++tick,75)},350);
};
</script>`;
const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); });
async function close(tabId) {
  const page = await ok("browser_get_url", { tabId });
  if (!page.url.startsWith(origin + "/")) throw new Error("Owned tab navigated away; refusing cleanup");
  await ok("browser_close", { tabId, workspace, endSession: true });
  owned.delete(tabId);
}
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anbo-title-wait-smoke", version: "1" } });
  initial = await ok("browser_tabs");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const { tabId } = await ok("browser_open", { workspace, url: origin });
  owned.add(tabId);
  await ok("browser_wait", { tabId, condition: "load", loadState: "complete", timeout: 5000 });
  const content = async () => (await ok("browser_get_text", { tabId })).text;
  const timedOut = sample => sample.error && /\[timeout\]/.test(sample.result.message);
  const ref = (await ok("browser_find", { tabId, by: "css", value: "#query", limit: 1 })).matches[0].ref;
  await ok("browser_type", { tabId, ref, text: "test" });
  const invalid = await call("browser_press", { tabId, ref, key: "Enter", waitFor: { text: "ready", titleMatch: "prefix", timeout: 500 } });
  check("titleMatch without title is rejected before Enter", invalid.error && /invalid_request/.test(invalid.result.message) && (await content()).includes("keys:0"));
  const prefix = await call("browser_press", { tabId, ref, key: "Enter", expectedValue: "test", waitFor: { title: "Report", titleMatch: "prefix", text: "ready", stableFor: 250, timeout: 3000 } });
  check("prefix waits through a wrong title then tolerates a changing suffix", !prefix.error && prefix.result.postcondition?.stable === true && prefix.wallMs >= 500 && prefix.wallMs < 3000, prefix);
  check("prefix success dispatches Enter only once", (await content()).includes("keys:1"));
  const native = await call("browser_wait", { tabId, waitFor: { title: "report", titleMatch: "prefix", titleSource: "native", timeout: 3000 } });
  check("native prefix supports a changing title without document matching", !native.error && native.result.matched === true && native.result.stable === true, native);
  for (const titleSource of ["document", "native"]) {
    const exact = await call("browser_wait", { tabId, waitFor: { title: "Report", titleSource, timeout: 350 } });
    check(`${titleSource} exact does not accept a prefix by default`, timedOut(exact));
    const star = await call("browser_wait", { tabId, waitFor: { title: "Report*", titleSource, timeout: 350 } });
    check(`${titleSource} star stays literal`, timedOut(star));
    const wrong = await call("browser_wait", { tabId, waitFor: { title: "Other", titleMatch: "prefix", titleSource, timeout: 350 } });
    check(`${titleSource} wrong prefix is rejected`, timedOut(wrong));
  }
  const combined = await call("browser_wait", { tabId, waitFor: { title: "Report", titleMatch: "prefix", text: "not present", timeout: 350 } });
  check("prefix still requires the other conditions", timedOut(combined));
  const failedPress = await call("browser_press", { tabId, ref, key: "Enter", expectedValue: "test", waitFor: { title: "Never", titleMatch: "prefix", timeout: 500 } });
  check("failed prefix postcondition does not repeat Enter", timedOut(failedPress) && /key was dispatched/.test(failedPress.result.message) && (await content()).includes("keys:2"));
  const clicked = await call("browser_click", { tabId, locator: { by: "css", value: "#count" }, waitFor: { title: "Report", titleMatch: "prefix", text: "clicks:1", timeout: 3000 } });
  check("click accepts the same prefix contract", !clicked.error && clicked.result.postcondition?.stable === true);
  const failedClick = await call("browser_click", { tabId, locator: { by: "css", value: "#count" }, waitFor: { title: "Never", titleMatch: "prefix", timeout: 350 } });
  check("failed prefix postcondition does not repeat click", timedOut(failedClick) && /click was dispatched/.test(failedClick.result.message) && (await content()).includes("clicks:2"));
  await close(tabId);
} catch (error) {
  check("suite completed", false, String(error));
} finally {
  for (const tabId of [...owned]) { try { await close(tabId); } catch (error) { check("cleanup", false, String(error)); } }
  try {
    const final = await ok("browser_tabs");
    check("original tabs retained", initial?.tabs.every(t => final.tabs.some(a => a.tabId === t.tabId)));
    check("owned tabs closed", owned.size === 0);
  } catch (error) { check("inspection", false, String(error)); }
  if (session) {
    try { check("session closed", (await fetch(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": session } })).ok); }
    catch (error) { check("session cleanup", false, String(error)); }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ timestamp: new Date().toISOString(), checks, calls }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, passed: checks.filter(c => c.passed).length, total: checks.length }));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
