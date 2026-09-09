import http from 'node:http';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';

const arg = name => {const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1]};
const endpoint=new URL(arg('mcp-url')),workspace=arg('workspace'),output=arg('output');
if(!workspace||!output||existsSync(output)||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/mcp')throw Error('Pass loopback --mcp-url, --workspace and fresh --output');
let session,sequence=0,origin,before;
const calls=[],checks=[],owned=new Set(),controls=new Map();
async function rpc(method,params){
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(35000)});
 if(method==='initialize')session=r.headers.get('Mcp-Session-Id');
 const j=await r.json();if(!r.ok||j.error)throw Error(JSON.stringify(j));return j.result;
}
async function call(name,args={}){
 const start=performance.now();let result,error;
 try{const j=await rpc('tools/call',{name,arguments:args});const text=j.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');try{result=JSON.parse(text)}catch{result={message:text}}if(j.isError)error=result;if(result?.controlId)controls.set(args.tabId??result.tabId,result.controlId)}catch(e){error=String(e)}
 const record={name,args,wallMs:performance.now()-start,result,error};calls.push(record);return record;
}
async function ok(name,args){const r=await call(name,args);if(r.error)throw Error(JSON.stringify(r));return r.result}
function check(name,passed,detail){checks.push({name,passed:!!passed,detail});console.log(JSON.stringify(checks.at(-1)));if(!passed)throw Error(name)}
async function open(mode){const r=await ok('browser_open',{workspace,url:origin+'/'+mode});owned.add(r.tabId);await ok('browser_wait',{tabId:r.tabId,condition:'load',loadState:'complete',timeout:10000});return r.tabId}
async function close(tabId){if(controls.has(tabId))await ok('browser_end_session',{tabId,controlId:controls.get(tabId)});await ok('browser_close',{tabId,workspace});owned.delete(tabId)}
const css=value=>({by:'css',value,exact:true});
async function text(tabId,value){return ok('browser_get_text',{tabId,locator:css(value),maxLength:1000})}
function fixture(mode){
 if(mode==='cap')return '<!doctype html><title>Capped locator</title><div>'+('<i></i>'.repeat(50100))+'</div><button id="late">Late</button>';
 if(mode==='frame')return '<!doctype html><title>Frame ambiguity</title><button id="act">Root</button><iframe src="/inner" style="width:320px;height:180px"></iframe>';
 if(mode==='inner')return '<!doctype html><button id="act">Frame</button><button id="frame-only" onclick="this.textContent=\'Frame clicked\'">Frame only</button>';
 return `<!doctype html><meta charset="utf-8"><title>Locator target QA</title><style>body{font:15px sans-serif;padding:12px}button,input{margin:5px}#hidden{opacity:0}#offscreen{position:absolute;top:2000px}</style>
 <button id="act">Activate</button><button class="duplicate">One</button><button class="duplicate">Two</button>
 <output id="counter">0</output><output id="trusted">none</output>
 <form><input id="name" aria-label="Name"><input id="readonly" readonly value="fixed"><input id="password" type="password" value="fixture-secret"><button type="submit">Submit</button></form>
 <output id="submitted">Submitted 0</output><div id="hidden">Hidden</div><button id="offscreen">Offscreen</button>
 <input id="check" type="checkbox"><select id="select" onchange="document.querySelector('#chosen').textContent=this.value"><option value="one">One</option><option value="two">Two</option></select><output id="chosen">one</output>
 <button id="double" ondblclick="this.textContent='Doubled'">Double</button><button id="dialog" onclick="document.querySelector('#answer').textContent=String(confirm('Fixture confirmation'))">Dialog</button><output id="answer">none</output>
 <button id="remove" onclick="setTimeout(()=>document.querySelector('#gone').remove(),200)">Remove fixture node</button><div id="gone">Pending removal</div>
 <script>let count=0,submits=0;document.querySelector('#act').onclick=e=>{document.querySelector('#counter').textContent=String(++count);document.querySelector('#trusted').textContent=String(e.isTrusted)};document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#submitted').textContent='Submitted '+(++submits)}</script>`;
}
const server=http.createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.setHeader('Cache-Control','no-store');r.end(fixture(q.url.slice(1)))});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
try{
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-locator-target-qa',version:'1'}});
 await ok('skills_read',{workspace,name:'anbo'});before=await ok('browser_tabs');
 const tools=(await rpc('tools/list',{})).tools;
 const clickSchema=tools.find(t=>t.name==='browser_click').inputSchema;
 check('schema exposes named targets without root combinators',clickSchema.properties.ref&&clickSchema.properties.locator&&!clickSchema.anyOf&&!clickSchema.not&&!clickSchema.required.includes('ref'));
 let tabId=await open('native');
 const clicked=await ok('browser_click',{tabId,locator:css('#act')});
 check('direct locator sends one trusted native click',clicked.dispatch==='devtools'&&(await text(tabId,'#counter')).text==='1'&&(await text(tabId,'#trusted')).text==='true',clicked);
 for(const args of [{ref:'g1-e1',locator:css('#act')},{locator:{...css('#act'),limit:1}},{locator:{...css('#act'),timeout:0}},{locator:null}]){
  const result=await call('browser_click',{tabId,...args});check('invalid target rejected',!!result.error,result);
 }
 const ambiguous=await call('browser_click',{tabId,locator:css('.duplicate')});
 check('ambiguous locator never selects the first match',JSON.stringify(ambiguous.error).includes('ambiguous_target')&&(await text(tabId,'#counter')).text==='1',ambiguous);
 const timeout=await call('browser_click',{tabId,locator:css('#act'),waitFor:{text:'This result never appears',timeout:250,stableFor:0}});
 check('postcondition timeout never replays a dispatched click',!!timeout.error&&(await text(tabId,'#counter')).text==='2',timeout);
 const typed=await ok('browser_type',{tabId,locator:css('#name'),text:'Locator input'});
 check('locator type verifies its value',typed.ok&&typed.valueVerified,typed);
 const pressed=await ok('browser_press',{tabId,locator:css('#name'),key:'Enter',expectedValue:'Locator input',waitFor:{text:'Submitted 1',timeout:2000}});
 check('locator press retains input guard and postcondition',pressed.ok&&(await text(tabId,'#submitted')).text==='Submitted 1',pressed);
 check('press distinguishes skipped observation from verified postcondition',pressed.observationPerformed===false&&pressed.postcondition?.matched===true,pressed);
 const metadata=await ok('browser_find',{tabId,by:'css',value:'#name,#readonly,#password,#offscreen',includeHidden:true,limit:5});
 check('find exposes editable/readonly/viewport metadata',metadata.matches[0].editable&&!metadata.matches[0].readOnly&&metadata.matches[0].inViewport&&metadata.matches[1].readOnly&&!metadata.matches[1].editable&&!metadata.matches[3].inViewport&&metadata.matches[0].bounds.width>0,metadata);
 check('password remains redacted in richer metadata',metadata.matches[2].value==='[REDACTED]'&&!JSON.stringify(metadata).includes('fixture-secret'));
 check('text inputs are not unchecked controls',metadata.matches[0].checked===null,metadata.matches[0]);
 const notCheckbox=await call('browser_wait',{tabId,locator:css('#name'),state:'unchecked',timeout:250});
 check('unchecked wait rejects a textbox',!!notCheckbox.error,notCheckbox);
 const hidden=await ok('browser_wait',{tabId,locator:css('#hidden'),state:'hidden',timeout:500});
 check('hidden wait distinguishes hidden from absent',hidden.count===1&&hidden.coverageComplete,hidden);
 const absent=await ok('browser_wait',{tabId,locator:css('#not-present'),state:'absent',timeout:500});
 check('absent wait requires a complete zero-match scan',absent.count===0&&absent.coverageComplete,absent);
 const stillPresent=await call('browser_wait',{tabId,locator:css('#hidden'),state:'absent',timeout:250});check('hidden node does not count as absent',!!stillPresent.error,stillPresent);
 const mixed=await call('browser_wait',{tabId,locator:css('#hidden'),state:'hidden',waitFor:{text:'Hidden'}});check('mixed wait modes reject',!!mixed.error,mixed);
 const focused=await ok('browser_focus',{tabId,locator:css('#name')});check('locator focus uses existing action guards',focused.ok,focused);
 const hovered=await ok('browser_hover',{tabId,locator:css('#double'),position:{x:0.6,y:0.5}});check('locator hover verifies native CSS hover',hovered.ok&&hovered.cssHover&&hovered.dispatch==='devtools',hovered);
 const double=await ok('browser_double_click',{tabId,locator:css('#double')});check('locator double click reaches native double-click handler',(await text(tabId,'#double')).text==='Doubled',double);
 await ok('browser_check',{tabId,locator:css('#check'),checked:true});
 const checked=await ok('browser_wait',{tabId,locator:css('#check'),state:'checked',timeout:500});check('locator check and checked wait agree',checked.count===1,checked);
 await ok('browser_check',{tabId,locator:css('#check'),checked:false});
 const unchecked=await ok('browser_wait',{tabId,locator:css('#check'),state:'unchecked',timeout:500});check('locator uncheck and unchecked wait agree',unchecked.count===1,unchecked);
 const selected=await ok('browser_select_option',{tabId,locator:css('#select'),value:'two'});check('locator select fires verified option change',(await text(tabId,'#chosen')).text==='two',selected);
 const dialog=await ok('browser_dialog',{tabId,locator:css('#dialog'),dialogAction:'accept'});check('locator dialog retains page-world interception',dialog.ok&&dialog.dialogOpened&&(await text(tabId,'#answer')).text==='true',dialog);
 await ok('browser_click',{tabId,locator:css('#remove')});
 const removed=await ok('browser_wait',{tabId,locator:css('#gone'),state:'absent',timeout:1500});check('locator absent wait observes actual delayed removal',removed.count===0&&removed.coverageComplete,removed);
 await ok('browser_scroll_to_element',{tabId,locator:css('#offscreen')});
 const scrolled=await ok('browser_find',{tabId,by:'css',value:'#offscreen',limit:1});check('locator scroll updates viewport metadata',scrolled.matches[0].inViewport,scrolled);
 await close(tabId);
 tabId=await open('frame');
 const frameAmbiguous=await call('browser_click',{tabId,locator:css('#act')});check('uniqueness includes child frames',JSON.stringify(frameAmbiguous.error).includes('ambiguous_target'),frameAmbiguous);
 const frameClick=await ok('browser_click',{tabId,locator:css('#frame-only')});check('unique child target retains explicit DOM fallback',frameClick.dispatch==='dom-frame'&&(await text(tabId,'#frame-only')).text==='Frame clicked',frameClick);
 await close(tabId);
 tabId=await open('cap');
 for(const state of ['absent','hidden']){
  const capped=await call('browser_wait',{tabId,locator:css('#late'),state,timeout:2500});
  check('capped scan never proves '+state,!!capped.error&&JSON.stringify(capped.error).includes('nodeLimitReached=true'),capped);
 }
 await close(tabId);
}catch(error){checks.push({name:'suite completion',passed:false,detail:String(error)});console.error(error);process.exitCode=1}
finally{
 for(const tabId of [...owned])try{await close(tabId)}catch(error){console.error(error);process.exitCode=1}
 const after=await call('browser_tabs');
 checks.push({name:'owned tabs closed',passed:owned.size===0});
 const deleted=session&&await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session}});
 checks.push({name:'session closed',passed:!!deleted?.ok});
 server.closeAllConnections();server.close();
 await writeFile(output,JSON.stringify({checks,calls,before,after},null,2));
 console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
 if(checks.some(c=>!c.passed))process.exitCode=1;
}
