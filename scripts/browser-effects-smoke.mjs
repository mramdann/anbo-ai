import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const candidates = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const browser = candidates.find(existsSync);
if (!browser) throw new Error("Set CHROME_PATH to Chrome/Chromium");
const source = readFileSync("src-tauri/src/modules/browser_automation/activityOverlay.js", "utf8");
const tabCss = readFileSync('src/modules/tabs/WorkspaceDockview.css', 'utf8');
const assets = JSON.parse(readFileSync('src/modules/agents/lib/agentIconAssets.json', 'utf8'));
const iconFor = brand => {
  const asset = brand === 'anbo' ? {light:'/logo.svg'} : assets[brand];
  if (!asset) return undefined;
  const path = asset.dark || asset.light;
  return {source:`data:image/${path.endsWith('.png') ? 'png' : 'svg+xml'};base64,${readFileSync('public' + path).toString('base64')}`,invert:!asset.dark && !!asset.invertOnDark};
};
const output = process.argv.find(arg => arg.startsWith("--screenshot="))?.slice(13);
const reportPath = process.argv.find(arg => arg.startsWith('--report='))?.slice(9);
if (reportPath && existsSync(reportPath)) throw Error('Refusing to overwrite report');
const soakSeconds = Number(process.argv.find(arg => arg.startsWith('--soak-seconds='))?.slice(15) || 0);
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 600) throw Error('Soak must be between 0 and 600 seconds');
if (output && existsSync(output)) throw new Error("Refusing to overwrite screenshot");
const tabOutput = process.argv.find(arg => arg.startsWith('--tab-screenshot='))?.slice(17);
if (tabOutput && existsSync(tabOutput)) throw new Error('Refusing to overwrite tab screenshot');
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.url === '/strict') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; script-src 'none'");
  res.end(`<!doctype html><title>Automation visual fixture</title><style>body{margin:0;background:#181b21;color:#e7ebf3;font:16px system-ui}main{margin:70px auto;width:70%}h1{font-size:36px}input,button{padding:14px;border:1px solid #586274;border-radius:7px;background:#242b36;color:inherit}p{color:#b0bacb}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:40px}.grid div{height:180px;background:linear-gradient(145deg,#293b45,#222534);border-radius:10px;padding:18px}</style><main><p>WORKSPACE / BROWSER</p><h1>Build something remarkable.</h1><p>An isolated page for real pointer and animation checks.</p><input aria-label="Search" placeholder="Search your workspace"><button id="run">Search</button><div class="grid"><div>Design</div><div>Develop</div><div>Explore</div></div><output id="count">0</output></main><script>window.clicks=0;document.querySelector('#run').onclick=()=>{document.querySelector('#count').textContent=++window.clicks};</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), "anbo-effects-smoke-"));
const child = spawn(browser, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--disable-extensions", "--disable-background-networking", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;
const deadline = setTimeout(() => { child.kill(); server.close(); throw new Error("Visual smoke timed out"); }, 120_000 + soakSeconds * 1000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    child.once("error", reject);
    child.stderr.on("data", chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
  });
  const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0, eventSequence = 0;
  const pending = new Map(), errors = [], requests = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let iconBrand;
  const emit = async (phase, point, method = "click", actor = { brand: "claude", label: "Claude" }, requestId = 1, controlId = 1) => {
    const icon = iconBrand !== actor.brand ? iconFor(actor.brand) : undefined;
    iconBrand = actor.brand;
    return evaluate(`new Promise(resolve=>{window.dispatchEvent(new CustomEvent('anbo-automation-visual',{detail:${JSON.stringify({ tabId: 1, requestId, controlId, sequence: ++eventSequence, actor, phase, point, method, icon })}}));requestAnimationFrame(()=>resolve(true));})`);
  };
  const badgeBounds = () => evaluate("(()=>{const el=window.testRoots.at(-1).querySelector('.badge'),r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,placement:el.dataset.placement}})()");
  const hide = () => evaluate("window.dispatchEvent(new CustomEvent('anbo-automation-visual-hide'))");
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
  await send("Performance.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: origin });
  for (let i = 0; i < 100; i++) { if (await evaluate("document.readyState === 'complete' && !!document.querySelector('#run')")) break; await pause(25); }
  const before = await evaluate("({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,text:document.body.innerText,buttons:document.querySelectorAll('button').length})");
  // Retain closed roots in this owned fixture only, so computed styles can be asserted.
  await evaluate("window.testRoots=[];const originalAttach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=originalAttach.call(this,options);window.testRoots.push(root);return root;}");
  await evaluate(source);
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0, "Dormant overlay creates no DOM");
  const point = await evaluate("(()=>{const r=document.querySelector('#run').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()");
  await emit("move", point);
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 1);
  assert.equal(await evaluate(`document.elementFromPoint(${point.x},${point.y}).id`), "run", "Overlay does not intercept hit testing");
  assert.deepEqual(await evaluate("({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,text:document.body.innerText,buttons:document.querySelectorAll('button').length})"), before, "Overlay leaves layout and page text unchanged");
  assert.equal(await evaluate("document.querySelector('[data-anbo-visual]').shadowRoot"), null);
  const initialBadge = await badgeBounds();
  assert.equal(initialBadge.placement, 'pointer');
  assert(initialBadge.x >= point.x + 11 && initialBadge.y >= point.y + 19, 'Identity appears below and right of the agent cursor');
  const cardState = () => evaluate("(()=>{const root=window.testRoots.at(-1),badge=root.querySelector('.badge'),heading=root.querySelector('.heading').getBoundingClientRect(),detail=root.querySelector('.detail').getBoundingClientRect(),cursor=root.querySelector('.cursor').getBoundingClientRect(),logo=root.querySelector('.logo');return{loaded:logo.hasAttribute('data-loaded'),monogram:logo.querySelector('.monogram').textContent,name:root.querySelector('.name').textContent,tool:root.querySelector('.tool').textContent,detail:root.querySelector('.detail').textContent,rows:detail.top>=heading.bottom,cursorWidth:cursor.width,cursorHeight:cursor.height,state:badge.dataset.state,source:logo.querySelector('img')?.getAttribute('src')}})()");
  for(let i=0;i<50 && !(await cardState()).loaded;i++) await pause(20);
  assert.equal((await cardState()).loaded,true,'Canonical CLI logo decodes without a network request');
  assert.equal((await cardState()).tool,'browser_click');
  assert.equal((await cardState()).rows,true,'Identity/tool and action detail occupy two distinct rows');
  assert.equal((await cardState()).cursorWidth,14);
  assert.equal((await cardState()).cursorHeight,18);
  for(const [brand,label] of [...Object.keys(assets).map(brand=>[brand,brand]),['anbo','Anbo']]) {
    await emit('move',point,'hover',{brand,label});
    for(let i=0;i<50 && !(await cardState()).loaded;i++) await pause(20);
    assert.equal((await cardState()).loaded,true,brand+' uses its existing brand asset');
  }
  await emit('move',point,'hover',{brand:'remote',label:'Remote agent'});
  assert.equal((await cardState()).source,undefined,'Generic callers cannot retain another agent logo');
  await emit('move',point,'scroll_to');
  assert.equal((await cardState()).tool,'browser_scroll_to_element','The card names the public MCP tool');
  for(const [internal,external] of [['type_text','type'],['press_key','press'],['upload_files','upload'],['scroll_to_element','scroll_to_element'],['scroll_into_view','scroll_to_element'],['get_page_info','page_info'],['list_tabs','tabs']]) {
    await emit('running',undefined,internal);
    assert.equal((await cardState()).tool,'browser_'+external,'Native method '+internal+' uses the MCP name');
    assert(!(await cardState()).detail.startsWith('Working'),'Native method '+internal+' has an action description');
  }
  await emit('running',undefined,'secret-token-arbitrary-method');
  assert.equal((await cardState()).tool,'browser_action','Unknown methods never echo arbitrary metadata');
  await emit('error',undefined,'type');
  assert.equal((await cardState()).state,'error');
  assert((await cardState()).detail.startsWith('Action stopped'));
  await emit('move',point,'hover',{brand:'remote',label:'Remote agent'});
  await evaluate(`window.dispatchEvent(new CustomEvent('anbo-automation-visual',{detail:${JSON.stringify({sequence:++eventSequence,requestId:100,actor:{brand:'remote',label:'Remote agent'},method:'type_text',phase:'running',icon:{source:'https://example.invalid/secret-image.png'},text:'private-input-must-not-render',params:{password:'private-input-must-not-render'}})}}))`);
  await pause(50);
  assert.equal((await cardState()).source,undefined,'Arbitrary icon URLs are refused');
  assert.equal(await evaluate("window.testRoots.at(-1).textContent.includes('private-input-must-not-render')"),false,'Raw arguments never appear inside the card');
  await emit('move',point,'click',{brand:'codex',label:'Codex'});
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  assert.equal(await evaluate("window.clicks"), 1, "One native click produces one page action");
  await emit("click", point);
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.ring')).display"), "block");
  if (output) { const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(output, Buffer.from(shot.data, "base64")); }
  const cursorState = () => evaluate("(()=>{const el=window.testRoots.at(-1).querySelector('.cursor'),r=el.getBoundingClientRect();return{display:getComputedStyle(el).display,opacity:+getComputedStyle(el).opacity,x:r.x,y:r.y}})()");
  const motionFrames = () => evaluate("new Promise(resolve=>{const start=performance.now(),samples=[];const sample=now=>{const root=window.testRoots.at(-1),el=root.querySelector('.cursor'),r=el.getBoundingClientRect(),b=root.querySelector('.badge').getBoundingClientRect();samples.push({time:now-start,x:r.x,y:r.y,badgeX:b.x,badgeY:b.y,display:getComputedStyle(el).display});if(now-start<500)requestAnimationFrame(sample);else resolve(samples)};requestAnimationFrame(sample)})");
  const from = {x:140,y:160}, to = {x:680,y:330};
  await emit('move', from, 'hover', undefined, 10); await pause(450);
  await emit('done', undefined, 'hover', undefined, 10);
  await emit('running', undefined, 'get_text', undefined, 11);
  assert.equal((await cursorState()).display, 'block', 'Reading between pointer requests preserves the cursor');
  await emit('done', undefined, 'get_text', undefined, 11);
  await emit('move', to, 'hover', undefined, 12);
  const travel = await motionFrames();
  assert(travel.some(sample => sample.display === 'block' && sample.x > from.x+1 && sample.x < to.x-1), 'Separate MCP requests interpolate through intermediate cursor positions: ' + JSON.stringify(travel));
  assert.equal((await cursorState()).x, to.x, 'Pointer reaches the exact verified target');
  assert(travel.some(sample => sample.time > 150 && sample.x < to.x-1), 'Long travel stays visibly smooth beyond the old 140ms jump');
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.badge')).transitionDuration"), await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.cursor')).transitionDuration.split(',')[0]"), 'Badge and cursor use the same travel duration');
  await emit('move', from, 'hover', undefined, 13); await pause(60);
  const interrupted = await cursorState();
  await emit('move', {x:520,y:250}, 'hover', undefined, 14);
  const retargeted = await cursorState();
  assert(Math.abs(interrupted.x-retargeted.x)<120, 'Mid-flight retarget starts from the painted position, not the old destination');
  await pause(450);
  assert.equal((await cursorState()).x,520);
  await emit('done', undefined, 'hover', undefined, 12); await pause(1300);
  assert((await cursorState()).opacity > .99, 'Short idle gaps do not blink the cursor away');
  await emit('move', from, 'hover', undefined, 13);
  assert((await motionFrames()).some(sample => sample.x > from.x+1 && sample.x < to.x-1), 'The next request resumes from the retained position');
  await emit('move', {x:-20,y:100}, 'hover', undefined, 13);
  assert.equal((await cursorState()).display, 'none', 'Invalid viewport coordinates clear the stale pointer immediately');
  await emit('move', point);
  await emit("frame");
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.cursor')).display"), "none", "Frame-local coordinates never masquerade as page coordinates");
  assert.equal((await badgeBounds()).placement, 'docked', 'Frame actions do not reuse a root-page pointer anchor');
  await emit('move', point);
  await emit('running', undefined, 'wait', {brand:'codex',label:'Codex'}, 2);
  assert.equal((await badgeBounds()).placement, 'docked', 'Another caller does not inherit the previous caller cursor');
  assert.equal((await cursorState()).display, 'none', 'Another caller does not inherit a visible pointer');
  await emit('move', point, 'hover', undefined, 30, 30);
  await emit('running', undefined, 'wait', undefined, 31, 31);
  assert.equal((await cursorState()).display, 'none', 'Same-brand connections do not share their pointer');
  await emit("running", undefined, "type");
  await evaluate("document.querySelector('input').focus()");
  await send("Input.insertText", { text: "native input" });
  assert.equal(await evaluate("document.querySelector('input').value"), "native input");
  await emit("running", undefined, "screenshot");
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0, "Screenshots have no overlay");
  await emit('done', point, 'screenshot');
  assert.equal((await cursorState()).display, 'block', 'Screenshot completion restores the verified pointer');
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await emit("running");
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.orb')).animationName"), "none");
  await pause(50);
  assert.equal(await evaluate("window.testRoots.at(-1).getAnimations().length"), 0, "Reduced motion stops Web Animations as well as CSS animation");
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.badge')).transitionDuration"), '0s');
  await emit('move', from, 'hover', undefined, 20);
  await emit('move', to, 'hover', undefined, 21);
  assert.equal((await cursorState()).x, to.x, 'Reduced motion updates the pointer without interpolation');
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.cursor')).transitionDuration"), '0s');
  await hide();
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0, "Hidden panes retain no animation layers");
  await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"no-preference"}]});
  for (const [width, height, dpr] of [[240,360,1],[360,640,1],[1440,900,1.5],[1920,1080,2]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    await emit("running");
    const bounds = await evaluate("(()=>{const r=document.querySelector('[data-anbo-visual]').getBoundingClientRect();return{width:r.width,height:r.height}})()");
    assert.deepEqual(bounds, await evaluate("({width:document.documentElement.clientWidth,height:document.documentElement.clientHeight})"), "Aura follows the content viewport without covering native scrollbars");
    for (const [x,y] of [[0,0],[bounds.width,0],[0,bounds.height],[bounds.width,bounds.height],[bounds.width/2,bounds.height/2]]) {
      await emit('move', {x,y}, 'hover');await pause(450);
      const badge = await badgeBounds();
      assert(badge.x >= 9 && badge.y >= 9 && badge.right <= bounds.width-9 && badge.bottom <= bounds.height-9, 'Cursor badge stays inside every viewport edge and DPI');
      if(x===bounds.width) assert(badge.right<=x-11,'Right-edge badge flips left');
      if(y===bounds.height) assert(badge.bottom<=y-9,'Bottom-edge badge flips above');
    }
    await hide();
  }
  for (let i = 0; i < 50; i++) { await emit("running"); await hide(); }
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0);
  await emit('move', point);
  await emit("done"); await pause(1300);
  assert.equal((await badgeBounds()).placement, 'pointer', 'Completion does not jump the badge to a viewport corner');
  assert((await cursorState()).opacity > .99, 'Completion leaves the cursor readable through short idle gaps');
  await pause(3000);
  assert((await cursorState()).opacity > .99, 'A finished tool retains its pointer beyond the old disposal timeout');
  assert.equal(await evaluate("window.testRoots.at(-1).getAnimations().filter(a=>a.playState==='running').length"), 0, 'Thinking gaps have no running animations');
  await emit('running', undefined, 'get_text', undefined, 80);
  assert.equal((await cursorState()).display, 'block', 'A read resumes the retained cursor after a long gap');
  await emit('ended', undefined, 'get_text', undefined, 80);
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0, "Only session end disposes completed effects");
  await evaluate(`window.dispatchEvent(new CustomEvent('anbo-automation-visual',{detail:{sequence:${eventSequence-1},requestId:80,phase:'done',method:'get_text'}}))`);
  await pause(30);
  assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"), 0, 'A late completion cannot resurrect an ended session');
  const samples = [];
  const soak = [];
  if (soakSeconds) {
    await hide();
    await evaluate('window.testRoots.length=0');
    await send('HeapProfiler.collectGarbage');
    const start = performance.now();
    let cycles = 0;
    const record = async () => {
      await send('HeapProfiler.collectGarbage');
      const metrics = Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name,m.value]));
      const dom = await send('Memory.getDOMCounters');
      const sample = {seconds:(performance.now()-start)/1000,cycles,heapBytes:metrics.JSHeapUsedSize,taskSeconds:metrics.TaskDuration,...dom};
      soak.push(sample); console.log(JSON.stringify({soakProgress:sample}));
    };
    await record();
    while (performance.now()-start < soakSeconds*1000) {
      const request = 10000 + cycles;
      await emit('move',{x:140+(cycles%5)*80,y:160},'hover',undefined,request,request);
      await emit('done',undefined,'hover',undefined,request,request);
      await pause(450);
      await emit('ended',undefined,'hover',undefined,request,request);
      assert.equal(await evaluate("document.querySelectorAll('[data-anbo-visual]').length"),0,'Every soak session ends without retained overlay DOM');
      await evaluate('window.testRoots.length=0');
      cycles++;
      if (cycles%50===0) await record();
    }
    await record();
    assert(soak.at(-1).nodes <= soak[0].nodes + 20,'Repeated sessions do not retain overlay DOM nodes');
    assert(soak.at(-1).jsEventListeners <= soak[0].jsEventListeners + 2,'Repeated sessions do not accumulate event listeners');
  }
  if (process.argv.includes("--measure") || process.argv.includes("--measure-idle")) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false });
    const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
    for (const on of [false,true,false,true,false,true]) {
      if (on) await emit(process.argv.includes("--measure-idle") ? "done" : "running", point); else await hide();
      const a = await metrics();
      const frames = await evaluate("new Promise(resolve=>{let start=performance.now(),previous=start;const times=[];const tick=now=>{times.push(now-previous);previous=now;if(now-start<3000)requestAnimationFrame(tick);else resolve(times)};requestAnimationFrame(tick)})");
      const b = await metrics();
      frames.sort((a,b)=>a-b);
      samples.push({ effects: on, idle:process.argv.includes("--measure-idle"), rendererTaskMs: +(1000*(b.TaskDuration-a.TaskDuration)).toFixed(2), styleMs: +(1000*(b.RecalcStyleDuration-a.RecalcStyleDuration)).toFixed(2), styleCount:b.RecalcStyleCount-a.RecalcStyleCount, layoutMs: +(1000*(b.LayoutDuration-a.LayoutDuration)).toFixed(2), frameP95Ms: +frames[Math.floor(frames.length*.95)].toFixed(2), frames: frames.length });
    }
    await hide();
  }
  await send('Page.navigate', {url:origin + '/strict'});
  for (let i=0;i<100;i++) {if(await evaluate("location.pathname === '/strict' && document.readyState === 'complete'")) break; await pause(25);}
  await evaluate("window.testRoots=[];const originalAttach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=originalAttach.call(this,options);window.testRoots.push(root);return root;}");
  iconBrand=undefined;
  await evaluate(source);await emit('running');await pause(100);
  assert.equal(await evaluate("getComputedStyle(window.testRoots.at(-1).querySelector('.edge')).borderTopWidth"), '2px', 'Static shadow styles work without relaxing page CSP');
  assert.equal((await cardState()).loaded,false,'Strict image CSP is respected');
  assert.equal((await cardState()).monogram,'C','Blocked images retain a readable identity fallback');
  assert.equal((await cardState()).rows,true,'The card remains laid out when page CSP blocks images');
  await hide();
  // Actual shipped tab CSS in this isolated browser, never the user's Dev window.
  await send('Page.navigate', {url:origin + '/tabs'});
  for (let i=0;i<100;i++) {if(await evaluate("location.pathname === '/tabs' && document.readyState === 'complete'")) break; await pause(25);}
  await evaluate(`(()=>{
    const style=document.createElement('style');style.textContent=${JSON.stringify(tabCss)};document.head.append(style);
    document.body.innerHTML='<div class="dockview-theme-anbo-workspace" style="width:360px;margin:24px;font-size:12px"><div class="dv-tab" style="height:29px"><div class="anbo-workspace-dockview-tab"><span class="anbo-workspace-dockview-tab-main"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">Browser / Research workspace</span><span class="anbo-browser-automation-indicator" data-phase="running"><img class="anbo-browser-automation-robot" width="12" height="12"></span></span><span>×</span></div></div></div>';
    document.querySelector('img').src=${JSON.stringify(iconFor('claude').source)};
  })()`);
  const pulseState = () => evaluate(`(()=>{
    const el=document.querySelector('.anbo-browser-automation-indicator'),logo=el.querySelector('img').getBoundingClientRect(),box=el.getBoundingClientRect(),clip=el.parentElement.getBoundingClientRect(),a=getComputedStyle(el,'::before'),b=getComputedStyle(el,'::after');
    return {scale:a.transform==='none'?1:new DOMMatrix(a.transform).a,opacity:+a.opacity,radius:a.borderRadius,first:a.animationName,second:b.animationName,delay:b.animationDelay,logo:{x:logo.x,y:logo.y,width:logo.width,height:logo.height},room:{top:box.top-clip.top,bottom:clip.bottom-box.bottom,left:box.left-clip.left,right:clip.right-box.right},color:a.borderColor,logoAnimation:getComputedStyle(el.querySelector('img')).animationName};
  })()`);
  const pulseColors=[];
  for (const [primary,background] of [['#8b80ff','#181b21'],['#5143bb','#f8fafc']]) {
    await evaluate(`document.documentElement.style.setProperty('--primary','${primary}');document.documentElement.style.setProperty('--background','${background}')`);
    const initial=await pulseState();
    pulseColors.push(initial.color);
    assert.equal(initial.first,'anbo-browser-automation-pulse');assert.equal(initial.second,initial.first);
    assert.equal(initial.radius,'50%');assert.equal(initial.delay,'-0.9s');assert.equal(initial.logoAnimation,'none');
    assert(Object.values(initial.room).every(value=>value>=5.2),'The full expanding circle fits inside the clipped tab content');
    const setPulseTime = time => evaluate(`document.getAnimations().filter(a=>a.animationName==='anbo-browser-automation-pulse').forEach(a=>{a.pause();a.currentTime=${time}})`);
    await setPulseTime(450);const early=await pulseState();
    await setPulseTime(1050);const later=await pulseState();
    assert(later.scale>early.scale && later.scale>1,'Pulse expands beyond the logo in every direction');
    assert(early.opacity>later.opacity && later.opacity>0,'The expanding ring fades out');
    assert.deepEqual(later.logo,initial.logo,'Only the rings move, never the agent logo or tab layout');
  }
  assert.notEqual(pulseColors[0],pulseColors[1],'Pulse color follows the active theme token');
  if (tabOutput) { const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(tabOutput,Buffer.from(shot.data,'base64')); }
  for (const phase of ['done','error']) {
    await evaluate(`document.querySelector('.anbo-browser-automation-indicator').dataset.phase='${phase}'`);
    const state=await pulseState();assert.equal(state.first,'none');assert.equal(state.second,'none');assert.equal(state.opacity,0);
  }
  const tabSamples=[];
  if (process.argv.includes('--measure')) {
    const metrics=async()=>Object.fromEntries((await send('Performance.getMetrics')).metrics.map(metric=>[metric.name,metric.value]));
    for (const on of [false,true,false,true,false,true]) {
      await evaluate(`document.querySelector('.anbo-browser-automation-indicator').dataset.phase='${on?'running':'done'}'`);
      const a=await metrics();
      const frames=await evaluate("new Promise(resolve=>{let start=performance.now(),previous=start;const times=[];const tick=now=>{times.push(now-previous);previous=now;if(now-start<3000)requestAnimationFrame(tick);else resolve(times)};requestAnimationFrame(tick)})");
      const b=await metrics();frames.sort((a,b)=>a-b);
      tabSamples.push({pulse:on,rendererTaskMs:+(1000*(b.TaskDuration-a.TaskDuration)).toFixed(2),layoutMs:+(1000*(b.LayoutDuration-a.LayoutDuration)).toFixed(2),frameP95Ms:+frames[Math.floor(frames.length*.95)].toFixed(2),frames:frames.length});
    }
  }
  await evaluate("document.querySelector('.anbo-browser-automation-indicator').dataset.phase='running'");
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reducedPulse=await pulseState();assert.equal(reducedPulse.first,'none');assert.equal(reducedPulse.second,'none');
  assert.equal(requests.filter(url => !url.startsWith(origin) && !url.startsWith('data:image/')).length, 0, "Effects make no external requests");
  assert.deepEqual(errors, []);
  if (reportPath) writeFileSync(reportPath,JSON.stringify({passed:true,scope:'Shipped visual source in isolated headless Chromium, not the Dev foreground window',soak,samples,tabSamples},null,2),{flag:'wx'});
  console.log(JSON.stringify({ passed: true, checks: ["lazy mount", "click-through", "unchanged geometry/text", "closed shadow", "native click once", "native typing", "click ripple", "cursor-attached identity", "badge edge clamping", "caller anchor isolation", "frame fallback", "clean screenshot", "reduced motion", "hidden cleanup", "DPI/small viewport", "50 lifecycle cycles", "stable completion anchor", "explicit session end", "strict page CSP", "no external requests", "no runtime errors", "cross-request cursor interpolation", "read-tool cursor continuity", "short-idle resume", "invalid coordinate reset", "persistent idle cursor with paused animations", "reduced-motion pointer", "compact two-line card", "14x18 neutral pointer", "seven canonical brand logos", "generic icon fallback", "public tool names", "bounded method labels", "error state", "CSP image fallback", "right and bottom edge flips", "same-brand session reset", "late completion rejection", "screenshot completion restore", "distance-aware travel", "matched cursor/card duration", "mid-flight retarget continuity", "stationary tab logo", "two expanding circular pulses", "unclipped pulse bounds", "pulse theme tokens", "idle and reduced-motion pulse stop"], samples, tabSamples }, null, 2));
} finally {
  clearTimeout(deadline); socket?.close(); child.kill(); server.close();
}
