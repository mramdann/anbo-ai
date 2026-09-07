import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const endpoint = new URL(argument("mcp-url", "http://127.0.0.1:7332/mcp"));
const workspace = argument("workspace");
const output = argument("output");
if (!workspace || !output) throw new Error("Pass --workspace and --output explicitly");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw new Error("Only a loopback Anbo MCP endpoint is supported");
}
const calls = [];
const checks = [];
const owned = new Set();
let sequence = 0;
async function call(name, args) {
  const started = performance.now();
  let result;
  let error;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(45_000),
    });
    const envelope = await response.json();
    const content = envelope.result?.content?.find(item => item.type === "text")?.text;
    if (content) {
      try { result = JSON.parse(content); } catch { result = { message: content }; }
    }
    if (!response.ok || envelope.error || envelope.result?.isError) error = envelope.error ?? result ?? { status: response.status };
    if (!result && !error) error = { message: "Missing tool result" };
  } catch (cause) { error = { message: String(cause) }; }
  const sample = { name, wallMs: Math.round(performance.now() - started), result, error };
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw new Error(`${name}: ${JSON.stringify(sample.error)}`);
  return sample.result;
}
function check(name, passed, detail = {}) {
  const entry = { name, passed: Boolean(passed), ...detail };
  checks.push(entry);
  console.log(JSON.stringify(entry));
}
const html = `<!doctype html><html><head><title>Fixture</title><style>body{font:16px sans-serif}input,button{padding:12px;margin:12px}</style></head><body>
<input id="reset" aria-label="Resetting input"><input id="query" aria-label="Query">
<button id="count">Count only</button><button id="replace">Replace input</button>
<output id="state">idle</output><p id="key-count">keys:0</p><p id="click-count">clicks:0</p>
<div hidden>hidden-noise</div><style>.style-noise{color:red}</style><script>
window.scriptNoise='script-noise';let keys=0,clicks=0;
const state=document.querySelector('#state');
document.querySelector('#reset').addEventListener('input',event=>setTimeout(()=>{event.target.value='reset by SPA';state.textContent='input-reset-done'},200));
document.querySelector('#replace').onclick=()=>{document.querySelector('#query').outerHTML='<input id="query" aria-label="Query">'};
document.querySelector('#count').onclick=()=>document.querySelector('#click-count').textContent='clicks:'+ ++clicks;
document.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();document.querySelector('#key-count').textContent='keys:'+ ++keys;
if(event.target.id==='query'){
 const ready=()=>{history.replaceState({},'', '/results');document.title='Ready';state.textContent='final-result'};
 ready();setTimeout(()=>{document.title='Loading';state.textContent='loading'},80);setTimeout(ready,500);
}});
</script></body></html>`;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(html);
});
let failure;
let before;
try {
  before = await ok("browser_tabs", {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { tabId } = await ok("browser_open", { workspace, url: origin });
  owned.add(tabId);
  const invoke = (name, args = {}) => ok(name, { tabId, ...args });
  const find = async value => (await invoke("browser_find", { by: "css", value, limit: 1, timeout: 5000 })).matches[0].ref;
  const wait = text => invoke("browser_wait", { waitFor: { text, timeout: 5000 } });
  const content = async () => (await invoke("browser_get_text", { maxLength: 4000 })).text;
  await invoke("browser_wait", { condition: "load", loadState: "complete", timeout: 10000 });
  check("readable text excludes script/style and hidden nodes", !/script-noise|style-noise|hidden-noise/.test(await content()));
  let ref = await find("#reset");
  const typed = await invoke("browser_type", { ref, text: "expected query" });
  check("type verifies the immediate input value", typed.valueVerified === true);
  await wait("input-reset-done");
  const mismatch = await call("browser_press", { tabId, ref, expectedValue: "expected query", key: "Enter", diagnostics: true, observationTimeout: 0 });
  check("SPA input reset prevents Enter and reports timings", /input_mismatch/.test(JSON.stringify(mismatch.error)) && /inputGuard/.test(JSON.stringify(mismatch.error)) && (await content()).includes("keys:0"));
  const invalid = await call("browser_press", { tabId, expectedValue: "expected query", key: "Enter", observationTimeout: 0 });
  check("expectedValue without a ref is rejected before Enter", /invalid_request/.test(JSON.stringify(invalid.error)) && (await content()).includes("keys:0"));
  ref = await find("#query");
  await invoke("browser_type", { ref, text: "verified query" });
  const started = performance.now();
  const pressed = await invoke("browser_press", { ref, expectedValue: "verified query", key: "Enter", diagnostics: true, waitFor: { url: `${origin}/results`, title: "Ready", text: "final-result", stableFor: 250, timeout: 5000 } });
  check("guarded Enter waits through transient matching SPA state", pressed.postcondition?.matched && performance.now() - started >= 700 && (await content()).includes("keys:1"), { result: pressed });
  check("explicit postcondition replaces default submit observation", pressed.observationWindowMs === 0 && !pressed.timings.some(item => item.phase === "submitObservation"));
  const keyPhases = pressed.timings.map(item => item.phase);
  check("input guard runs after focus preparation and before native key-down", keyPhases.indexOf("focusEmulation") < keyPhases.indexOf("inputGuard") && keyPhases.indexOf("inputGuard") < keyPhases.indexOf("keyDown") && keyPhases.includes("keyUp"));
  const pending = call("browser_wait", { tabId, waitFor: { title: "Never", timeout: 1200 }, diagnostics: true });
  await delay(200);
  const readStarted = performance.now();
  await invoke("browser_get_url");
  check("postcondition wait releases the tab lock between polls", performance.now() - readStarted < 700);
  check("standalone wait obeys its deadline", /timeout/.test(JSON.stringify((await pending).error)));
  ref = await find("#count");
  const clicked = await invoke("browser_click", { ref, diagnostics: true, waitFor: { text: "clicks:1", timeout: 5000 } });
  const phases = clicked.timings.map(item => item.phase);
  check("native click exposes bounded phase timings", ["queue", "ready", "actionability", "focusEmulation", "mouseMove", "mouseDown", "mouseUp", "postcondition"].every(phase => phases.includes(phase)), { result: clicked });
  const timedOut = await call("browser_click", { tabId, ref, diagnostics: true, waitFor: { title: "Never", timeout: 500 } });
  check("failed click postcondition does not click twice", /click was dispatched/.test(JSON.stringify(timedOut.error)) && /mouseUp/.test(JSON.stringify(timedOut.error)) && (await content()).includes("clicks:2"));
  const plain = await invoke("browser_click", { ref });
  check("diagnostics are absent by default", !Object.hasOwn(plain, "timings") && (await content()).includes("clicks:3"));
  const invalidWait = await call("browser_click", { tabId, ref, waitFor: {} });
  check("malformed postcondition is rejected before clicking", /invalid_request/.test(JSON.stringify(invalidWait.error)) && (await content()).includes("clicks:3"));
  ref = await find("#reset");
  const keyTimeout = await call("browser_press", { tabId, ref, expectedValue: "reset by SPA", key: "Enter", diagnostics: true, waitFor: { title: "Never", timeout: 500 } });
  check("failed key postcondition does not submit twice", /key was dispatched/.test(JSON.stringify(keyTimeout.error)) && /keyDown/.test(JSON.stringify(keyTimeout.error)) && (await content()).includes("keys:2"));
  const allInputs = await invoke("browser_find", { by: "css", value: "#query, #replace", limit: 2, timeout: 5000 });
  await invoke("browser_click", { ref: allInputs.matches[1].ref });
  const replaced = await call("browser_press", { tabId, ref: allInputs.matches[0].ref, expectedValue: "verified query", key: "Enter", observationTimeout: 0 });
  check("replaced input is rejected before key dispatch", /stale_ref/.test(JSON.stringify(replaced.error)) && (await content()).includes("keys:2"));
} catch (cause) {
  failure = String(cause);
  for (const tabId of owned) {
    await call("browser_get_url", { tabId });
    await call("browser_get_text", { tabId, maxLength: 4000 });
    await call("browser_console_logs", { tabId, limit: 10 });
  }
}
finally {
  for (const tabId of [...owned]) {
    const closed = await call("browser_close", { tabId, workspace });
    if (!closed.error) owned.delete(tabId);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const after = await call("browser_tabs", {});
const report = { timestamp: new Date().toISOString(), endpoint: String(endpoint), workspace, before, after: after.result, failure, unclosedTabs: [...owned], checks, calls };
const path = resolve(output);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output: path, passed: checks.filter(item => item.passed).length, total: checks.length, failure, unclosedTabs: [...owned] }));
if (failure || owned.size || checks.some(item => !item.passed)) process.exitCode = 1;
