import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output');
if (!workspace || !output || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Pass --mcp-url loopback, --workspace and a fresh --output');
const calls = [], checks = [], owned = new Set(), controls = new Map();
let sequence = 0, session, origin, before, after, benchmark;
async function rpc(method, params) {
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(35000) });
  if (method === 'initialize') session = r.headers.get('Mcp-Session-Id');
  const value = await r.json(); if (!r.ok || value.error) throw Error(JSON.stringify(value.error)); return value.result;
}
async function call(name, args = {}) {
  const start = performance.now(); let result, error;
  try {
    const envelope = await rpc('tools/call', { name, arguments: args });
    const text = envelope.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { result = JSON.parse(text); } catch { result = { message: text }; }
    if (envelope.isError) error = result;
    const tabId = args.tabId ?? result?.tabId;
    if (tabId && result?.controlId) controls.set(tabId, result.controlId);
  } catch (cause) { error = String(cause); }
  const record = { name, args, wallMs: performance.now() - start, result, error }; calls.push(record); return record;
}
async function ok(name, args) { const r = await call(name, args); if (r.error) throw Error(JSON.stringify(r)); return r.result; }
function check(name, passed, detail) { checks.push({ name, passed: !!passed, detail }); console.log(JSON.stringify(checks.at(-1))); }
async function close(tabId) {
  if (controls.has(tabId)) await ok('browser_end_session', { tabId, controlId: controls.get(tabId) });
  await ok('browser_close', { tabId, workspace }); owned.delete(tabId);
}
async function scenario(name, fn) {
  try { await fn(); } catch (cause) { check(name, false, String(cause)); }
  finally { for (const tabId of [...owned]) await close(tabId); }
}
function fixture(mode) {
  if (mode === 'frame') return '<!doctype html><title>Hover frame</title><iframe style="border:0;width:400px;height:280px" src="/inner"></iframe>';
  return `<!doctype html><meta charset="utf-8"><title>Explicit hover fixture</title>
  <style>body{margin:0;font:14px sans-serif}#outside{position:absolute;left:40px;top:5px;height:25px}
  #player{position:absolute;left:40px;top:45px;width:min(500px,calc(100vw - 80px));height:140px;background:#ddd}
  #surface{position:absolute;inset:0}#controls{position:absolute;left:10px;bottom:5px;opacity:0;transition:opacity 80ms;pointer-events:none}
  #controls.revealed{opacity:1}#log{position:absolute;top:200px;left:5px;max-width:95vw;overflow-wrap:anywhere}
  #cover{position:absolute;left:70%;top:0;right:0;bottom:0;background:#aaa;z-index:2}</style>
  <button id="outside">Outside</button><div id="player" aria-label="Fixture player"><div id="surface"></div><div id="controls"><span id="clock">Revealed</span></div></div><output id="log"></output>
  <script>
  const player=document.querySelector('#player'),surface=document.querySelector('#surface'),controls=document.querySelector('#controls');
  const data={moves:0,downs:0,reveals:0,trusted:true,x:null,y:null,width:0,height:0};let previous,timer;
  function render(){document.querySelector('#log').textContent=JSON.stringify(data)}
  surface.addEventListener('mouseover',event=>{previous=[event.pageX,event.pageY]});
  surface.addEventListener('mousemove',event=>{
    data.moves++;data.trusted&&=event.isTrusted;const rect=player.getBoundingClientRect();
    data.x=event.clientX-rect.left;data.y=event.clientY-rect.top;data.width=rect.width;data.height=rect.height;
    if(previous&&(previous[0]!==event.pageX||previous[1]!==event.pageY)){
      data.reveals++;controls.classList.add('revealed');clearTimeout(timer);timer=setTimeout(()=>controls.classList.remove('revealed'),750);
    }
    previous=[event.pageX,event.pageY];render();
  });
  document.addEventListener('mousedown',()=>{data.downs++;render()},true);
  if(${JSON.stringify(mode)}==='cover'){const cover=document.createElement('div');cover.id='cover';player.append(cover)}
  render();
  </script>`;
}
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
  response.end(fixture(request.url.slice(1)));
});
async function openBare(mode) {
  const {tabId} = await ok('browser_open', { workspace, url: origin + '/' + mode }); owned.add(tabId);
  return tabId;
}
async function open(mode) {
  const tabId = await openBare(mode);
  await ok('browser_wait', {tabId,condition:'load',loadState:'complete',timeout:5000});
  const found = await ok('browser_find', {tabId,by:'css',value:'#outside, #surface, #clock, #log',includeHidden:true,limit:4,timeout:2000});
  if(found.matches.length!==4)throw Error(JSON.stringify(found));
  const [outside,surface,clock,log] = found.matches.map(m=>m.ref);
  return {tabId,outside,surface,clock,log};
}
async function read(f) { return JSON.parse((await ok('browser_get_text', {tabId:f.tabId,ref:f.log,maxLength:2000})).text); }
const stats = values => { const sorted=values.toSorted((a,b)=>a-b);return {n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}; };
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
try {
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-hover-regression',version:'1'}});
  await ok('skills_read',{workspace,name:'anbo'});before=await ok('browser_tabs');
  const definitions=await rpc('tools/list',{}), schema=definitions.tools.find(t=>t.name==='browser_hover').inputSchema;
  check('MCP advertises optional fractional hover positions',schema.properties.position?.properties.x.exclusiveMaximum===1&&!schema.required.includes('position'));
  if(process.argv.includes('--first-tab')) {
    await scenario('first browser selection',async()=>{
      const first=await openBare('first');
      const afterFirst=await ok('browser_tabs');
      check('empty active workspace displays its first browser',afterFirst.activeTabId===first&&afterFirst.tabs.find(t=>t.tabId===first)?.active);
      const peer=await openBare('peer');
      const afterPeer=await ok('browser_tabs');
      check('later open preserves the first selected tab',afterPeer.activeTabId===first&&afterPeer.tabs.find(t=>t.tabId===peer)?.active===false);
      await close(peer);
      check('closing background peer preserves the first tab',(await ok('browser_tabs')).activeTabId===first);
    });
    await scenario('concurrent first opens',async()=>{
      const results=await Promise.all([openBare('race-a'),openBare('race-b')]);
      const opens=calls.filter(r=>r.name==='browser_open'&&results.includes(r.result?.tabId));
      const firsts=opens.filter(r=>r.result.placement==='visible-first-tab');
      const afterRace=await ok('browser_tabs');
      check('concurrent opens reserve exactly one first selection',firsts.length===1&&afterRace.activeTabId===firsts[0]?.result.tabId&&opens.filter(r=>r.result.placement==='visible-background-tab').length===1,{opens,afterRace});
    });
  }
  await scenario('entry-coordinate caching',async()=>{
    const f=await open('native'),{tabId}=f;
    await ok('browser_hover',{tabId,ref:f.outside});
    await ok('browser_hover',{tabId,ref:f.surface});
    await ok('browser_hover',{tabId,ref:f.surface});
    const entry=await read(f), hidden=await ok('browser_get_text',{tabId,ref:f.clock});
    check('entry and identical center do not reveal cached-coordinate controls',entry.moves===2&&entry.reveals===0&&!hidden.visible,entry);
    const moved=await ok('browser_hover',{tabId,ref:f.surface,position:{x:.6,y:.5}});
    await ok('browser_wait',{tabId,condition:'ref',ref:f.clock,state:'visible',timeout:1000});
    const shown=await ok('browser_get_text',{tabId,ref:f.clock}),data=await read(f);
    check('explicit interior movement reveals controls through one trusted event',moved.dispatch==='devtools'&&moved.cssHover&&shown.visible&&data.moves===3&&data.reveals===1&&data.trusted&&data.downs===0&&Math.abs(data.x-data.width*.6)<1,data);
    check('temporary Dev diagnostics are absent',!('localDiagnostic'in moved)&&!('point'in moved));
    for(const position of [null,{},[.5,.5],{x:.5},{x:'0.5',y:.5},{x:25,y:.5},{x:0,y:.5},{x:.5,y:1},{x:.5,y:.5,extra:1}]) {
      const rejected=await call('browser_hover',{tabId,ref:f.surface,position});
      check('invalid position rejected '+JSON.stringify(position),/invalid_request/.test(JSON.stringify(rejected.error)),rejected.error);
    }
    check('invalid positions dispatch no mouse input',(await read(f)).moves===3);
    const groups={center:[],position:[]};
    for(const name of Object.keys(groups))for(let i=0;i<24;i++){
      const args={tabId,ref:f.surface,...(name==='position'?{position:{x:i%2?.6:.4,y:.5}}:{})};
      const r=await call('browser_hover',args);if(r.error)throw Error(JSON.stringify(r));if(i>=4)groups[name].push(r);
    }
    benchmark=Object.fromEntries(Object.entries(groups).map(([name,rows])=>[name,{native:stats(rows.map(r=>r.result.durationMs)),wall:stats(rows.map(r=>r.wallMs))}]));
    const total=await read(f);check('one move per successful hover, no mouse down',total.moves===51&&total.downs===0&&total.trusted,{total,benchmark});
    await ok('browser_find',{tabId,by:'css',value:'#surface',limit:1});
    const stale=await call('browser_hover',{tabId,ref:f.surface,position:{x:.6,y:.5}});
    check('positions retain stale-ref rejection',/stale_ref/.test(JSON.stringify(stale.error)),stale.error);
  });
  await scenario('intercepted point',async()=>{
    const f=await open('cover'),{tabId}=f;
    await ok('browser_hover',{tabId,ref:f.surface});const before=await read(f);
    const r=await call('browser_hover',{tabId,ref:f.surface,position:{x:.8,y:.5}}),after=await read(f);
    check('covered requested point is rejected without dispatch',/covered by another element/.test(JSON.stringify(r.error))&&before.moves===after.moves&&after.downs===0,{r,before,after});
  });
  await scenario('child frame',async()=>{
    const f=await open('frame'),{tabId}=f;
    const r=await ok('browser_hover',{tabId,ref:f.surface,position:{x:.6,y:.4}}),data=await read(f);
    check('child-frame fallback reports its dispatch and honors local position',r.dispatch==='dom-frame'&&data.moves===1&&!data.trusted&&data.downs===0&&Math.abs(data.x-data.width*.6)<1&&Math.abs(data.y-data.height*.4)<1,{r,data});
  });
} finally {
  for(const tabId of [...owned])try{await close(tabId)}catch(cause){check('cleanup '+tabId,false,String(cause))}
  try{after=await ok('browser_tabs')}catch{}
  check('original tabs and UI selection retained',before&&after&&before.activeSpaceId===after.activeSpaceId&&before.activeTabId===after.activeTabId&&before.tabs.length===after.tabs.length&&before.tabs.every(t=>after.tabs.some(a=>a.tabId===t.tabId)));
  check('owned tabs closed',owned.size===0);
  if(session){const r=await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)});check('MCP session closed',r.ok)}
  server.closeAllConnections();server.close();
  await writeFile(output,JSON.stringify({endpoint:endpoint.href,workspace,checks,calls,benchmark,before,after},null,2),{flag:'wx'});
  console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
  if(checks.some(c=>!c.passed))process.exitCode=1;
}
