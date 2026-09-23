import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output');
const binary = arg('binary'), pwModule = arg('playwright'), beforePath = arg('before');
const mode = arg('tools') ?? 'both';
const transport = arg('transport') ?? 'fetch';
const measuredSamples = Number(arg('samples') ?? 30), iterations = measuredSamples + 5;
if (!Number.isInteger(measuredSamples) || measuredSamples < 10 || measuredSamples > 1000) throw Error('--samples must be 10..1000');
if (!['fetch', 'node-http'].includes(transport)) throw Error('--transport must be fetch or node-http');
const before = beforePath ? JSON.parse(await readFile(beforePath, 'utf8')) : null;
if (before && (before.transport ?? 'fetch') !== transport) throw Error('Before/after transport differs; do not attribute client changes to Anbo');
const mcpAgent = transport === 'node-http' ? new http.Agent({keepAlive:true,maxSockets:1}) : null;
if (!['anbo', 'playwright', 'both'].includes(mode)) throw Error('--tools must be anbo, playwright or both');
const useAnbo = mode !== 'playwright', usePw = mode !== 'anbo';
const reference = arg('anbo-reference') ? JSON.parse(await readFile(arg('anbo-reference'), 'utf8')) : null;
if (!useAnbo && !reference?.environment?.anbo) throw Error('Playwright-only mode requires --anbo-reference for the measured viewport');
if (!workspace || !output || !binary || !pwModule || existsSync(output) || existsSync(output.replace(/\.json$/, '.html')) || !output.endsWith('.json') || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Explicit loopback --mcp-url, --workspace, --binary, --playwright module and fresh .json --output required');
const samples = [], checks = [], owned = new Set();
let sequence = 0, session, origin, browser, initialTabs, finalTabs, catalog, environment;
const fixture = `<!doctype html><meta charset="utf-8"><title>Latency benchmark fixture</title>
<style>body{margin:12px;font:14px sans-serif}button,input,select{height:32px;margin:4px}#content{display:grid;grid-template-columns:repeat(12,1fr)}.cell{padding:2px}#state{white-space:pre;display:block}</style>
<button id="target">Benchmark target</button><input id="input" aria-label="Benchmark input"><input id="check" type="checkbox" aria-label="Benchmark check"><select id="select" aria-label="Benchmark select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<div id="text">Measured text <span aria-hidden="true">hidden decoy</span><span>is accurate</span></div><output id="state"></output><div id="content"></div>
<script>
const data={clicks:0,trusted:true,keys:0,inputEvents:0,changes:0};
const input=document.querySelector('#input'), check=document.querySelector('#check'), select=document.querySelector('#select');
function render(){document.querySelector('#state').textContent=JSON.stringify({...data,value:input.value,checked:check.checked,selected:select.value,width:innerWidth,height:innerHeight,userAgent:navigator.userAgent,nodes:document.querySelectorAll('*').length})}
document.querySelector('#target').onclick=e=>{data.clicks++;data.trusted&&=e.isTrusted;render()};
input.oninput=()=>{data.inputEvents++;render()};input.onchange=()=>{data.changes++;render()};input.onkeydown=()=>{data.keys++;render()};check.onchange=select.onchange=render;
const fragment=document.createDocumentFragment();for(let i=0;i<17000;i++){const node=document.createElement('span');node.className='cell';node.textContent='Row '+i;fragment.append(node)}document.querySelector('#content').append(fragment);render();
</script>`;
const server = http.createServer((req,res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.end(fixture); });
async function rpc(method, params) {
  const body = JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params});
  const headers = {'Content-Type':'application/json', ...(session ? {'Mcp-Session-Id':session} : {})};
  let status, envelope, sessionId;
  if (mcpAgent) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(endpoint, {method:'POST',agent:mcpAgent,headers:{...headers,'Content-Length':Buffer.byteLength(body)},signal:AbortSignal.timeout(30000)}, response => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('error', reject);
        response.on('end', () => { try { resolve({status:response.statusCode,envelope:JSON.parse(data),sessionId:response.headers['mcp-session-id']}); } catch(error) { reject(error); } });
      });
      request.on('error', reject);request.end(body);
    });
    ({status,envelope,sessionId} = response);
  } else {
    const response = await fetch(endpoint, {method:'POST',headers,body,signal:AbortSignal.timeout(30000)});
    status=response.status;sessionId=response.headers.get('Mcp-Session-Id');envelope=await response.json();
  }
  if (method === 'initialize') session = sessionId;
  if (status < 200 || status >= 300 || envelope.error) throw Error(JSON.stringify(envelope.error ?? status));return envelope.result;
}
async function call(name, args = {}) {
  const envelope = await rpc('tools/call', {name,arguments:args});
  const raw = envelope.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  if (envelope.isError) throw Error(raw); return JSON.parse(raw);
}
function check(name, passed, detail) { checks.push({name,passed:!!passed,detail}); console.log(JSON.stringify(checks.at(-1))); }
function stats(values) { const s=[...values].sort((a,b)=>a-b); return {n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1]}; }
async function measure(tool, scenario, iteration, fn) {
  const start=performance.now(); let result,error;
  try { result=await fn(); } catch(cause) { error=String(cause); }
  const sample={tool,scenario,iteration,warmup:iteration<5,wallMs:performance.now()-start,nativeMs:result?.durationMs,error}; samples.push(sample);
  if(error) throw Error(JSON.stringify(sample)); return result;
}
async function close(tabId) {
  if (!owned.has(tabId)) throw Error('Unowned tab');
  const page=await call('browser_get_url',{tabId}); if(!page.url.startsWith(origin+'/')) throw Error('Fixture tab changed origin; not closing it');
  await call('browser_close',{tabId,workspace,endSession:true}); owned.delete(tabId);
}
const binaryHash=createHash('sha256').update(await readFile(binary)).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin='http://127.0.0.1:'+server.address().port;
  let tabId;
  if (useAnbo) {
    await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-latency-benchmark',version:'1'}});
    await call('skills_read',{workspace,name:'anbo'});
    catalog=(await rpc('tools/list',{})).tools;
    initialTabs=await call('browser_tabs');
    tabId=(await call('browser_open',{workspace,url:origin+'/benchmark'})).tabId;owned.add(tabId);
    await call('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:8000});
  }
  const find = async selector => (await call('browser_find',{tabId,by:'css',value:selector,limit:1})).matches[0].ref;
  const state = async () => JSON.parse((await call('browser_get_text',{tabId,ref:await find('#state')})).text);
  const anboState=useAnbo ? await state() : reference.environment.anbo;
  let page;
  if (usePw) {
    const {chromium}=await import(pathToFileURL(pwModule).href);
    browser=await chromium.launch({headless:true,...(arg('chrome')?{executablePath:arg('chrome')}:{})});
    page=await browser.newPage({viewport:{width:anboState.width,height:anboState.height}});
    await page.goto(origin+'/benchmark');
  }
  environment={anbo:anboState,anboMeasured:useAnbo,playwright:usePw?{version:browser.version(),headless:true,viewport:page.viewportSize()}:null,node:process.version};
  if (useAnbo && reference) {
    const expected = reference.environment?.anbo;
    const comparable = expected && ['width', 'height', 'userAgent', 'nodes'].every(key => anboState[key] === expected[key]);
    check('reference viewport, engine and fixture match before measurement', comparable, { expected, actual: anboState });
    if (!comparable) throw Error('Reference environment differs; no timed actions dispatched');
  }
  const scenarios = [
    {name:'find CSS (17k nodes)', prepare:async()=>{}, anbo:()=>call('browser_find',{tabId,by:'css',value:'#target',limit:1}), pw:()=>page.locator('#target').count()},
    {name:'find role/name (17k nodes)', prepare:async()=>{}, anbo:()=>call('browser_find',{tabId,by:'role',value:'button',name:'Benchmark target',exact:true,limit:1}), pw:()=>page.getByRole('button',{name:'Benchmark target',exact:true}).count()},
    ...['click','check','type','select','press','hover','text','property'].map(name=>{
      let ref;const selector={click:'#target',check:'#check',type:'#input',select:'#select',press:'#input',hover:'#target',text:'#text',property:'#input'}[name];
      return {name,prepare:async()=>{if(useAnbo)ref=await find(selector);if(name==='press'){if(useAnbo)await call('browser_focus',{tabId,ref});if(usePw)await page.locator(selector).focus();}},
        anbo:i=>call({click:'browser_click',check:'browser_check',type:'browser_type',select:'browser_select_option',press:'browser_press',hover:'browser_hover',text:'browser_get_text',property:'browser_get_property'}[name],{tabId,ref,...({check:{checked:i%2===0},type:{text:'value-'+i},select:{value:i%2===0?'b':'a'},press:{key:'ArrowLeft',observationTimeout:0},property:{properties:['value']}}[name]??{})}),
        pw:i=>({click:()=>page.locator(selector).click(),check:()=>page.locator(selector).setChecked(i%2===0),type:()=>page.locator(selector).fill('value-'+i),select:()=>page.locator(selector).selectOption(i%2===0?'b':'a'),press:()=>page.keyboard.press('ArrowLeft'),hover:()=>page.locator(selector).hover(),text:()=>page.locator(selector).innerText(),property:()=>page.locator(selector).inputValue()}[name])()};
    }),
    {name:'page info (native)',prepare:async()=>{},anbo:()=>call('browser_page_info',{tabId}),pw:async()=>({url:page.url(),title:await page.title()})},
  ];
  if (arg('check-noop') === 'true') {
    let ref;
    scenarios.splice(4, 0, {
      name: 'check (already set)',
      prepare: async () => {
        if (useAnbo) { ref = await find('#check'); await call('browser_check', { tabId, ref, checked: true }); }
        if (usePw) await page.locator('#check').setChecked(true);
      },
      anbo: () => call('browser_check', { tabId, ref, checked: true }),
      pw: () => page.locator('#check').setChecked(true),
    });
  }
  if (arg('full-scan') === 'true') scenarios.splice(2,0,
    {name:'find CSS full scan (17k nodes)',prepare:async()=>{},anbo:()=>call('browser_find',{tabId,by:'css',value:'#target',limit:20}),pw:()=>page.locator('#target').count()},
    {name:'find role/name full scan (17k nodes)',prepare:async()=>{},anbo:()=>call('browser_find',{tabId,by:'role',value:'button',name:'Benchmark target',exact:true,limit:20}),pw:()=>page.getByRole('button',{name:'Benchmark target',exact:true}).count()});
  for(const scenario of scenarios) {
    await scenario.prepare();
    for(let i=0;i<iterations;i++) for(const tool of (mode==='both' ? (i%2 ? ['playwright','anbo'] : ['anbo','playwright']) : [mode])) {
      const value=await measure(tool,scenario.name,i,()=>tool==='anbo'?scenario.anbo(i):scenario.pw(i));
      if(tool==='anbo' && scenario.name.startsWith('find')) {if(value.matches?.length!==1 || value.nodeLimitReached || value.matches[0].name!=='Benchmark target') throw Error('Locator result mismatch');}
      if(tool==='playwright' && scenario.name.startsWith('find') && value!==1)throw Error('Playwright locator count mismatch');
      if(tool==='anbo' && scenario.name==='text' && value.text!=='Measured text is accurate')throw Error('Composed text mismatch: '+value.text);
      if(tool==='anbo' && scenario.name==='check (already set)' && (value.changed !== false || value.checked !== true))throw Error('Idempotent check changed state');
    }
    console.log(JSON.stringify({scenario:scenario.name,completed:true}));
  }
  const finalAnbo=useAnbo?await state():null,finalPw=usePw?await page.locator('#state').textContent().then(JSON.parse):null;
  if(useAnbo)check('fixture viewport remained comparable',finalAnbo.width===anboState.width&&finalAnbo.height===anboState.height,{initial:{width:anboState.width,height:anboState.height},final:{width:finalAnbo.width,height:finalAnbo.height}});
  for(const [label,value] of [['anbo',finalAnbo],['playwright',finalPw]]) {
    if(!value)continue;
    check(label+' trusted clicks/keys and exact values',value.clicks===iterations&&value.trusted&&value.keys===iterations&&value.value==='value-'+(iterations-1)&&value.checked===(arg('check-noop')==='true'||(iterations-1)%2===0)&&value.selected===((iterations-1)%2===0?'b':'a'),value);
  }
  if(useAnbo){check('Anbo fill emits input/change exactly once',finalAnbo.inputEvents===iterations&&finalAnbo.changes===iterations,finalAnbo);await close(tabId);}
} catch(cause) { check('suite completed',false,String(cause)); }
finally {
  await browser?.close();
  for(const tabId of [...owned])try{await close(tabId);}catch(cause){check('cleanup',false,String(cause));}
  if(useAnbo)try{finalTabs=await call('browser_tabs');check('original tabs retained',JSON.stringify(initialTabs?.tabs?.map(t=>t.tabId).sort())===JSON.stringify(finalTabs.tabs.map(t=>t.tabId).sort()),{initial:initialTabs?.tabs?.map(t=>t.tabId),final:finalTabs.tabs.map(t=>t.tabId)});}catch(cause){check('tab verification',false,String(cause));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  mcpAgent?.destroy();
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}
const summaries=[];
for(const scenario of new Set(samples.map(s=>s.scenario)))for(const tool of (mode==='both'?['anbo','playwright']:[mode])) {
  const rows=samples.filter(s=>s.scenario===scenario&&s.tool===tool&&!s.warmup&&!s.error);
  summaries.push({scenario,tool,wall:stats(rows.map(r=>r.wallMs)),...(tool==='anbo'?{native:stats(rows.map(r=>r.nativeMs))}:{})});
}
const finalBinaryHash=createHash('sha256').update(await readFile(binary)).digest('hex');
check('binary unchanged during measurement',binaryHash===finalBinaryHash,{before:binaryHash,after:finalBinaryHash});
const report={createdAt:new Date().toISOString(),mode,transport,measuredSamples,warmups:5,undici:process.versions.undici,order:mode==='both'?'alternating':'single-tool',head,binary,binaryHash,finalBinaryHash,endpoint:String(endpoint),workspace,environment,catalog:{hash:createHash('sha256').update(JSON.stringify(catalog??[])).digest('hex'),total:catalog?.length,browser:catalog?.filter(t=>t.name.startsWith('browser_')).length,characters:JSON.stringify(catalog??[]).length,names:catalog?.map(t=>t.name)},checks,summaries,samples};
await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=value=>value==null?'n/a':value.toFixed(1);
const rows=summaries.filter(s=>s.tool===(mode==='playwright'?'playwright':'anbo')).map(s=>{const native=s.tool==='anbo'?s:null,pw=s.tool==='playwright'?s:summaries.find(p=>p.scenario===s.scenario&&p.tool==='playwright'),old=before?.summaries.find(p=>p.scenario===s.scenario&&p.tool==='anbo');return `<tr><td>${escape(s.scenario)}</td><td>${fmt(old?.wall.p50)} / ${fmt(old?.wall.p95)}</td><td>${fmt(native?.wall.p50)} / ${fmt(native?.wall.p95)}</td><td>${fmt(native?.native.p50)} / ${fmt(native?.native.p95)}</td><td>${fmt(pw?.wall.p50)} / ${fmt(pw?.wall.p95)}</td><td>${old&&native?fmt((native.wall.p50/old.wall.p50-1)*100)+'%':'n/a'}</td></tr>`;}).join('');
await writeFile(output.replace(/\.json$/,'.html'),`<!doctype html><meta charset="utf-8"><title>Codex browser latency benchmark</title><style>body{font:15px system-ui;background:#101820;color:#e5edf5;max-width:1200px;margin:40px auto;padding:24px}h1{font-size:30px}table{border-collapse:collapse;width:100%}th,td{padding:12px;border-bottom:1px solid #334452;text-align:left}th{color:#85d5c8}p{line-height:1.6;color:#b6c7d5}code{overflow-wrap:anywhere}li{margin:8px 0}</style><h1>Codex: Anbo browser latency</h1><p>${escape(report.createdAt)} | 17,000 content nodes | 5 warmups + ${measuredSamples} measured samples per tool | ${mode === 'both' ? 'alternating tools' : mode + ' only; no second browser launched'} | transport: ${escape(transport)} | milliseconds p50 / p95</p><table><thead><tr><th>Action</th><th>Before MCP</th><th>After MCP</th><th>After backend</th><th>Playwright engine</th><th>MCP p50 change</th></tr></thead><tbody>${rows}</tbody></table><p>Playwright uses headless Chromium and direct library calls, not its MCP wrapper. Anbo uses the unchanged native Dev window, background WebView2, ownership/ref/actionability guards and visual effects. Engine versions and viewport are recorded in JSON. Find returns full bounded metadata in Anbo versus a locator count in Playwright. Text preserves aria-hidden and composed-tree semantics in Anbo versus innerText in Playwright. Fill uses one input/change pair in Anbo; Playwright fill has different event timing. These are diagnostic comparisons, not identical contracts or an LLM end-to-end benchmark. Website navigation/network time is excluded. Before/after builds are sequential and subject to machine load.</p><h2>Verification</h2><ul>${checks.map(c=>`<li>${c.passed?'PASS':'FAIL'}: ${escape(c.name)}${c.passed?'':': '+escape(JSON.stringify(c.detail))}</li>`).join('')}</ul><h2>Provenance</h2><p>HEAD <code>${escape(head)}</code><br>Binary SHA-256 <code>${escape(binaryHash)}</code><br>Tools: ${report.catalog.browser} browser, ${report.catalog.total} total, ${report.catalog.characters} catalog characters.<br>Before: ${escape(beforePath??'not supplied')}<br>Raw data: ${escape(output)}</p>`,{flag:'wx'});
console.log(JSON.stringify({output,summaries,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed)||samples.some(s=>s.error))process.exitCode=1;
