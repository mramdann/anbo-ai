import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1];
const workspace = resolve(arg("workspace"));
const output = resolve(arg("output"));
const binary = arg("binary");
const endpoint = "http://127.0.0.1:7332/mcp";
if (!process.argv.includes("--workspace") || !process.argv.includes("--output") || !output.endsWith(".json") || existsSync(output) || existsSync(output.replace(/\.json$/, ".html"))) {
  throw Error("Pass --workspace and a fresh .json --output; optional --binary records build identity. Dev port 7332 only.");
}
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const buildBefore = process.argv.includes("--binary") ? digest(binary) : null;
const artifactRoot = join(workspace, ".anbo", "artifacts");
const legacy = () => Object.fromEntries((existsSync(artifactRoot) ? readdirSync(artifactRoot, { withFileTypes: true }) : [])
  .filter(entry => entry.isFile()).map(entry => [entry.name, digest(join(artifactRoot, entry.name))]).sort(([a], [b]) => a.localeCompare(b)));
const legacyBefore = legacy(), checks = [], calls = [], captures = [], samples = [], sessions = [], owned = new Set();
let sequence = 0, session, tabId, initial, origin, outside;
function check(name, passed, detail) {
  const entry = { name, passed: !!passed, detail };
  checks.push(entry);
  console.log(JSON.stringify(entry));
  assert.ok(passed, name);
}
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><title>Screenshot artifact validation</title>
<style>body{background:#131b28;color:#e2e8f0;font:18px system-ui;padding:48px}main{max-width:760px;padding:32px;border:1px solid #36455d;border-radius:20px}h1{color:#93c5fd}small{color:#94a3b8}button{padding:12px 24px;border-radius:8px}</style>
<main><small>ANBO / ARTIFACT VALIDATION</small><h1>Captures with context</h1><p>One task folder. Numbered images. Preserved originals.</p><button id="apply">Verify browser input</button><p id="state">ready</p></main>
<script>document.querySelector('#apply').onclick=()=>document.querySelector('#state').textContent='verified';</script>`);
});
async function rpc(method, params, selected = session) {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...(selected ? { "Mcp-Session-Id": selected } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }), signal: AbortSignal.timeout(30000),
  });
  if (method === "initialize") sessions.push(response.headers.get("Mcp-Session-Id"));
  const payload = await response.json();
  if (!response.ok || payload.error) throw Error(JSON.stringify(payload));
  return payload.result;
}
async function call(name, args = {}, selected = session) {
  const started = performance.now();
  const envelope = await rpc("tools/call", { name, arguments: args }, selected);
  const text = envelope.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  let result;
  try { result = JSON.parse(text); } catch { result = { message: text }; }
  const sample = { name, args, result, error: envelope.isError === true, wallMs: performance.now() - started };
  calls.push(sample);
  return { ...sample, images: envelope.content?.filter(item => item.type === "image") ?? [] };
}
async function ok(name, args = {}, selected = session) {
  const response = await call(name, args, selected);
  assert.equal(response.error, false, JSON.stringify(response));
  return response.result;
}
const initialize = () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "artifact-smoke", version: "1" } }, null);
const manifest = result => readFileSync(result.manifestPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
async function capture(args, selected = session) {
  const response = await call("browser_screenshot", { tabId, inline: false, ...args }, selected);
  assert.equal(response.error, false, JSON.stringify(response));
  const result = response.result;
  const part = relative(join(artifactRoot, "browser"), result.path);
  assert.ok(!part.startsWith("..") && !part.includes(":") && part.split(sep).length === 2);
  assert.ok(result.metadataRecorded);
  assert.equal(readFileSync(result.path).length, result.size);
  captures.push(result);
  return response;
}
try {
  await initialize();
  session = sessions[0];
  const definitions = await rpc("tools/list", {});
  const schema = definitions.tools.find(tool => tool.name === "browser_screenshot").inputSchema;
  check("task context and image label discoverable through MCP", schema.properties.context && schema.properties.label);
  initial = await ok("browser_tabs");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  ({ tabId } = await ok("browser_open", { workspace, url: `${origin}/private-path-marker?key=query-marker#fragment-marker` }));
  owned.add(tabId);
  await ok("browser_wait", { tabId, condition: "load", loadState: "complete", timeout: 8000 });
  const context = "Artifact validation";
  const first = await capture({ context, label: "Before input", inline: true });
  check("omitted workspace routes to owning tab and descriptive folder", basename(dirname(first.result.path)).includes("_artifact-validation_") && basename(first.result.path) === "001-before-input.png");
  check("PNG is valid and inline reply preserved", readFileSync(first.result.path).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && first.images.length === 1);
  await ok("browser_click", { tabId, locator: { by: "css", value: "#apply" } });
  const state = await ok("browser_get_text", { tabId, locator: { by: "css", value: "#state" } });
  check("native click and text read still work", state.text === "verified");
  const jpeg = await capture({ workspace, context, label: "After input", format: "jpeg", quality: 75 });
  const webp = await capture({ context, label: "WebP export", format: "webp", quality: 75 });
  check("same task reuses group with ordered descriptive labels", jpeg.result.groupId === first.result.groupId && webp.result.groupId === first.result.groupId && basename(jpeg.result.path) === "002-after-input.jpg" && webp.result.sequence === 3);
  check("JPEG and WebP bytes match their formats; inline false omits image", readFileSync(jpeg.result.path).subarray(0, 3).equals(Buffer.from([255,216,255])) && readFileSync(webp.result.path).subarray(8, 12).toString() === "WEBP" && jpeg.images.length === 0);
  const records = manifest(first.result);
  const serialized = JSON.stringify(records);
  check("manifest records actor, context and label with origin-only URL", records.length === 3 && records.every(record => record.sourceOrigin === origin && record.actor?.brand && record.context === context) && !/private-path-marker|query-marker|fragment-marker/.test(serialized));
  const fallback = await capture({ label: "Automatic hostname" });
  check("missing context has a deterministic host fallback", fallback.result.context === "127.0.0.1" && fallback.result.groupId !== first.result.groupId);
  const safe = await capture({ context: "../Artifact traversal", label: "../../outside:CON" });
  check("context and label are names, never destination paths", basename(safe.result.path) === "001-outside-con.png");
  outside = await mkdtemp(join(tmpdir(), "anbo-artifact-guard-"));
  const mismatch = await call("browser_screenshot", { tabId, workspace: outside, inline: false });
  check("foreign workspace rejected without creating outside artifacts", mismatch.error && !existsSync(join(outside, ".anbo")));
  for (const invalid of [{ context: "" }, { label: "x\u202ey" }, { context: "x".repeat(121) }, { label: false }]) {
    const result = await call("browser_screenshot", { tabId, ...invalid, inline: false });
    check(`invalid metadata rejected: ${JSON.stringify(invalid).slice(0, 65)}`, result.error);
  }
  for (let index = -2; index < 16; index++) {
    const response = await capture({ context, label: `Latency ${index + 3}`, format: "jpeg", quality: 75 });
    assert.equal(response.result.groupId, first.result.groupId);
    if (index >= 0) samples.push(response.wallMs);
  }
  check("repeated captures append exactly once with unique sequence", manifest(first.result).length === 21 && new Set(manifest(first.result).map(record => record.sequence)).size === 21);
  await initialize();
  const foreign = await capture({ context, label: "Second owner", endSession: true }, sessions[1]);
  check("same-brand independent MCP owner gets a separate run", foreign.result.groupId !== first.result.groupId && foreign.result.controlId !== first.result.controlId);
  const ended = await capture({ context, label: "Task complete", endSession: true });
  check("final screenshot saves to original group before ending session", ended.result.groupId === first.result.groupId && ended.result.sessionEnded === true);
  const next = await capture({ context, label: "New session", endSession: true });
  check("next control session starts a fresh numbered run", next.result.groupId !== first.result.groupId && next.result.sequence === 1);
} catch (error) {
  checks.push({ name: "suite completed", passed: false, detail: String(error) });
  console.error(error);
} finally {
  for (const id of owned) {
    try {
      const state = await ok("browser_get_url", { tabId: id });
      assert.ok(state.url.startsWith(origin + "/"), "Refusing to close a tab navigated away from owned fixture");
      await ok("browser_close", { tabId: id, workspace, endSession: true });
      owned.delete(id);
    } catch (error) { checks.push({ name: "owned tab cleanup", passed: false, detail: String(error) }); }
  }
  try {
    const final = await ok("browser_tabs");
    check("original tabs retained and no terminal or agent spawned", initial?.tabs.every(tab => final.tabs.some(other => other.tabId === tab.tabId)) && initial?.otherTabsInSpace === final.otherTabsInSpace && owned.size === 0);
    assert.deepEqual(legacy(), legacyBefore);
    check("all old root-level artifacts retain exact SHA-256", true, { files: Object.keys(legacyBefore).length });
    check("Dev build unchanged during live test", !buildBefore || digest(binary) === buildBefore);
  } catch (error) { checks.push({ name: "final invariants", passed: false, detail: String(error) }); }
  for (const id of sessions) if (id) await fetch(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": id } }).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (outside && resolve(outside).startsWith(resolve(tmpdir()) + sep) && basename(outside).startsWith("anbo-artifact-guard-")) await rm(outside, { recursive: true });
}
const sorted = [...samples].sort((a, b) => a - b);
const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
const report = { createdAt: new Date().toISOString(), endpoint, workspace, buildSha256: buildBefore, passed: checks.every(check => check.passed), checks, captures, calls, latency: { samples: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), valuesMs: samples }, limits: ["Single local fixture; not a heavy-site benchmark.", "Current Dev capture latency includes native capture, encoding, storage and MCP transport. No old-build latency baseline.", "No window geometry or emulation actions issued; no old files moved or removed."] };
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
await writeFile(output.replace(/\.json$/, ".html"), `<!doctype html><meta charset="utf-8"><title>Anbo artifact organization validation</title><style>body{font:16px system-ui;background:#101722;color:#dce5f3;margin:48px auto;max-width:1100px;padding:0 24px}h1{font-size:34px}small{color:#97a9bf}section{padding:24px;background:#192332;border-radius:16px;margin:20px 0}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #334155}code{overflow-wrap:anywhere}.pass{color:#6ee7b7}.fail{color:#fca5a5}a{color:#93c5fd}</style><small>ANBO / DEV / ${escape(report.createdAt)}</small><h1>Screenshot artifacts, organized</h1><section><h2>${report.passed ? "PASS" : "FAIL"}: ${checks.filter(check => check.passed).length}/${checks.length} checks</h2><p>New: task folders, numbered image labels, append-only manifest. Existing: ${Object.keys(legacyBefore).length} root files hash-verified.</p><p>JPEG capture, ${samples.length} measured calls: p50 ${percentile(.5)?.toFixed(1)} ms / p95 ${percentile(.95)?.toFixed(1)} ms.</p><p>${report.limits.map(escape).join("<br>")}</p></section><section><h2>Checks</h2><table>${checks.map(check => `<tr><td class="${check.passed ? "pass" : "fail"}">${check.passed ? "PASS" : "FAIL"}</td><td>${escape(check.name)}${check.detail ? `<br><small>${escape(JSON.stringify(check.detail))}</small>` : ""}</td></tr>`).join("")}</table></section><section><h2>Example captures</h2>${captures.slice(0, 5).map(capture => `<p><a href="${escape(relative(dirname(output), capture.path).replaceAll("\\", "/"))}">${escape(basename(capture.path))}</a><br><small>${escape(capture.groupId)}</small></p>`).join("")}</section><small>Build SHA-256: ${escape(buildBefore)}</small>`, { flag: "wx" });
console.log(JSON.stringify({ output, passed: report.passed, checks: checks.length, latency: report.latency }));
if (!report.passed) process.exitCode = 1;
