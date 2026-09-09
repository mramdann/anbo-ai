import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const arg = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? undefined : process.argv[index + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output');
if (!workspace || !output || existsSync(output) || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Pass --mcp-url loopback, --workspace and a fresh --output');
const calls = [], checks = [], owned = new Set(), controls = new Map(), commands = new Map();
let sequence = 0, session, origin, frameOrigin, before;
async function rpc(method, params) {
  const response = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json', ...(session ? {'Mcp-Session-Id':session} : {})}, body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}), signal:AbortSignal.timeout(20000) });
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const envelope = await response.json();
  if (!response.ok || envelope.error) throw Error(JSON.stringify(envelope.error ?? {status:response.status}));
  return envelope.result;
}
async function call(name, args = {}) {
  const start = performance.now(); let result, error;
  try {
    const envelope = await rpc('tools/call',{name,arguments:args});
    const raw = envelope.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { result = JSON.parse(raw); } catch { result = {message:raw}; }
    if (envelope.isError) error = result;
    if (result.controlId && args.tabId) controls.set(args.tabId, result.controlId);
  } catch (cause) { error = String(cause); }
  const sample = {name,args,wallMs:Math.round(performance.now()-start),result,error}; calls.push(sample); return sample;
}
async function ok(name,args) { const sample = await call(name,args); if(sample.error) throw Error(JSON.stringify(sample.error)); return sample.result; }
function check(name,passed,detail) { const item={name,passed:!!passed,detail}; checks.push(item); console.log(JSON.stringify(item)); }
async function scenario(name,fn) {
  try { await fn(); } catch(cause) {
    const observations=[];
    for(const tabId of owned) observations.push({tabId,info:await call('browser_page_info',{tabId}),text:await call('browser_get_text',{tabId,maxLength:1000})});
    check(name,false,{error:String(cause),observations});
  }
}
const html = (title,body,script='') => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:16px}button,input{padding:10px;margin:4px}output{display:block}iframe{width:650px;height:350px}</style>${body}<script>${script}</script>`;
function serve(req,res) {
  const url=new URL(req.url,'http://fixture');res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/command') { const id=url.searchParams.get('id');commands.set(id,res);res.on('close',()=>commands.delete(id));return; }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(url.pathname==='/shadow') return res.end(html('Composed text','<div id="host"><span slot="message">ASSIGNED</span><span>UNASSIGNED</span></div>', `document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<p>BEFORE</p><slot name="message">FALLBACK</slot><p>AFTER</p><button id="shadow-button">Shadow button</button>';`));
  if(url.pathname==='/titles') return res.end(html('Initial title','<button id="push">Push history</button><p>Ready fixture</p>', `document.getElementById('push').onclick=()=>{history.pushState({},'', '?detail=1');document.title='Detail title';};`));
  if(url.pathname==='/links') return res.end(html('Popup fixture','<a id="popup" href="/owned-popup" target="_blank">Open owned popup</a>'));
  if(url.pathname==='/parent') return res.end(html('Frame parent',`<iframe src="${url.searchParams.get('cross')==='true'?frameOrigin:origin}/identity?id=${url.searchParams.get('id')}"></iframe>`));
  if(url.pathname==='/identity') {
    const id=url.searchParams.get('id'), shadow=url.searchParams.get('shadow')==='true';
    return res.end(html('Identity fixture','<div id="host"></div>', `const root=${shadow?"document.getElementById('host').attachShadow({mode:'open'})":"document.getElementById('host')"};root.innerHTML='<button id="target">Original</button><input id="input" value="unchanged"><output id="state">INITIAL</output><output id="count">clicks:0</output>';let clicks=0;const record=()=>root.querySelector('#count').textContent='clicks:'+ ++clicks;root.querySelector('#target').onclick=record;fetch('/command?id=${id}').then(r=>r.json()).then(({clean,type})=>{const original=root.querySelector(type?'#input':'#target');const clone=original.cloneNode(true);if(clean){clone.removeAttribute('data-anbo-ref');clone.removeAttribute('data-anbo-gen');}if(!type){clone.textContent='Replacement';clone.onclick=record;}original.replaceWith(clone);root.querySelector('#state').textContent='REPLACED';});`));
  }
  res.end(html('Owned regression','Fixture ready'));
}
const server=http.createServer(serve),frameServer=http.createServer(serve);
async function open(path) {const result=await ok('browser_open',{workspace,url:origin+path});owned.add(result.tabId);if(result.controlId)controls.set(result.tabId,result.controlId);await ok('browser_wait',{tabId:result.tabId,condition:'load',loadState:'complete',timeout:6000});return result.tabId;}
async function find(tabId,selector) {return (await ok('browser_find',{tabId,by:'css',value:selector,limit:1,timeout:3000})).matches[0];}
async function close(tabId) {
  const current=await ok('browser_get_url',{tabId});if(!current.url.startsWith(origin+'/'))throw Error('Owned tab changed origin; refusing cleanup');
  if(controls.has(tabId))await ok('browser_end_session',{tabId,controlId:controls.get(tabId)});
  await ok('browser_close',{tabId,workspace});owned.delete(tabId);
}
try {
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-correctness-smoke',version:'1'}});
  await ok('skills_list',{workspace});await ok('skills_read',{workspace,name:'anbo'});
  before=await ok('browser_tabs',{});
  await Promise.all([new Promise(r=>server.listen(0,'127.0.0.1',r)),new Promise(r=>frameServer.listen(0,'127.0.0.1',r))]);
  origin='http://127.0.0.1:'+server.address().port;frameOrigin='http://127.0.0.1:'+frameServer.address().port;
  await scenario('composed text',async()=>{
    const tabId=await open('/shadow');
    const body=await ok('browser_get_text',{tabId,maxLength:1000});
    check('composed text excludes fallback and unslotted nodes',body.text==='BEFORE\nASSIGNED\nAFTER\nShadow button',body);
    const wait=await call('browser_wait',{tabId,waitFor:{text:'FALLBACK',timeout:500}});
    check('hidden slot text never satisfies readiness',!!wait.error,wait);
    check('shadow locator still resolves',(await find(tabId,'#shadow-button')).name==='Shadow button');
    const legacy=await call('browser_wait',{tabId,condition:'text',text:'Shadow button',timeout:500});
    check('legacy text wait also reads open Shadow DOM',!legacy.error,legacy);
    const compound=await call('browser_wait',{tabId,waitFor:{text:'Shadow button',timeout:800}});
    check('compound text wait reads the same visible shadow text',!compound.error,compound);
    const hiddenLegacy=await call('browser_wait',{tabId,condition:'text',text:'FALLBACK',timeout:500});
    check('legacy wait also rejects inactive slot fallback',/timeout/.test(JSON.stringify(hiddenLegacy.error)),hiddenLegacy);
    await close(tabId);
  });
  for(const scope of ['main','shadow','same-frame','cross-frame'])for(const type of [false,true])await scenario('identity '+scope+' '+type,async()=>{
    const token=scope+'-'+type;
    const tabId=await open(scope.endsWith('frame')?`/parent?id=${token}&cross=${scope==='cross-frame'}`:`/identity?id=${token}&shadow=${scope==='shadow'}`);
    const target=await find(tabId,type?'#input':'#target');
    const deadline=Date.now()+3000;while(!commands.has(token)&&Date.now()<deadline)await delay(50);
    if(!commands.has(token))throw Error('Fixture command not connected');
    commands.get(token).end(JSON.stringify({clean:false,type}));
    // Legacy text wait covers child frames without replacing the refs under test.
    await ok('browser_wait',scope==='shadow'?{tabId,waitFor:{text:'REPLACED',timeout:3000}}:{tabId,condition:'text',text:'REPLACED',timeout:3000});
    const action=await call(type?'browser_type':'browser_click',{tabId,ref:target.ref,...(type?{text:'must not arrive'}:{})});
    check(`${scope} cloned ${type?'input':'button'} rejects old ref`,/stale_ref/.test(JSON.stringify(action.error)),action);
    const current=await find(tabId,type?'#input':'#count');
    const state=type?current.value:(await ok('browser_get_text',{tabId,ref:current.ref,maxLength:100})).text;
    check(`${scope} cloned ${type?'input':'button'} has no side effect`,state===(type?'unchanged':'clicks:0'),state);
    const fresh=await find(tabId,type?'#input':'#target');
    await ok(type?'browser_type':'browser_click',{tabId,ref:fresh.ref,...(type?{text:'verified input'}:{})});
    const updated=await find(tabId,type?'#input':'#count');
    const actual=type?updated.value:(await ok('browser_get_text',{tabId,ref:updated.ref,maxLength:100})).text;
    const expected=type?'verified input':'clicks:'+(Number(state.split(':')[1])+1);
    check(`${scope} fresh ${type?'input':'button'} works once`,actual===expected,actual);
    await close(tabId);
  });
  await scenario('popup identity and routing',async()=>{
    const tabId=await open('/links');
    const result=await ok('browser_click',{tabId,ref:(await find(tabId,'#popup')).ref});
    let popups=[];
    const deadline=Date.now()+3000;
    while(!popups.length&&Date.now()<deadline){
      const tabs=await ok('browser_tabs',{});
      popups=tabs.tabs.filter(t=>[t.url,t.pendingUrl].includes(origin+'/owned-popup'));
      if(!popups.length)await delay(100);
    }
    for(const popup of popups)owned.add(popup.tabId);
    check('popup creates exactly one owned tab',popups.length===1,{result,popups});
    const source=(await ok('browser_tabs',{})).tabs.find(t=>t.tabId===tabId);
    check('popup keeps originating workspace',popups.length===1&&popups[0].spaceId===source?.spaceId);
    for(const popup of popups){await ok('browser_wait',{tabId:popup.tabId,condition:'load',loadState:'complete',timeout:3000});await close(popup.tabId);}
    await close(tabId);
  });
  await scenario('title sources',async()=>{
    const tabId=await open('/titles');
    await ok('browser_click',{tabId,ref:(await find(tabId,'#push')).ref,diagnostics:true,waitFor:{title:'Detail title',timeout:3000}});
    await ok('browser_back',{tabId});await delay(250);
    const native=await ok('browser_page_info',{tabId});
    const document=await ok('browser_page_info',{tabId,titleSource:'document'});
    const snapshot=await ok('browser_snapshot',{tabId,maxChars:2000});
    check('native page info explicitly identifies its source',native.titleSource==='native',native);
    check('document title agrees with snapshot',document.titleSource==='document'&&snapshot.titleSource==='document'&&document.title===snapshot.title, {document,snapshot});
    for(const info of [native,document]){
      const source=info===native?'native':'document';
      const wait=await call('browser_wait',{tabId,waitFor:{title:info.title,titleSource:source,timeout:800}});
      check('title round trip '+source,!wait.error,wait);
    }
    const defaultWait=await call('browser_wait',{tabId,waitFor:{title:snapshot.title,timeout:800}});
    check('existing document-title default stays compatible',!defaultWait.error,defaultWait);
    const combined=await call('browser_wait',{tabId,waitFor:{title:native.title,titleSource:'native',url:origin+'/titles',text:'Ready fixture',timeout:1000}});
    check('native title combines with document URL and text',!combined.error,combined);
    check('history fixture actually exposes different title sources',native.title!==document.title,{native,document});
    if(native.title!==document.title) for(const [title,titleSource] of [[native.title,'document'],[document.title,'native']]) {
      const crossed=await call('browser_wait',{tabId,waitFor:{title,titleSource,timeout:500}});
      check('crossed title rejected for '+titleSource,/timeout/.test(JSON.stringify(crossed.error)),crossed);
    }
    await close(tabId);
  });
}catch(cause){check('suite completed',false,{error:String(cause)});}
finally {
  for(const tabId of [...owned])try{await close(tabId);}catch(cause){check('cleanup',false,{tabId,error:String(cause)});}
  const after=await call('browser_tabs',{});check('original tabs retained',!after.error&&before?.tabs.every(t=>after.result.tabs.some(a=>a.tabId===t.tabId)));
  check('owned tabs closed',owned.size===0);
  if(session){try{const r=await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)});check('session closed',r.ok);}catch(cause){check('session closed',false,String(cause));}}
  server.closeAllConnections();frameServer.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>frameServer.close(r))]);
  await writeFile(output,JSON.stringify({timestamp:new Date().toISOString(),endpoint:String(endpoint),workspace,checks,calls,unclosedTabs:[...owned]},null,2),{flag:'wx'});
  console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
  if(checks.some(c=>!c.passed))process.exitCode=1;
}
