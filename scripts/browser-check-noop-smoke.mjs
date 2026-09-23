import http from 'node:http';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const output=arg('output'),workspace=arg('workspace'),binary=arg('binary');
if(!workspace||!binary||!output?.endsWith('.json')||existsSync(output))throw Error('Explicit workspace, binary and fresh output required');
const endpoint='http://127.0.0.1:7332/mcp';
const digest=async()=>createHash('sha256').update(await readFile(binary)).digest('hex');
const binaryHash=await digest(),checks=[],calls=[],owned=new Set();
let sequence=0,session,origin,initialTabs,viewport;
const server=http.createServer((req,res)=>{
  const mode=new URL(req.url,'http://fixture').searchParams.get('mode')||'true';
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
  if(mode==='frame'){res.end('<!doctype html><title>Check frame</title><iframe src="/?mode=true"></iframe>');return;}
  const input=`<input id="target" aria-label="Check target" type="${mode==='radio'||mode==='radio-uncheck'?'radio':mode==='wrong'?'text':'checkbox'}" ${mode==='false'?'':'checked'} ${mode==='disabled'?'disabled':''}>`;
  res.end(`<!doctype html><meta charset="utf-8"><title>Check correctness</title>
  <style>body{margin:20px;font:14px sans-serif}input{width:36px;height:36px;margin:4px}#state{display:block;margin-top:40px}#cover{position:absolute;left:20px;top:20px;width:100px;height:90px;background:gray;z-index:4}${mode==='hidden'?'#target{display:none}':''}${mode==='drift'?'#target{position:absolute;top:2500px}':''}</style>
  ${mode==='shadow'?'<div id="host"></div>':input}${mode==='covered'?'<div id="cover"></div>':''}
  <button id="arm">Arm race</button><output id="state"></output>
  <script>
  const mode=${JSON.stringify(mode)};
  const root=mode==='shadow'?document.querySelector('#host').attachShadow({mode:'open'}):document;
  if(mode==='shadow')root.innerHTML=${JSON.stringify(input)};
  let target=root.querySelector('#target'),clicks=0,inputs=0,changes=0,trusted=true;
  const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'checked');
  function render(){document.querySelector('#state').textContent=JSON.stringify({checked:descriptor.get.call(target),clicks,inputs,changes,trusted,width:innerWidth,height:innerHeight})}
  for(const type of ['click','input','change'])root.addEventListener(type,e=>{if(e.target!==target)return;if(type==='click')clicks++;if(type==='input')inputs++;if(type==='change')changes++;trusted&&=e.isTrusted;render()});
  document.querySelector('#arm').onclick=()=>{
    if(mode==='stale'){target.replaceWith(target.cloneNode(true));target=root.querySelector('#target');}
    if(mode==='drift')addEventListener('scroll',()=>{descriptor.set.call(target,false);render()},{once:true});
    render();
  };
  addEventListener('resize',render);render();
  </script>`);
});
async function rpc(method,params){
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(20000)});
  if(method==='initialize')session=response.headers.get('Mcp-Session-Id');
  const envelope=await response.json();if(!response.ok||envelope.error)throw Error(JSON.stringify(envelope));return envelope.result;
}
async function call(name,args={}){
  const t=performance.now();let result,error;
  try{const e=await rpc('tools/call',{name,arguments:args});const text=e.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(e.isError)error=text;else result=JSON.parse(text);}catch(e){error=String(e);}
  const entry={name,args,wallMs:performance.now()-t,result,error};calls.push(entry);return entry;
}
async function ok(name,args){const r=await call(name,args);if(r.error)throw Error(r.error);return r.result;}
const check=(name,passed,detail)=>{checks.push({name,passed:!!passed,detail});console.log(JSON.stringify(checks.at(-1)));};
const state=async tabId=>JSON.parse((await ok('browser_get_text',{tabId,locator:{by:'css',value:'#state'}})).text);
async function close(tabId){
  if(!owned.has(tabId))throw Error('Unowned tab');
  if(!(await ok('browser_page_info',{tabId})).url.startsWith(origin+'/'))throw Error('Fixture origin changed');
  await ok('browser_close',{tabId,workspace,endSession:true});owned.delete(tabId);
}
async function test(mode){
  let tabId;
  try{
    tabId=(await ok('browser_open',{workspace,url:origin+'/?mode='+mode})).tabId;owned.add(tabId);
    await ok('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:4000});
    let before=await state(tabId);
    if(mode!=='frame'){
      viewport??={width:before.width,height:before.height};
      const deadline=performance.now()+2000;
      while((before.width!==viewport.width||before.height!==viewport.height)&&performance.now()<deadline){await delay(50);before=await state(tabId);}
      if(before.width!==viewport.width||before.height!==viewport.height)throw Error('Viewport changed: '+JSON.stringify({viewport,before}));
    }
    const matches=(await ok('browser_find',{tabId,by:'css',value:'#target',includeHidden:true,limit:1})).matches;
    if(matches.length!==1)throw Error('Fixture target not unique');
    const ref=matches[0].ref;
    if(mode==='stale'||mode==='drift')await ok('browser_click',{tabId,locator:{by:'css',value:'#arm'},reveal:0});
    const requested=mode!=='false'&&mode!=='radio-uncheck';
    const r=await call('browser_check',{tabId,ref,checked:requested,diagnostics:true}),after=await state(tabId);
    const expectedError=['disabled','covered','hidden','wrong','radio-uncheck','stale'].includes(mode);
    if(mode==='drift'){
      const verified=r.result?.changed===false&&r.result?.checked===true&&r.result?.timings?.some(t=>t.phase==='verifyChecked');
      check('asynchronous page-state drift never replays input',after.checked===false&&after.clicks===0&&after.inputs===0&&after.changes===0&&(verified||r.error?.includes('timeout')),{r,after,note:'A successful response verifies the immediate state, not future page changes. Scroll handlers can run after verification; an earlier change may instead produce a verification timeout.'});
    }else if(expectedError){
      const code=mode==='stale'?'stale_ref':mode==='wrong'||mode==='radio-uncheck'?'invalid_request':'timeout';
      check(mode+' rejects without input',r.error?.includes(code)&&after.clicks===0&&after.inputs===0&&after.changes===0,{r,after});
    }else{
      check(mode+' unchanged sends no click or events',!r.error&&r.result.changed===false&&after.checked===requested&&after.clicks===0&&after.inputs===0&&after.changes===0,{r,after});
      check(mode+' still verifies final state',r.result?.timings?.some(t=>t.phase==='verifyChecked')&&!r.result.timings.some(t=>['pointerGuard','mouseDown','frameClick'].includes(t.phase)),r.result?.timings);
      if(mode==='true'||mode==='false'||mode==='frame'){
        const changed=await call('browser_check',{tabId,ref,checked:!requested,diagnostics:true}),final=await state(tabId);
        check(mode+' changed dispatches once and verifies',!changed.error&&changed.result.changed===true&&final.checked===!requested&&final.clicks===1&&final.inputs===1&&final.changes===1&&(mode==='frame'||final.trusted),{changed,final});
      }
    }
    if(before.width!==after.width||before.height!==after.height)throw Error('Viewport changed within action');
  }catch(e){check(mode+' completed',false,String(e));}
  finally{if(tabId)try{await close(tabId);}catch(e){check(mode+' cleanup',false,String(e));}}
}
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-check-noop-smoke',version:'1'}});
  await ok('skills_read',{workspace,name:'anbo'});initialTabs=await ok('browser_tabs');
  for(const mode of ['true','false','radio','shadow','frame','disabled','covered','hidden','wrong','radio-uncheck','stale','drift'])await test(mode);
}catch(e){check('suite completed',false,String(e));}
finally{
  for(const id of [...owned])try{await close(id);}catch(e){check('cleanup',false,String(e));}
  if(initialTabs)try{const after=await ok('browser_tabs');check('original tabs retained',JSON.stringify(initialTabs.tabs.map(t=>t.tabId).sort())===JSON.stringify(after.tabs.map(t=>t.tabId).sort()));}catch(e){check('tabs',false,String(e));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  server.closeAllConnections();await new Promise(r=>server.close(r));
}
check('binary unchanged',await digest()===binaryHash,binaryHash);
await writeFile(output,JSON.stringify({date:new Date().toISOString(),binaryHash,viewport,checks,calls,method:'Native correctness checks. Intentional failures/timeouts are not latency samples. Serial owned fixture tabs; no window resize.'},null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
