import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = name => {const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const endpoint=new URL(arg('mcp-url')),workspace=arg('workspace'),output=arg('output'),binary=arg('binary');
if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:'||endpoint.pathname!=='/mcp'||!workspace||!output||!binary||existsSync(output))throw Error('Explicit loopback endpoint, workspace, binary and fresh output required');
let session,id=0,childOrigin,origin,initial;
const owned=new Set(),checks=[],calls=[];
async function rpc(method,params){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(35000)});if(method==='initialize')session=response.headers.get('Mcp-Session-Id');const body=await response.json();if(body.error||!response.ok)throw Error(JSON.stringify(body));return body.result;}
async function call(name,args={}){const start=performance.now();const value=await rpc('tools/call',{name,arguments:args});const raw=value.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');let result;try{result=JSON.parse(raw);}catch{result={message:raw};}calls.push({name,args,wallMs:performance.now()-start,result,error:!!value.isError});if(value.isError)throw Error(raw);return result;}
function check(name,passed,detail){checks.push({name,passed:!!passed,detail});console.log(JSON.stringify(checks.at(-1)));}
const child=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><input aria-label="Frame input"><select aria-label="Frame select"><option value="a">Alpha</option><option value="b">Beta</option></select><button onclick="document.querySelector('output').textContent=String(++window.count)">Frame click</button><output>0</output><script>window.count=0;console.log('frame-log');</script>`);});
const root=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Frame lifecycle fixture</title><iframe src="${childOrigin}/frame" style="width:600px;height:180px"></iframe>`);});
async function close(tabId){const info=await call('browser_page_info',{tabId});if(!info.url.startsWith(origin+'/'))throw Error('Owned tab changed URL; close refused');await call('browser_close',{tabId,workspace,endSession:true});owned.delete(tabId);}
const hash=async()=>createHash('sha256').update(await readFile(binary)).digest('hex');
const beforeHash=await hash();
try{
  await new Promise(r=>child.listen(0,'127.0.0.1',r));childOrigin='http://127.0.0.1:'+child.address().port;
  await new Promise(r=>root.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+root.address().port;
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-frame-lifecycle',version:'1'}});initial=await call('browser_tabs');
  for(let cycle=0;cycle<20;cycle++){
    let tabId;
    try{
      const start=performance.now();tabId=(await call('browser_open',{workspace,url:origin+'/cycle-'+cycle})).tabId;owned.add(tabId);
      check('open '+cycle,true,{tabId,wallMs:performance.now()-start});
      await call('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:8000});
      const find=async(by,value,name)=>(await call('browser_find',{tabId,by,value,...(name?{name}:{}),exact:true,limit:20})).matches[0].ref;
      let ref=await find('role','textbox','Frame input');
      const text='frame-'+cycle;
      const filled=await call('browser_type',{tabId,ref,text});
      const state=await call('browser_get_property',{tabId,ref,properties:['value']});
      check('frame value '+cycle,filled.valueVerified&&state.values.value===text);
      ref=await find('role','combobox','Frame select');
      const selected=await call('browser_select_option',{tabId,ref,value:'b'});
      check('frame select '+cycle,selected.valueVerified===true);
      ref=await find('role','button','Frame click');
      await call('browser_click',{tabId,ref});
      const count=await call('browser_get_text',{tabId,ref:await find('css','output')});
      check('frame click exactly once '+cycle,count.text==='1');
      if(cycle===0){
        const oldRef=ref;await call('browser_reload',{tabId});await call('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:8000});
        let rejected=false;try{await call('browser_click',{tabId,ref:oldRef});}catch(error){rejected=/stale_ref|stale/.test(String(error));}
        check('reload rejects previous frame ref',rejected);
        const fresh=await call('browser_get_text',{tabId,ref:await find('css','output')});check('reload did not replay click',fresh.text==='0');
      }
    }catch(error){check('cycle '+cycle+' completed',false,String(error));}
    finally{if(tabId&&owned.has(tabId))try{await close(tabId);}catch(error){check('close '+cycle,false,String(error));}}
    if(owned.size)break;
  }
}catch(error){check('suite completed',false,String(error));}
finally{
  for(const tabId of owned)try{await close(tabId);}catch(error){check('cleanup',false,String(error));}
  try{const final=await call('browser_tabs');check('original tabs retained',JSON.stringify(initial?.tabs.map(t=>t.tabId).sort())===JSON.stringify(final.tabs.map(t=>t.tabId).sort()));}catch(error){check('tabs',false,String(error));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  for(const server of [root,child])await new Promise(r=>{server.close(r);server.closeAllConnections();});
}
check('binary unchanged',beforeHash===await hash(),beforeHash);
await writeFile(output,JSON.stringify({timestamp:new Date().toISOString(),endpoint:String(endpoint),binaryHash:beforeHash,checks,calls},null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
