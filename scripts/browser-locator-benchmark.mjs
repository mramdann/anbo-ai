import http from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const arg = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? undefined : process.argv[index + 1]; };
const output = arg('output');
if (!output || existsSync(output)) throw Error('Pass a fresh --output path');
const clients = ['before', 'after'].map(label => {
  const endpoint = new URL(arg(label + '-url'));
  const workspace = arg(label + '-workspace');
  if (!workspace || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') throw Error('Explicit loopback endpoints and workspaces required');
  return {label, endpoint, workspace, owned:new Set(), controls:new Map(), sequence:0, session:null};
});
const calls=[], checks=[], summaries=[];
let origin;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');
  const count=Number(url.searchParams.get('nodes'));
  if (![1000,15000,49000,55000].includes(count)) { res.writeHead(400);res.end();return; }
  res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
  res.end(`<!doctype html><title>Locator benchmark ${count}</title><style>i{display:none}</style><body>${'<i></i>'.repeat(count)}<button id="target">Benchmark target</button></body>`);
});
async function rpc(client,method,params) {
  const response=await fetch(client.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(client.session?{'Mcp-Session-Id':client.session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++client.sequence,method,params}),signal:AbortSignal.timeout(20000)});
  if(method==='initialize')client.session=response.headers.get('Mcp-Session-Id');
  const payload=await response.json();if(!response.ok||payload.error)throw Error(JSON.stringify(payload.error??{status:response.status}));return payload.result;
}
async function call(client,name,args={}) {
  const start=performance.now();let result,error;
  try {
    const envelope=await rpc(client,'tools/call',{name,arguments:args});
    const raw=envelope.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    try {result=JSON.parse(raw);}catch {result={message:raw};}
    if(envelope.isError)error=result;
    if(args.tabId&&result.controlId)client.controls.set(args.tabId,result.controlId);
  }catch(cause){error=String(cause);}
  const sample={label:client.label,name,args,wallMs:performance.now()-start,result,error};calls.push(sample);return sample;
}
async function ok(client,name,args){const sample=await call(client,name,args);if(sample.error)throw Error(JSON.stringify(sample.error));return sample.result;}
function check(name,passed,detail){const value={name,passed:!!passed,detail};checks.push(value);console.log(JSON.stringify(value));}
function stats(values){const sorted=[...values].sort((a,b)=>a-b);return{p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1]};}
async function close(client,tabId){
  const page=await ok(client,'browser_get_url',{tabId});if(!page.url.startsWith(origin+'/'))throw Error('Owned tab changed origin');
  if(client.controls.has(tabId))await ok(client,'browser_end_session',{tabId,controlId:client.controls.get(tabId)});
  await ok(client,'browser_close',{workspace:client.workspace,tabId});client.owned.delete(tabId);
}
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  for(const client of clients){
    await rpc(client,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'anbo-locator-benchmark',version:'1'}});
    await ok(client,'skills_read',{workspace:client.workspace,name:'anbo'});
    client.before=await ok(client,'browser_tabs',{});
  }
  for(const nodes of [1000,15000,49000,55000]) {
    for(const client of clients){
      const opened=await ok(client,'browser_open',{workspace:client.workspace,url:origin+'/?nodes='+nodes});client.tabId=opened.tabId;client.owned.add(opened.tabId);if(opened.controlId)client.controls.set(opened.tabId,opened.controlId);
      await ok(client,'browser_wait',{tabId:opened.tabId,condition:'load',loadState:'complete',timeout:8000});
    }
    for(const by of ['css','role']) {
      const samples=new Map(clients.map(client=>[client.label,[]]));
      const iterations=nodes===55000?3:35;
      for(let round=0;round<iterations;round++)for(const client of (round%2?[...clients].reverse():clients)) {
        const sample=await call(client,'browser_find',{tabId:client.tabId,by,value:by==='css'?'#target':'button',...(by==='role'?{name:'Benchmark target',exact:true}:{}),limit:1,timeout:nodes===55000?350:3000});
        sample.nodes=nodes;sample.round=round;sample.warmup=nodes!==55000&&round<5;
        if(!sample.warmup)samples.get(client.label).push(sample);
      }
      for(const client of clients){
        const rows=samples.get(client.label);
        if(nodes===55000){
          check(client.label+' bounded scan '+by,rows.every(r=>!!r.error),rows.map(r=>r.error));
          if(client.label==='after')check('capped timeout reports incomplete coverage '+by,rows.every(r=>/nodeLimitReached=true/.test(JSON.stringify(r.error))&&/scanned portion/.test(JSON.stringify(r.error))),rows.map(r=>r.error));
        }else{
          check(client.label+' finds target '+nodes+' '+by,rows.every(r=>!r.error&&r.result.matches?.length===1));
          if(client.label==='after')check('uncapped metadata '+nodes+' '+by,rows.every(r=>r.result.nodeLimitReached===false));
          const valid=rows.filter(r=>!r.error);
          const summary={label:client.label,nodes,by,samples:valid.length,wallMs:stats(valid.map(r=>r.wallMs)),nativeMs:stats(valid.map(r=>r.result.durationMs))};summaries.push(summary);console.log(JSON.stringify(summary));
        }
      }
    }
    for(const client of clients)await close(client,client.tabId);
  }
}catch(cause){check('suite completed',false,String(cause));}
finally{
  for(const client of clients){
    for(const tabId of [...client.owned])try{await close(client,tabId);}catch(cause){check('cleanup '+client.label,false,String(cause));}
    const after=await call(client,'browser_tabs',{});
    check(client.label+' original tabs retained',!after.error&&client.before?.tabs.every(t=>after.result.tabs.some(a=>a.tabId===t.tabId)));
    check(client.label+' owned tabs closed',client.owned.size===0);
    if(client.session)try{const response=await fetch(client.endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':client.session},signal:AbortSignal.timeout(5000)});check(client.label+' session closed',response.ok);}catch(cause){check(client.label+' session closed',false,String(cause));}
  }
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await writeFile(output,JSON.stringify({timestamp:new Date().toISOString(),method:'5 warmups + 30 samples per successful locator; paired alternating client order; 3 bounded negative scans',clients:clients.map(c=>({label:c.label,endpoint:String(c.endpoint),workspace:c.workspace})),summaries,checks,calls},null,2),{flag:'wx'});
  if(checks.some(c=>!c.passed))process.exitCode=1;
}
