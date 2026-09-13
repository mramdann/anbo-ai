import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const arg = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const endpoint = new URL(arg("mcp-url")), workspace = arg("workspace"), output = arg("output");
if (!workspace || !output || existsSync(output) || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw Error("Pass --mcp-url loopback, --workspace, and a fresh --output");
}
const calls = [], checks = [], owned = new Set();
let sequence = 0, session, origin, initial;
const page = `<!doctype html><meta charset="utf-8"><title>Direct locator</title>
<style>body{font:16px sans-serif}button,input{margin:4px;padding:8px}iframe{width:600px;height:140px}</style>
<h1>Account details</h1><label for="email">Email</label><input id="email">
<button id="apply">Apply</button><output id="state">ready</output><output id="count">clicks:0</output>
<button onclick="record()">Duplicate</button><button onclick="record()">Duplicate</button>
<button onclick="record()">Cross frame</button><div id="shadow"></div>
<a href="./detail">Open details</a><iframe src="/frame"></iframe>
${"<span hidden>background data</span>".repeat(6000)}
<script>
let clicks=0;window.record=()=>document.querySelector('#count').textContent='clicks:'+ ++clicks;
document.querySelector('#apply').onclick=()=>{record();document.querySelector('#state').textContent='Applied';document.title='Saved 1'};
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow email<input></label>';
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/frame") res.end('<!doctype html><title>Frame</title><button onclick="parent.record()">Cross frame</button>');
  else if (req.url === "/detail") res.end('<!doctype html><title>Details</title><h1>Details ready</h1>');
  else res.end(page);
});
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }), signal: AbortSignal.timeout(20000),
  });
  if (method === "initialize") session = response.headers.get("Mcp-Session-Id");
  const payload = await response.json();
  if (!response.ok || payload.error) throw Error(JSON.stringify(payload));
  return payload.result;
}
async function call(name, args = {}) {
  const start = performance.now(), envelope = await rpc("tools/call", { name, arguments: args });
  const text = envelope.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
  let result;
  try { result = JSON.parse(text); } catch { result = { message: text }; }
  const sample = { name, args, result, error: envelope.isError === true, wallMs: performance.now() - start };
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw Error(JSON.stringify(sample));
  return sample.result;
}
function check(name, passed, detail) {
  const result = { name, passed: !!passed, detail };
  checks.push(result);
  console.log(JSON.stringify(result));
}
async function close(tabId) {
  const page = await ok("browser_get_url", { tabId });
  if (!page.url.startsWith(origin + "/")) throw Error("Owned tab changed origin; refusing cleanup");
  await ok("browser_close", { tabId, workspace, endSession: true });
  owned.delete(tabId);
}
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anbo-direct-locator-smoke", version: "1" } });
  initial = await ok("browser_tabs");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const { tabId } = await ok("browser_open", { workspace, url: origin });
  owned.add(tabId);
  await ok("browser_wait", { tabId, condition: "load", loadState: "complete", timeout: 8000 });
  const email = await ok("browser_type", { tabId, locator: { by: "label", value: "Email", exact: true }, text: "person@example.test" });
  check("label type on a large DOM verifies its value and returns a reusable ref", email.valueVerified === true && !!email.ref);
  const value = await ok("browser_get_property", { tabId, ref: email.ref, properties: ["value"] });
  check("returned ref reads the exact typed value", value.values?.value === "person@example.test");
  const shadow = await ok("browser_type", { tabId, locator: { by: "label", value: "Shadow email", exact: true }, text: "shadow@example.test" });
  check("unique label resolves inside open Shadow DOM", shadow.valueVerified === true);
  const heading = await ok("browser_get_text", { tabId, locator: { by: "role", value: "heading", name: "Account details", exact: true } });
  check("semantic read needs no preliminary find", heading.text === "Account details");
  const clicked = await ok("browser_click", { tabId, locator: { by: "role", value: "button", name: "Apply", exact: true }, waitFor: { title: "Saved", titleMatch: "prefix", text: "Applied", timeout: 5000 } });
  check("direct click still checks compound readiness", clicked.ok === true && clicked.postcondition?.stable === true);
  const count = async () => (await ok("browser_get_text", { tabId, locator: { by: "css", value: "#count" } })).text;
  check("unique click dispatched once", await count() === "clicks:1");
  for (const name of ["Duplicate", "Cross frame"]) {
    const ambiguous = await call("browser_click", { tabId, locator: { by: "role", value: "button", name, exact: true, timeout: 1000 } });
    check(`${name}: ambiguity refused without input`, ambiguous.error && /ambiguous_target/.test(ambiguous.result.message) && await count() === "clicks:1", ambiguous);
  }
  const missing = await call("browser_click", { tabId, locator: { by: "css", value: "#invented", timeout: 350 } });
  check("missing CSS never falls back to a different target", missing.error && /timeout/.test(missing.result.message) && await count() === "clicks:1");
  const both = await call("browser_type", { tabId, ref: email.ref, locator: { by: "label", value: "Email", exact: true }, text: "wrong" });
  check("ref plus locator is rejected", both.error && /invalid_request/.test(both.result.message));
  const expired = await call("browser_get_property", { tabId, ref: email.ref, properties: ["value"] });
  check("ref older than the retained scans is rejected rather than guessed", expired.error && /stale_ref/.test(expired.result.message));
  const protectedValue = await ok("browser_get_property", { tabId, locator: { by: "label", value: "Email", exact: true }, properties: ["value"] });
  check("rejected type left the input unchanged", protectedValue.values?.value === "person@example.test");
  const navigation = await ok("browser_click", { tabId, locator: { by: "role", value: "link", name: "Open details", exact: true }, waitFor: { url: origin + "/detail", title: "Details", timeout: 5000 } });
  check("semantic link works with a relative destination and exact readiness", navigation.page?.url === origin + "/detail" && navigation.postcondition?.stable === true);
  check("successful direct workflow required no browser_find calls", !calls.some(c => c.name === "browser_find"));
  await close(tabId);
} catch (error) {
  check("suite completed", false, String(error));
} finally {
  for (const tabId of [...owned]) try { await close(tabId); } catch (error) { check("cleanup", false, String(error)); }
  try {
    const final = await ok("browser_tabs");
    check("original tabs retained", initial?.tabs.every(t => final.tabs.some(a => a.tabId === t.tabId)));
    check("owned tabs closed", owned.size === 0);
  } catch (error) { check("inspection", false, String(error)); }
  if (session) try { check("MCP session closed", (await fetch(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": session } })).ok); } catch (error) { check("session cleanup", false, String(error)); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ timestamp: new Date().toISOString(), checks, calls }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, passed: checks.filter(c => c.passed).length, total: checks.length }));
  if (checks.some(c => !c.passed)) process.exitCode = 1;
}
