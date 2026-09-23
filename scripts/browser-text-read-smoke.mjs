import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const workspace = arg('workspace'), output = arg('output'), binary = arg('binary');
if (!workspace || !output?.endsWith('.json') || !binary) throw Error('Explicit workspace, binary and fresh JSON output required');
const endpoint = 'http://127.0.0.1:7332/mcp', checks = [], calls = [], owned = new Set(), timers = new Set();
let session, sequence = 0, origin, initialTabs, parserFinished = false;
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
const beforeHash = await hash();
const agent = new http.Agent({keepAlive:true,maxSockets:1});
const base = '<!doctype html><meta charset="utf-8"><title>Text read correctness</title><body>';
const server = http.createServer((req,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
  if(req.url==='/parser') {
    parserFinished=false;res.write(base+'<p>Partial content</p>');
    const timer=setTimeout(()=>{timers.delete(timer);parserFinished=true;res.end('<p>Final content</p></body>');},1200);timers.add(timer);return;
  }
  res.end(base+'<p id="inline">Alpha<span aria-hidden="true">999</span>Beta</p><div id="shadow"></div><button id="replace" onclick="document.querySelector(\'#inline\').outerHTML=\'<p id=inline>Replacement</p>\'">Replace target</button><button id="named" aria-label="Named control"></button><script>const root=document.querySelector("#shadow").attachShadow({mode:"open"});root.innerHTML="<span>Shadow</span><span aria-hidden=true>hidden</span><span>Text</span>";</script>');
});
async function rpc(method,params){
  const body=JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params});
  const result=await new Promise((resolve,reject)=>{
    const request=http.request(endpoint,{method:'POST',agent,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...(session?{'Mcp-Session-Id':session}:{})}},response=>{
      let data='';response.on('data',chunk=>data+=chunk);response.on('error',reject);response.on('end',()=>{try{resolve({status:response.statusCode,session:response.headers['mcp-session-id'],data:JSON.parse(data)});}catch(error){reject(error);}});
    });request.on('error',reject);request.setTimeout(15000,()=>request.destroy(Error('timeout')));request.end(body);
  });
  if(method==='initialize')session=result.session;
  if(result.status!==200||result.data.error)throw Error(JSON.stringify(result));return result.data.result;
}
async function call(name,args={}){const started=performance.now(),envelope=await rpc('tools/call',{name,arguments:args});const raw=envelope.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');let result;try{result=JSON.parse(raw);}catch{result=raw;}const sample={name,args,error:envelope.isError===true,result,wallMs:performance.now()-started};calls.push(sample);return sample;}
async function ok(name,args){const sample=await call(name,args);if(sample.error)throw Error(JSON.stringify(sample));return sample.result;}
function check(name,passed,detail){checks.push({name,passed:!!passed,detail});console.log(JSON.stringify({name,passed:!!passed}));}
async function close(tabId){if(!owned.has(tabId))throw Error('Unowned tab');if(!(await ok('browser_get_url',{tabId})).url.startsWith(origin+'/'))throw Error('Changed origin');await ok('browser_close',{tabId,workspace,endSession:true});owned.delete(tabId);}
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'text-read-correctness',version:'1'}});
  await ok('skills_read',{workspace,name:'anbo'});initialTabs=await ok('browser_tabs');
  const tabId=(await ok('browser_open',{workspace,url:origin+'/ready'})).tabId;owned.add(tabId);
  await ok('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:8000});
  const find=async selector=>(await ok('browser_find',{tabId,by:'css',value:selector,limit:1})).matches[0].ref;
  const inline=await find('#inline');
  check('inline text excludes aria-hidden without inserting a space',(await ok('browser_get_text',{tabId,ref:inline})).text==='AlphaBeta');
  check('shadow composed text semantics retained',(await ok('browser_get_text',{tabId,ref:await find('#shadow')})).text==='ShadowText');
  const named=await ok('browser_get_text',{tabId,ref:await find('#named')});
  check('accessible-name fallback retained',named.text==='Named control'&&named.source==='accessibleName',named);
  const clipped=await ok('browser_get_text',{tabId,ref:inline,maxLength:5});
  check('bounded text remains explicitly truncated',clipped.truncated===true&&clipped.totalLength===9&&clipped.text.length<=5,clipped);
  await ok('browser_click',{tabId,ref:await find('#replace')});
  const stale=await call('browser_get_text',{tabId,ref:inline});
  check('old ref never reads a replacement with the same ID',stale.error&&String(stale.result).includes('stale_ref'),stale);
  check('fresh locator reads the replacement',(await ok('browser_get_text',{tabId,locator:{by:'css',value:'#inline'}})).text==='Replacement');
  await close(tabId);
  for(let i=0;i<3;i++) {
    const slow=(await ok('browser_open',{workspace,url:origin+'/parser'})).tabId;owned.add(slow);
    const finishedBefore=parserFinished;
    const read=await ok('browser_get_text',{tabId:slow});
    check('parser '+i+' waits for complete readable content',parserFinished&&read.text.includes('Final content'),{finishedBefore,read});
    await close(slow);
  }
}catch(error){check('suite completed',false,String(error));}
finally {
  for(const tabId of [...owned])try{await close(tabId);}catch(error){check('cleanup',false,String(error));}
  try{const after=await ok('browser_tabs');check('original tabs retained',JSON.stringify(initialTabs.tabs.map(t=>t.tabId).sort())===JSON.stringify(after.tabs.map(t=>t.tabId).sort()));}catch(error){check('tab verification',false,String(error));}
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  agent.destroy();for(const timer of timers)clearTimeout(timer);
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
}
const finalHash=await hash();check('binary unchanged',beforeHash===finalHash);
await writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),endpoint,workspace,beforeHash,finalHash,checks,calls},null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
