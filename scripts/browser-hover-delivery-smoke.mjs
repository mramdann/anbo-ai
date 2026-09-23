import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url')), workspace = arg('workspace'), output = arg('output'), binary = arg('binary');
if (endpoint.origin !== 'http://127.0.0.1:7332' || endpoint.pathname !== '/mcp' || !workspace || !output?.endsWith('.json') || !binary || existsSync(output)) throw Error('Explicit Dev endpoint, workspace, binary and fresh JSON output required');
const repeat = Number(arg('repeat') ?? 100);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 1000) throw Error('repeat must be 1..1000');
let session, sequence = 0, origin, initialTabs, finalTabs;
const checks = [], samples = [], owned = new Set();
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
const beforeHash = await hash();
const fixture = mode => `<!doctype html><meta charset="utf-8"><title>Hover verification ${mode}</title>
<style>body{margin:20px;font:14px sans-serif}button{width:160px;height:44px;margin-right:80px}button:hover{background:rgb(200,240,200)}output{display:block;white-space:pre-wrap}</style>
<button id="target">Hover target</button><button id="other">Other target</button><output id="state"></output><div id="content"></div>
<script>
const mode=${JSON.stringify(mode)}, target=document.querySelector('#target'), output=document.querySelector('#state');
const events=[]; let moves=0, trusted=true;
const render=()=>output.textContent=JSON.stringify({events,moves,trusted,connected:target.isConnected,cssHover:target.matches(':hover'),width:innerWidth,height:innerHeight,userAgent:navigator.userAgent});
for(const type of ['pointerover','pointermove','pointerout','mouseover','mousemove','mouseout'])document.addEventListener(type,event=>{
if(!['target','other'].includes(event.target.id))return;
events.push({type,id:event.target.id,x:event.clientX,y:event.clientY,trusted:event.isTrusted,at:performance.now()}); if(events.length>24)events.shift();
if(type==='mousemove'){moves++;trusted&&=event.isTrusted;} queueMicrotask(render);
},true);
target.addEventListener('mouseenter',()=>{
if(mode==='relocate')target.style.transform='translateY(80px)';
if(mode==='detach')target.remove();
if(mode==='cover'){const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;left:20px;top:20px;width:160px;height:44px;background:orange';document.body.append(cover);}
});
if(mode==='blocked'){const cover=document.createElement('div');cover.style.cssText='position:fixed;left:20px;top:20px;width:160px;height:44px;background:orange';document.body.append(cover);}
if(mode==='stale-before')document.querySelector('#other').addEventListener('mouseenter',()=>target.remove());
const fragment=document.createDocumentFragment();for(let i=0;i<17000;i++){const node=document.createElement('span');node.textContent='Row '+i+' ';fragment.append(node)}document.querySelector('#content').append(fragment);render();
</script>`;
const server = http.createServer((req,res) => { res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(fixture(new URL(req.url,'http://localhost').pathname.slice(1))); });
async function rpc(method,params) {
  const response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(30000)});
  if(method==='initialize')session=response.headers.get('Mcp-Session-Id');
  const envelope=await response.json();if(!response.ok||envelope.error)throw Error(JSON.stringify(envelope));return envelope.result;
}
async function call(name,args={}) {
  const start=performance.now(), envelope=await rpc('tools/call',{name,arguments:args});
  const raw=envelope.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  let result;try{result=JSON.parse(raw);}catch{result=raw;}
  return {error:envelope.isError===true,result,wallMs:performance.now()-start};
}
async function ok(name,args){const sample=await call(name,args);if(sample.error)throw Error(JSON.stringify(sample));return sample.result;}
function check(name,passed,detail){checks.push({name,passed:!!passed,detail});console.log(JSON.stringify({name,passed:!!passed}));}
async function close(tabId){if(!owned.has(tabId))throw Error('Unowned tab');const page=await ok('browser_get_url',{tabId});if(!page.url.startsWith(origin+'/'))throw Error('Changed origin');await ok('browser_close',{tabId,workspace,endSession:true});owned.delete(tabId);}
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'hover-verification',version:'1'}});
  await ok('skills_read',{workspace,name:'anbo'});initialTabs=await ok('browser_tabs');
  for(const mode of ['static','alternate','relocate','detach','cover','blocked','stale-before']) {
    const tabId=(await ok('browser_open',{workspace,url:origin+'/'+mode})).tabId;owned.add(tabId);
    await ok('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:8000});
    const find=async selector=>(await ok('browser_find',{tabId,by:'css',value:selector,limit:1})).matches[0].ref;
    const target=await find('#target'), other=await find('#other'), stateRef=await find('#state');
    const state=async()=>JSON.parse((await ok('browser_get_text',{tabId,ref:stateRef})).text);
    const before=await state();
    const count=['static','alternate'].includes(mode)?repeat:1;
    // Start away from the measured target, including a fresh document at the same screen position.
    await ok('browser_hover',{tabId,ref:other});
    for(let iteration=0;iteration<count;iteration++) {
      const ref=mode==='alternate'&&iteration%2?other:target;
      const sample=await call('browser_hover',{tabId,ref});
      samples.push({mode,iteration,...sample,expectedError:['blocked','stale-before'].includes(mode)});
      if(sample.error){samples.at(-1).state=await state();break;}
    }
    const after=await state(), rows=samples.filter(s=>s.mode===mode);
    if(['blocked','stale-before'].includes(mode)) {
      check(mode+' rejects before native input',rows.length===1&&rows[0].error&&!after.events.some(event=>event.id==='target'),{rows,after});
    } else check(mode+' hover delivered without false failure',rows.length===count&&rows.every(s=>!s.error),{count:rows.length,errors:rows.filter(s=>s.error),after});
    check(mode+' no duplicate trusted movement',after.trusted&&after.moves<=count+1&&after.moves>=1,after);
    check(mode+' viewport unchanged',before.width===after.width&&before.height===after.height,{before,after});
    await close(tabId);
  }
} catch(error){check('suite completed',false,String(error));}
finally {
  for(const tabId of [...owned])try{await close(tabId);}catch(error){check('cleanup',false,String(error));}
  try{finalTabs=await ok('browser_tabs');check('original tabs retained',JSON.stringify(initialTabs.tabs.map(t=>t.tabId).sort())===JSON.stringify(finalTabs.tabs.map(t=>t.tabId).sort()),{initialTabs,finalTabs});}catch(error){check('tab verification',false,String(error));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session}}).catch(()=>{});
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}
const finalHash=await hash();check('binary unchanged',beforeHash===finalHash,{beforeHash,finalHash});
await writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),endpoint:String(endpoint),workspace,repeat,beforeHash,finalHash,checks,samples},null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
