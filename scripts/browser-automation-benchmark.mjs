import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const endpoint = new URL(argument("mcp-url", "http://127.0.0.1:7331/mcp"));
const workspace = argument("workspace");
const repeats = Number(argument("repeats", "5"));
const phase = argument("phase", "baseline");
const output = argument("output");
if (!workspace || !output) throw new Error("Pass --workspace and --output explicitly");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/mcp") {
  throw new Error("Only a loopback Anbo MCP endpoint is supported");
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("Use 1-20 repeats");

const calls = [];
const checks = [];
const openedTabs = new Set();
const signals = new Set();
let sequence = 0;
let childOrigin;

async function call(name, args, label = name) {
  const started = performance.now();
  let result;
  let error;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const envelope = await response.json();
    const text = envelope.result?.content?.find(item => item.type === "text")?.text;
    if (text) {
      try { result = JSON.parse(text); } catch { result = { message: text }; }
    }
    if (!response.ok || envelope.error || envelope.result?.isError) {
      error = envelope.error ?? result ?? { status: response.status };
    }
  } catch (cause) {
    error = { message: String(cause) };
  }
  const sample = { label, tool: name, wallMs: Math.round(performance.now() - started), durationMs: result?.durationMs, error };
  calls.push(sample);
  return { result, error, sample };
}

async function ok(name, args, label) {
  const response = await call(name, args, label);
  if (response.error) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  return response.result;
}

function check(name, passed, details = {}) {
  const entry = { name, passed: Boolean(passed), ...details };
  checks.push(entry);
  console.log(JSON.stringify(entry));
}

const html = body => `<!doctype html><html><head><meta charset="utf-8"><title>Anbo isolated automation benchmark</title><style>body{font:14px sans-serif;margin:16px}button,input,select{margin:4px;padding:8px}iframe{width:300px;height:120px;display:block}output{display:block}</style></head><body>${body}</body></html>`;
const controls = `<button id="stable" onclick="document.querySelector('#count').textContent=String(++window.clickCount)">Stable target</button><output id="count">0</output><input id="text" aria-label="Fixture input"><input id="spa" aria-label="SPA input" onkeydown="if(event.key==='Enter'){event.preventDefault();document.querySelector('#spa-result').textContent='SPA received '+this.value}"><output id="spa-result"></output><output id="listener-count">active-submit-listeners:0</output><input type="checkbox" id="check" aria-label="Fixture checkbox"><select id="select" aria-label="Fixture select"><option value="a">Alpha</option><option value="b">Beta</option></select><div id="shadow"></div><script>window.clickCount=0;document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow target</button>';const submitListeners=new Set();const originalAdd=document.addEventListener.bind(document);const originalRemove=document.removeEventListener.bind(document);const reportListeners=()=>document.querySelector('#listener-count').textContent='active-submit-listeners:'+submitListeners.size;document.addEventListener=(type,listener,options)=>{if(type==='submit'){submitListeners.add(listener);reportListeners()}return originalAdd(type,listener,options)};document.removeEventListener=(type,listener,options)=>{if(type==='submit'){submitListeners.delete(listener);reportListeners()}return originalRemove(type,listener,options)};</script>`;

function serve(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/signal") {
    const token = url.searchParams.get("token");
    if (url.searchParams.has("set")) signals.add(token);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(signals.has(token)));
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/large") {
    response.end(html(`${Array.from({ length: 1200 }, (_, index) => `<button style="display:block;height:30px">Earlier ${index}</button>`).join("")}<button id="bottom">Viewport bottom target</button><script>addEventListener('load',()=>{scrollTo(0,document.body.scrollHeight);setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<output>viewport-ready</output>');scrollTo(0,document.body.scrollHeight)},100)})</script>`));
  } else if (url.pathname === "/frames") {
    const count = Math.min(32, Math.max(1, Number(url.searchParams.get("count"))));
    response.end(html(`<button id="root-target">Root target</button>${Array.from({ length: count - 1 }, (_, index) => `<iframe src="${childOrigin}/child?last=${index === count - 2}"></iframe>`).join("")}`));
  } else if (url.pathname === "/child") {
    response.end(html(`<p>Child frame</p>${url.searchParams.get("last") === "true" ? '<button id="tail-target">Tail target</button><input aria-label="Frame input">' : '<button>Other frame target</button>'}`));
  } else if (url.pathname === "/form") {
    const handler = url.searchParams.has("prevent") ? 'onsubmit="event.preventDefault();document.querySelector(\'#form-result\').textContent=\'form-submitted\'"' : "";
    response.end(html(`<form action="/submitted" ${handler}><input id="form-input" name="value" aria-label="Form input"><button type="submit">Submit fixture</button></form><output id="form-result"></output>`));
  } else if (url.pathname === "/submitted") {
    response.end(html("<p>form-navigation-complete</p>"));
  } else if (url.pathname === "/race") {
    const token = JSON.stringify(url.searchParams.get("token"));
    response.end(html(`${controls}<script>const racePoll=setInterval(async()=>{if(await fetch('/signal?token='+${token}).then(r=>r.json())){clearInterval(racePoll);document.body.insertAdjacentHTML('beforeend','<button id="delayed">Delayed target</button>')}},50)</script>`));
  } else {
    response.end(html(controls));
  }
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(tabId) {
  await ok("browser_close", { tabId, workspace });
  openedTabs.delete(tabId);
}

async function open(url) {
  const opened = await ok("browser_open", { url, workspace });
  openedTabs.add(opened.tabId);
  await ok("browser_wait", { tabId: opened.tabId, condition: "load", loadState: "complete", timeout: 10_000 });
  return opened.tabId;
}

async function find(tabId, value, label = "find") {
  return ok("browser_find", { tabId, by: "css", value, limit: 1, timeout: 5000 }, label);
}

function percentile(values, fraction) {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

const primary = http.createServer(serve);
const child = http.createServer(serve);
const before = await ok("browser_tabs", {});
let failure;
try {
  childOrigin = await listen(child);
  const origin = await listen(primary);
  let tabId = await open(`${origin}/simple`);
  for (let index = 0; index < repeats; index++) {
    await ok("browser_get_url", { tabId }, "simple.get_url");
    await ok("browser_snapshot", { tabId, maxChars: 2000 }, "simple.snapshot");
    const target = await find(tabId, "#stable", "simple.find");
    await ok("browser_click", { tabId, ref: target.matches[0].ref }, "simple.click");
  }
  let target = await find(tabId, "#stable");
  const sameRef = target.matches[0].ref;
  const firstClick = await call("browser_click", { tabId, ref: sameRef });
  const secondClick = await call("browser_click", { tabId, ref: sameRef });
  check("same DOM node retains ref across unrelated text updates", !firstClick.error && !secondClick.error);
  await ok("browser_snapshot", { tabId });
  const stale = await call("browser_click", { tabId, ref: sameRef });
  check("new snapshot rejects old ref", Boolean(stale.error), { error: stale.error });
  target = await find(tabId, "#spa");
  await ok("browser_type", { tabId, ref: target.matches[0].ref, text: "fixture" }, "simple.type");
  for (const observationTimeout of [undefined, 0]) {
    await ok("browser_press", { tabId, key: "Enter", observationTimeout }, observationTimeout === 0 ? "spa.enter.zero" : "spa.enter.default");
  }
  const resultText = await ok("browser_get_text", { tabId });
  check("SPA Enter was delivered", JSON.stringify(resultText).includes("SPA received fixture"));
  check("Enter observation removes its submit listeners", JSON.stringify(resultText).includes("active-submit-listeners:0"), { listenerCount: JSON.stringify(resultText).match(/active-submit-listeners:(\d+)/)?.[1] });
  target = await find(tabId, "#shadow-button");
  check("open Shadow DOM locator works", target.matches.length === 1);
  await close(tabId);

  for (const prevent of [true, false]) {
    tabId = await open(`${origin}/form${prevent ? "?prevent=1" : ""}`);
    target = await find(tabId, "#form-input");
    await ok("browser_type", { tabId, ref: target.matches[0].ref, text: "fixture" });
    const pressed = await ok("browser_press", { tabId, key: "Enter" }, prevent ? "form.enter.submit" : "form.enter.navigate");
    if (prevent) {
      check("Enter observes a prevented form submit", pressed.submissionObserved === true);
      await ok("browser_wait", { tabId, text: "form-submitted", timeout: 5000 });
    } else {
      await ok("browser_wait", { tabId, text: "form-navigation-complete", timeout: 5000 });
      check("Enter detects form submit or navigation", pressed.submissionObserved === true || pressed.navigationObserved === true);
    }
    await close(tabId);
  }

  tabId = await open(`${origin}/simple?padding=${"x".repeat(2400)}`);
  const longUrl = await ok("browser_snapshot", { tabId, maxChars: 2000 }, "long-url.snapshot");
  check("long URL cannot exceed snapshot character budget", [...longUrl.snapshot].length <= 2000, { characters: [...longUrl.snapshot].length });
  await close(tabId);

  tabId = await open(`${origin}/large`);
  await ok("browser_wait", { tabId, text: "viewport-ready", timeout: 5000 });
  const large = await ok("browser_snapshot", { tabId, maxChars: 2000 }, "large.snapshot");
  check("snapshot includes visible target beyond 1000 earlier controls", large.snapshot.includes("Viewport bottom target"), { truncated: large.truncated, includedItems: large.includedItems, totalItems: large.totalItems });
  check("snapshot output stays bounded", [...large.snapshot].length <= 2000);
  target = await find(tabId, "#bottom", "large.find");
  check("locator finds the omitted viewport target", target.matches.length === 1);
  await close(tabId);

  for (const count of [1, 10, 32]) {
    tabId = await open(`${origin}/frames?count=${count}`);
    for (let index = 0; index < repeats; index++) {
      await find(tabId, "#root-target", `frames.${count}.find-root`);
      await ok("browser_snapshot", { tabId, maxChars: 2000 }, `frames.${count}.snapshot`);
      if (count > 1) await find(tabId, "#tail-target", `frames.${count}.find-tail`);
    }
    if (count > 1) {
      target = await find(tabId, "#tail-target");
      const click = await call("browser_click", { tabId, ref: target.matches[0].ref });
      check(`cross-origin frame click works with ${count} frames`, !click.error, { error: click.error });
    }
    const missing = await call("browser_find", { tabId, by: "css", value: "#not-present", limit: 1, timeout: 100 }, `frames.${count}.missing-100ms`);
    check(`missing locator reports an error with ${count} frames`, Boolean(missing.error), { wallMs: missing.sample.wallMs });
    await close(tabId);
  }

  for (let index = 0; index < 3; index++) {
    const token = `${Date.now()}-${index}`;
    tabId = await open(`${origin}/race?token=${token}`);
    const delayed = call("browser_find", { tabId, by: "css", value: "#delayed", limit: 1, timeout: 5000 }, "race.delayed-find");
    await delay(200);
    await find(tabId, "#stable", "race.intervening-find");
    await fetch(`${origin}/signal?token=${token}&set=1`);
    const lateResult = await delayed;
    const click = lateResult.error ? lateResult : await call("browser_click", { tabId, ref: lateResult.result.matches[0].ref }, "race.click-latest-result");
    check(`completed find returns usable ref after intervening find (${index + 1})`, !click.error, { generation: lateResult.result?.generation, error: click.error });
    await close(tabId);
  }
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  for (const tabId of [...openedTabs]) {
    try { await close(tabId); } catch (error) { console.error(`Cleanup failed for owned tab ${tabId}: ${error}`); }
  }
  primary.closeAllConnections();
  child.closeAllConnections();
  await Promise.all([primary, child].map(server => new Promise(resolve => server.close(resolve))));
  const after = await call("browser_tabs", {});
  const originalIds = before.tabs.map(tab => tab.tabId);
  check("pre-existing browser tabs preserved", originalIds.every(id => after.result?.tabs.some(tab => tab.tabId === id)));
  check("owned test tabs closed", openedTabs.size === 0, { remaining: [...openedTabs] });
  const summary = [...new Set(calls.map(sample => sample.label))].filter(label => label.includes(".")).map(label => {
    const samples = calls.filter(sample => sample.label === label);
    const durations = samples.filter(sample => typeof sample.durationMs === "number").map(sample => sample.durationMs);
    return { label, samples: samples.length, errors: samples.filter(sample => sample.error).length, p50Ms: durations.length ? percentile(durations, 0.5) : null, p95Ms: durations.length ? percentile(durations, 0.95) : null, wallP50Ms: percentile(samples.map(sample => sample.wallMs), 0.5) };
  });
  const report = { phase, endpoint: endpoint.href, workspace, date: new Date().toISOString(), repeats, failure, checks, summary, calls };
  const reportPath = resolve(output);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.table(summary);
  console.log(`Report: ${reportPath}`);
  if (failure || checks.some(entry => !entry.passed)) process.exitCode = 1;
}
