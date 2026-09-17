import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const endpoint=new URL(arg('mcp-url')),workspace=arg('workspace'),output=arg('output');
if(!workspace||!output||existsSync(output)||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/mcp')throw Error('Explicit loopback endpoint, workspace and fresh output required');
const checks=[],calls=[],owned=new Set();let sequence=0,session,origin,before;
const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Consolidation fixture</title><button id="target">Target</button><input id="input"><input id="readonly"><select id="select"><option value="a">Alpha</option><option value="b">Beta</option><option value="disabled" disabled>Disabled</option><optgroup disabled><option value="group">Group</option></optgroup></select><select id="revert"><option value="a">Alpha</option><option value="b">Beta</option></select><output id="state"></output><script>
  const data={clicks:0,doubles:0,trusted:true,keys:0,selectEvents:0,revertEvents:0,delayedInputEvents:0,delayedSelectEvents:0};
  const delayedInput=document.createElement('input');delayedInput.id='delayed-input';delayedInput.readOnly=true;document.body.append(delayedInput);
  const delayedSelect=document.createElement('select');delayedSelect.id='delayed-select';delayedSelect.disabled=true;delayedSelect.innerHTML='<option value="a">Alpha</option><option value="b">Beta</option>';document.body.append(delayedSelect);
  for(const [id,enable] of [['enable-input',()=>delayedInput.readOnly=false],['enable-select',()=>delayedSelect.disabled=false]]){const button=document.createElement('button');button.id=id;button.textContent=id;button.onclick=()=>setTimeout(enable,600);document.body.append(button)}
  const race=document.createElement('select');race.id='race';race.innerHTML='<option value="a">Alpha</option><option value="b">Beta</option>';document.body.append(race);race.onfocus=()=>{race.options[1].value='changed';race.options[1].textContent='Changed'};
  const input=document.querySelector('#input'),select=document.querySelector('#select'),revert=document.querySelector('#revert');
  const render=()=>document.querySelector('#state').textContent=JSON.stringify({...data,value:input.value,selected:select.value,reverted:revert.value,readonly:document.querySelector('#readonly').value});
  document.querySelector('#target').onclick=e=>{data.clicks++;data.trusted&&=e.isTrusted;render()};document.querySelector('#target').ondblclick=e=>{data.doubles++;data.trusted&&=e.isTrusted;render()};
  input.onkeydown=()=>{data.keys++;render()};input.oninput=render;document.querySelector('#readonly').onfocus=e=>{e.target.readOnly=true};
  delayedInput.oninput=()=>{data.delayedInputEvents++;render()};delayedSelect.onchange=()=>{data.delayedSelectEvents++;render()};
  select.onchange=()=>{data.selectEvents++;render()};revert.onchange=()=>{data.revertEvents++;revert.value='a';render()};render();</script>`);
});
async function rpc(method,params){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(20000)});if(method==='initialize')session=response.headers.get('Mcp-Session-Id');const data=await response.json();if(!response.ok||data.error)throw Error(JSON.stringify(data.error));return data.result;}
async function call(name,args={}){const started=performance.now();const envelope=await rpc('tools/call',{name,arguments:args});const raw=envelope.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');let result;try{result=JSON.parse(raw);}catch{result={message:raw};}calls.push({name,args,wallMs:performance.now()-started,result,error:!!envelope.isError});if(envelope.isError)throw Error(raw);return result;}
const check=(name,passed,detail)=>{checks.push({name,passed:!!passed,detail});console.log(JSON.stringify(checks.at(-1)));};
async function rejects(name,pattern,fn){try{await fn();check(name,false,'unexpected success');}catch(error){check(name,pattern.test(String(error)),String(error));}}
async function close(tabId){if(!owned.has(tabId))throw Error('Unowned tab');const info=await call('browser_page_info',{tabId});if(!info.url.startsWith(origin+'/'))throw Error('Fixture left origin');await call('browser_close',{workspace,tabId,endSession:true});owned.delete(tabId);}
try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-consolidation-smoke',version:'1'}});await call('skills_read',{workspace,name:'anbo'});before=await call('browser_tabs');
  const tools=(await rpc('tools/list',{})).tools;
  check('33 browser / 49 total tools; redundant names not advertised',tools.length===49&&tools.filter(t=>t.name.startsWith('browser_')).length===33&&['browser_double_click','browser_key','browser_get_url'].every(name=>tools.every(t=>t.name!==name)));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  const {tabId}=await call('browser_open',{workspace,url:origin+'/'});owned.add(tabId);await call('browser_wait',{tabId,condition:'load',loadState:'complete'});
  const find=async value=>(await call('browser_find',{tabId,by:'css',value,limit:1})).matches[0].ref;
  const state=async()=>JSON.parse((await call('browser_get_text',{tabId,ref:await find('#state')})).text);
  const target=await find('#target');await call('browser_click',{tabId,ref:target,clickCount:2});
  let data=await state();check('merged double-click is exactly two trusted clicks and one dblclick',data.clicks===2&&data.doubles===1&&data.trusted,data);
  await call('browser_double_click',{tabId,ref:target});data=await state();check('legacy double-click remains functional',data.clicks===4&&data.doubles===2&&data.trusted,data);
  await rejects('invalid click count never dispatches',/invalid_request/,()=>call('browser_click',{tabId,ref:target,clickCount:3}));
  const input=await find('#input');await call('browser_type',{tabId,ref:input,text:'initial'});
  await call('browser_press',{tabId,ref:input,expectedValue:'initial',key:'a',modifiers:['Control']});
  await call('browser_press',{tabId,ref:input,expectedValue:'initial',key:'z',modifiers:['Shift']});
  data=await state();check('modifiers preserve guarded keyboard input',data.value==='Z',data);
  const keys=data.keys;
  await rejects('expected-value mismatch sends no key',/input_mismatch/,()=>call('browser_press',{tabId,ref:input,expectedValue:'wrong',key:'Enter',observationTimeout:0}));
  await rejects('down cannot silently ignore postconditions',/invalid_request/,()=>call('browser_press',{tabId,key:'Enter',keyAction:'down',waitFor:{text:'impossible'}}));
  await rejects('invalid keyboard action sends nothing',/invalid_request/,()=>call('browser_press',{tabId,key:'a',keyAction:'hold'}));
  data=await state();check('rejected keyboard calls preserve key count',data.keys===keys,data);
  await call('browser_press',{tabId,key:'ArrowLeft',keyAction:'down'});await call('browser_press',{tabId,key:'ArrowLeft',keyAction:'up'});
  await call('browser_key',{tabId,key:'ArrowRight'});data=await state();check('down/up and legacy key each dispatch once',data.keys===keys+2,data);
  await rejects('focus handler cannot make a readonly input writable',/input_not_ready/,async()=>call('browser_type',{tabId,ref:await find('#readonly'),text:'forbidden'}));
  const select=await find('#select');
  for(const value of ['disabled','group'])await rejects('reject disabled option '+value,/input_not_ready/,()=>call('browser_select_option',{tabId,ref:select,value}));
  const selected=await call('browser_select_option',{tabId,ref:select,value:'Beta'});check('selection explicitly verifies retained value',selected.value==='b'&&selected.valueVerified===true,selected);
  const reverting=await find('#revert');await rejects('reverted selection is reported without retry',/input_mismatch/,()=>call('browser_select_option',{tabId,ref:reverting,value:'b'}));
  const race=await find('#race');await rejects('repurposed option during focus cannot be selected',/input_not_ready/,()=>call('browser_select_option',{tabId,ref:race,value:'b'}));
  check('repurposed option keeps the original value',(await call('browser_get_property',{tabId,ref:race,properties:['value']})).values?.value==='a');
  data=await state();check('failed value operations do not write/replay',data.readonly===''&&data.selectEvents===1&&data.revertEvents===1&&data.reverted==='a',data);
  const delayedInput=await find('#delayed-input');
  await call('browser_click',{tabId,ref:await find('#enable-input')});
  const delayedFill=await call('browser_type',{tabId,ref:delayedInput,text:'ready later'});
  data=await state();check('type retries readiness, dispatches once after readonly clears',delayedFill.valueVerified&&data.delayedInputEvents===1&&(await call('browser_get_property',{tabId,ref:delayedInput,properties:['value']})).values.value==='ready later',data);
  const delayedSelect=await find('#delayed-select');
  await call('browser_click',{tabId,ref:await find('#enable-select')});
  const delayedChoice=await call('browser_select_option',{tabId,ref:delayedSelect,value:'b'});
  data=await state();check('select retries readiness, dispatches once after disabled clears',delayedChoice.valueVerified&&delayedChoice.value==='b'&&data.delayedSelectEvents===1,data);
  const info=await call('browser_page_info',{tabId}),legacy=await call('browser_get_url',{tabId});check('page info preserves native URL/loading/pending contract',info.titleSource==='native'&&info.url===legacy.url&&info.loading===false&&info.pendingUrl===null,{info,legacy});
  const old=await find('#input');await call('browser_reload',{tabId});await call('browser_wait',{tabId,condition:'load',loadState:'complete'});
  await rejects('navigation cannot reuse the old context/ref',/stale_ref/,()=>call('browser_type',{tabId,ref:old,text:'forbidden'}));
  const fresh=await find('#input');await call('browser_type',{tabId,ref:fresh,text:'fresh document'});await call('browser_press',{tabId,ref:fresh,expectedValue:'fresh document',key:'ArrowLeft'});
  data=await state();check('helper and focus preparation recover in the new document',data.value==='fresh document'&&data.keys===1,data);
  await close(tabId);
}catch(error){check('suite completed',false,String(error));}
finally{
  for(const tabId of [...owned])try{await close(tabId);}catch(error){check('cleanup',false,String(error));}
  try{const after=await call('browser_tabs');check('original tabs retained',JSON.stringify(before?.tabs.map(t=>t.tabId).sort())===JSON.stringify(after.tabs.map(t=>t.tabId).sort()));}catch(error){check('tab verification',false,String(error));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(output,JSON.stringify({timestamp:new Date().toISOString(),endpoint:String(endpoint),checks,calls},null,2),{flag:'wx'});
}
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));if(checks.some(c=>!c.passed))process.exitCode=1;
