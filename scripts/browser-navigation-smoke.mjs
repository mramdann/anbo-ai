import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const endpoint = new URL(argument("mcp-url", "http://127.0.0.1:7331/mcp"));
const workspace = argument("workspace"), output = argument("output");
if (!workspace || !output) throw Error("Pass --workspace and --output explicitly");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw Error("Only a loopback Anbo MCP endpoint is supported");
}
const calls = [], checks = [], requests = [], held = new Set(), owned = new Set();
let sequence = 0, origin, before, after;
async function call(name, args) {
  const started = performance.now();
  let result, error;
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(25_000),
    });
    const envelope = await response.json();
    const content = envelope.result?.content?.find(item => item.type === "text")?.text;
    try { result = JSON.parse(content); } catch { result = { message: content }; }
    error = envelope.error ?? (envelope.result?.isError ? result : undefined);
    if (!response.ok || (!result && !error)) error ??= { status: response.status };
  } catch (cause) { error = { message: String(cause) }; }
  const sample = { name, args, wallMs: Math.round(performance.now() - started), result, error };
  calls.push(sample);
  return sample;
}
async function ok(name, args) {
  const sample = await call(name, args);
  if (sample.error) throw Error(`${name}: ${JSON.stringify(sample.error)}`);
  return sample.result;
}
function check(name, passed, details = {}) {
  const entry = { name, passed: Boolean(passed), ...details };
  checks.push(entry); console.log(JSON.stringify(entry));
}
const body = '<!doctype html><title>Navigation ready</title><body><button id="ready">Navigation ready</button></body>';
function send(response) {
  held.delete(response);
  if (!response.destroyed) {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(body);
  }
}
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, started: Date.now() });
  if (request.url.startsWith("/held/")) held.add(response);
  else send(response);
});
async function closeOwned(tabId) {
  const tabs = await ok("browser_tabs", {});
  const tab = tabs.tabs.find(item => item.tabId === tabId);
  if (tab && ![tab.url, tab.pendingUrl].some(url => url?.startsWith(`${origin}/`))) {
    throw Error(`Refusing to close a changed tab: ${tabId}`);
  }
  await ok("browser_close", { tabId, workspace }); owned.delete(tabId);
}
try {
  before = await ok("browser_tabs", {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (let round = 1; round <= 3; round++) {
    let tabId;
    try {
      ({ tabId } = await ok("browser_open", { workspace, url: `${origin}/held/${round}` }));
      owned.add(tabId);
      const requestDeadline = Date.now() + 5000;
      while (!held.size && Date.now() < requestDeadline) await delay(20);
      check(`request reached fixture ${round}`, held.size > 0);
      const read = await call("browser_get_url", { tabId });
      check(`URL readable before response headers ${round}`, !read.error && read.wallMs < 1500, { sample: read });
      const loading = await ok("browser_tabs", {});
      check(`pending target retained ${round}`, loading.tabs.some(tab => tab.tabId === tabId && tab.loading && tab.pendingUrl === `${origin}/held/${round}`));
      for (const response of [...held]) send(response);
      await ok("browser_wait", { tabId, condition: "load", loadState: "complete", timeout: 5000 });
      const ready = await ok("browser_find", { tabId, by: "css", value: "#ready", limit: 1, timeout: 2000 });
      check(`first document ready ${round}`, ready.matches.length === 1);
      check(`initial navigation not replayed ${round}`, requests.filter(request => request.url === `/held/${round}`).length === 1);
      const nextUrl = `${origin}/next/${round}?text=hello%20world&quoted=%22test%22#section`;
      await ok("browser_navigate", { tabId, url: nextUrl });
      await ok("browser_wait", { tabId, condition: "url", url: nextUrl, timeout: 5000 });
      const current = await ok("browser_get_url", { tabId });
      check(`explicit navigation and exact URL ${round}`, current.url === nextUrl, { current: current.url });
      const interruptedUrl = `${origin}/held/interrupted/${round}`;
      await ok("browser_navigate", { tabId, url: interruptedUrl });
      const interruptedDeadline = Date.now() + 5000;
      while (!held.size && Date.now() < interruptedDeadline) await delay(20);
      check(`replacement starts with a pending request ${round}`, held.size > 0);
      await ok("browser_navigate", { tabId, url: nextUrl });
      await ok("browser_wait", { tabId, condition: "load", loadState: "complete", timeout: 5000 });
      for (const response of [...held]) send(response);
      await delay(300);
      const finalUrl = await ok("browser_get_url", { tabId });
      check(`new target survives a cancelled navigation ${round}`, finalUrl.url === nextUrl, { current: finalUrl.url });
    } catch (cause) {
      check(`scenario completed ${round}`, false, { error: String(cause) });
    } finally {
      for (const response of [...held]) send(response);
      if (tabId) {
        try { await closeOwned(tabId); }
        catch (cause) { check(`cleanup ${round}`, false, { error: String(cause) }); }
      }
    }
  }
} finally {
  for (const response of [...held]) send(response);
  for (const tabId of [...owned]) {
    try { await closeOwned(tabId); } catch {}
  }
  try { after = await ok("browser_tabs", {}); } catch {}
  check("original tabs and focus preserved", before && after && before.activeSpaceId === after.activeSpaceId && before.activeTabId === after.activeTabId && before.tabs.every(tab => after.tabs.some(item => item.tabId === tab.tabId)));
  check("owned tabs closed", owned.size === 0);
  server.closeAllConnections(); server.close();
  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ endpoint: endpoint.href, workspace, checks, calls, requests, before, after, unclosedTabs: [...owned] }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output: destination, passed: checks.filter(item => item.passed).length, total: checks.length }));
  if (checks.some(item => !item.passed)) process.exitCode = 1;
}
