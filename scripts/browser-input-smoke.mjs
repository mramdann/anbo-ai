import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const endpoint = new URL(argument("mcp-url", "http://127.0.0.1:7331/mcp"));
const workspace = argument("workspace");
const output = argument("output");
const repeats = Number(argument("repeats", "10"));
if (!workspace || !output) throw new Error("Pass --workspace and --output explicitly");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw new Error("Only a loopback Anbo MCP endpoint is supported");
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 30) throw new Error("Use 1-30 repeats");

const calls = [], checks = [], owned = new Set();
let sequence = 0;
async function call(name, args) {
  const started = performance.now();
  let result, error;
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
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
function check(mode, round, passed, details = {}) {
  const entry = { mode, round, passed: Boolean(passed), ...details };
  checks.push(entry);
  console.log(JSON.stringify(entry));
}
const markup = `<!doctype html><html><head><meta charset="utf-8"><title>Owned native input regression</title>
<style>body{font:16px sans-serif}button,input{padding:12px;margin:12px}output{display:block}</style></head><body>
<button id="count">Click target</button><output id="click-count">0</output>
<form><input id="input" aria-label="Input"><button>Submit</button></form><output id="submit-count">0</output>
<script>
let clicks=0,submits=0;
document.getElementById('count').onclick=()=>document.getElementById('click-count').textContent=String(++clicks);
document.querySelector('form').onsubmit=event=>{event.preventDefault();document.getElementById('submit-count').textContent=String(++submits)};
</script></body></html>`;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(markup);
});
let before, origin, failure;
async function closeOwned(tabId) {
  const current = await ok("browser_get_url", { tabId });
  if (!current.url.startsWith(`${origin}/`)) throw new Error(`Refusing to close changed tab ${tabId}`);
  await ok("browser_close", { tabId, workspace });
  owned.delete(tabId);
}
try {
  before = await ok("browser_tabs", {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (let round = 1; round <= repeats; round++) {
    for (const mode of ["cold-mouse", "cold-enter-default", "cold-enter-zero"]) {
      let tabId;
      try {
        ({ tabId } = await ok("browser_open", { workspace, url: `${origin}/${mode}/${round}` }));
        owned.add(tabId);
        const invoke = (name, args = {}) => ok(name, { tabId, ...args });
        const find = async selector => (await invoke("browser_find", { by: "css", value: selector, limit: 1, timeout: 3000 })).matches[0].ref;
        await invoke("browser_emulate", { width: 1280, height: 720, scale: 1, mobile: false });
        await invoke("browser_wait", { condition: "load", loadState: "complete", timeout: 5000 });
        if (mode === "cold-mouse") {
          const ref = await find("#count");
          const first = await invoke("browser_click", { ref });
          const second = await invoke("browser_click", { ref });
          const actual = await invoke("browser_get_text", { ref: await find("#click-count"), maxLength: 100 });
          check(mode, round, actual.text === "2", { actual: actual.text, durations: [first.durationMs, second.durationMs] });
        } else {
          await invoke("browser_type", { ref: await find("#input"), text: "native input fixture" });
          const pressed = await invoke("browser_press", { key: "Enter", ...(mode.endsWith("zero") ? { observationTimeout: 0 } : {}) });
          await delay(150);
          const actual = await invoke("browser_get_text", { ref: await find("#submit-count"), maxLength: 100 });
          check(mode, round, actual.text === "1", { actual: actual.text, pressed });
        }
      } catch (cause) {
        check(mode, round, false, { error: String(cause) });
      } finally {
        if (tabId !== undefined && owned.has(tabId)) {
          try { await closeOwned(tabId); } catch (cause) { check("cleanup", round, false, { tabId, error: String(cause) }); }
        }
      }
    }
  }
} catch (cause) { failure = String(cause); }
finally {
  for (const tabId of [...owned]) {
    try { await closeOwned(tabId); } catch (cause) { check("cleanup", 0, false, { tabId, error: String(cause) }); }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const after = await call("browser_tabs", {});
check("original-tabs", 0, !after.error && before?.tabs.every(tab => after.result.tabs.some(item => item.tabId === tab.tabId)));
check("owned-tabs-closed", 0, owned.size === 0);
const path = resolve(output);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify({ timestamp: new Date().toISOString(), endpoint: String(endpoint), workspace, repeats, failure, checks, calls, before, after: after.result, unclosedTabs: [...owned] }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output: path, passed: checks.filter(item => item.passed).length, total: checks.length, failure }));
if (failure || checks.some(item => !item.passed)) process.exitCode = 1;
