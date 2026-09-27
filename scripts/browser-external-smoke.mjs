import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, relative, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createFrameTransport } from "../extensions/anbo-browser/frames.js";

const browser = process.argv[2] ?? "chrome";
if (!["chrome", "edge"].includes(browser)) throw new Error("Choose chrome or edge");
const suffix = browser === "chrome" ? "Google/Chrome/Application/chrome.exe" : "Microsoft/Edge/Application/msedge.exe";
const executable = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean).map((root) => join(root, suffix)).find(existsSync);
if (!executable) throw new Error(`${browser} is not installed in a standard location`);
const parent = resolve(".anbo/browser-external-smoke");
await mkdir(parent, { recursive: true });
const workspace = await realpath(".");
const ownedParent = await realpath(parent);
const parentWithin = relative(workspace, ownedParent);
if (!parentWithin || parentWithin.startsWith("..") || isAbsolute(parentWithin)) throw new Error("The fixture directory must stay inside the workspace");
const profile = await mkdtemp(join(parent, `${browser}-`));
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(request.url === "/frame" ? '<!doctype html><title>Child</title><input id="field" aria-label="Child input">' : `<!doctype html><title>External fixture</title><button id="button" onclick="this.dataset.trusted=String(event.isTrusted)">Test button</button><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const child = spawn(executable, [`--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--site-per-process", "--host-resolver-rules=MAP localhost 127.0.0.1", "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
let requestId = 0;
const pending = new Map();
let transport;
let protocolCalls = 0;
let childProtocolCalls = 0;
const failures = [];
child.on("error", (error) => failures.push(String(error)));

async function until(action, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch {}
    await delay(50);
  }
  throw new Error("Fixture timed out");
}

function raw(source, method, params = {}) {
  const id = ++requestId;
  protocolCalls += 1;
  if (source.sessionId) childProtocolCalls += 1;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, { done, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(source.sessionId && { sessionId: source.sessionId }) }));
  });
}

try {
  const port = await until(async () => Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]));
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  assert.ok(page?.webSocketDebuggerUrl);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.done(message.result ?? {});
    } else if (message.method) {
      try { transport?.event({ tabId: 1, sessionId: message.sessionId }, message.method, message.params ?? {}); } catch (error) { failures.push(String(error)); }
    }
  };
  transport = createFrameTransport({ debugger: { sendCommand: raw } }, 1, () => {});
  const version = await raw({}, "Browser.getVersion");
  await transport.start();
  await transport.command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  const tree = await until(async () => {
    const value = await transport.command("Page.getFrameTree", {});
    return value.frameTree?.childFrames?.[0]?.frame.url.includes("/frame") ? value.frameTree : null;
  });
  const context = async (frameId) => (await transport.command("Page.createIsolatedWorld", { frameId, worldName: "anbo-browser-automation" })).executionContextId;
  const evaluate = async (contextId, expression) => {
    const result = await transport.command("Runtime.evaluate", { contextId, expression, returnByValue: true, userGesture: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
    return result.result.value;
  };
  const rootContext = await context(tree.frame.id);
  const childContext = await context(tree.childFrames[0].frame.id);
  assert.notEqual(rootContext, childContext);
  await until(() => evaluate(childContext, 'Boolean(document.querySelector("#field"))'));
  await evaluate(childContext, 'document.querySelector("#field").focus(); true');
  await transport.command("Input.insertText", { text: "connected" });
  assert.equal(await evaluate(childContext, 'document.querySelector("#field").value'), "connected");
  const point = await evaluate(rootContext, '(() => { const rect = document.querySelector("#button").getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()');
  await transport.command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await transport.command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  assert.equal(await evaluate(rootContext, 'document.querySelector("#button").dataset.trusted'), "true");
  const screenshot = await transport.command("Page.captureScreenshot", { format: "png" });
  assert.ok(screenshot.data.length > 100);
  await delay(500);
  const beforeIdle = protocolCalls;
  await delay(1000);
  const idleCommands = protocolCalls - beforeIdle;
  const samples = [];
  for (let index = 0; index < 50; index += 1) {
    const start = performance.now();
    assert.equal(await evaluate(childContext, 'document.querySelector("#field").value'), "connected");
    samples.push(performance.now() - start);
  }
  samples.sort((first, second) => first - second);
  assert.ok(childProtocolCalls > 0);
  const sources = "src-tauri/src/modules/browser_automation";
  const overlay = await readFile(join(sources, "activityOverlay.js"), "utf8");
  await transport.command("Runtime.evaluate", { expression: `${overlay}\nwindow.dispatchEvent(new CustomEvent('anbo-automation-visual',{detail:{sequence:1,requestId:1,controlId:1,phase:'done',method:'click',actor:{label:'Fixture',brand:'anbo'}}}));`, returnByValue: true });
  await until(() => evaluate(rootContext, 'Boolean(document.querySelector("anbo-automation-visual"))'));
  await transport.command("Runtime.addBinding", { name: "__anboDesignPost", executionContextName: "anbo-browser-automation" });
  const accessible = await readFile(join(sources, "accessibleName.js"), "utf8");
  const visibility = (await readFile(join(sources, "visibility.rs"), "utf8")).match(/r#"([\s\S]*?)"#/)?.[1];
  assert.ok(visibility);
  const design = await readFile(join(sources, "designLayer.js"), "utf8");
  const installed = await evaluate(rootContext, `(() => { ${accessible}\n${visibility}\n${design}\nreturn globalThis.__anboDesign.configure({tool:'box',model:null}); })()`);
  assert.equal(installed.ok, true);
  assert.equal(await evaluate(rootContext, 'globalThis.__anboDesign.alive()'), true);
  await transport.cleanup();
  assert.equal(await evaluate(rootContext, 'Boolean(globalThis.__anboDesign?.alive())'), false);
  assert.equal(await evaluate(rootContext, 'Boolean(document.querySelector("anbo-automation-visual"))'), false);
  assert.deepEqual(failures, []);
  assert.equal(idleCommands, 0);
  console.log(JSON.stringify({ scope: "Real isolated headless browser and frame adapter; not the installed extension, native messaging, Anbo end-to-end, or production CPU/RAM.", browser, version: version.product, crossOriginFrameInput: true, outOfProcessFrame: true, trustedClick: true, screenshot: true, cursorOverlay: true, designLayer: true, cleanup: true, idleCommands, reads: samples.length, readMs: { p50: samples[25], p95: samples[47], max: samples.at(-1) } }, null, 2));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await transport?.cleanup().catch(() => {});
    await raw({}, "Browser.close").catch(() => {});
    socket.close();
  }
  transport?.dispose();
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Fixture closed")); }
  pending.clear();
  await new Promise((done) => server.close(done));
  if (child.exitCode === null) await until(() => child.exitCode !== null, 5000).catch(() => { child.kill(); });
  const ownedProfile = await realpath(profile);
  const within = relative(ownedParent, ownedProfile);
  if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Refusing to clean an unowned browser profile");
  await rm(ownedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
