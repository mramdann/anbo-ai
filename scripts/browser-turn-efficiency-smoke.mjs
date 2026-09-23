import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const endpoint = new URL(arg('mcp-url') ?? 'http://127.0.0.1:7332/mcp');
const workspace = arg('workspace'), output = arg('output'), binary = arg('binary');
if (!workspace || !output || !binary || endpoint.hostname !== '127.0.0.1') throw Error('Pass loopback --mcp-url, --workspace, --output and --binary');
const calls = [], checks = [], workflows = [], owned = new Set();
const extended = arg('extended') === 'true';
let session, sequence = 0, before, origin, failure;
async function rpc(method, params) {
  const response = await fetch(endpoint, {method:'POST',headers:{'Content-Type':'application/json',...(session ? {'Mcp-Session-Id':session} : {})},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(30000)});
  if (method === 'initialize') session = response.headers.get('Mcp-Session-Id');
  const data = await response.json();
  if (!response.ok || data.error) throw Error(JSON.stringify(data.error ?? response.status));
  return data.result;
}
async function call(name, args) {
  const start = performance.now();
  const envelope = await rpc('tools/call', {name,arguments:args});
  const raw = envelope.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let result; try { result = JSON.parse(raw); } catch { result = {message:raw}; }
  const sample = {name,args,wallMs:performance.now()-start,error:envelope.isError === true,result};
  calls.push(sample); return sample;
}
async function ok(name, args) { const r = await call(name,args); if (r.error) throw Error(JSON.stringify(r)); return r.result; }
function check(name, passed, detail) { checks.push({name,passed:!!passed,detail}); console.log(JSON.stringify(checks.at(-1))); }
const base = '<!doctype html><meta charset="utf-8"><title>Turn efficiency fixture</title><style>body{font:16px sans-serif;margin:20px}button,input,a{padding:10px;margin:6px;display:inline-block}td{padding:6px}</style>';
const server = http.createServer((req,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
  if (req.url.startsWith('/results')) return res.end(base+'<h1>Search results</h1><main><a href="/chosen">Berlin Population</a><a href="/video">Videos of Berlin Population</a></main>');
  if (req.url === '/chosen') return res.end(base+'<h1>Correct destination</h1>');
  res.end(base+`<form action="/results"><input aria-label="Query" name="q"><button>Search</button></form>
    <table><tbody><tr><td><div><div><span><a href="/india">India</a></span></div></div></td><td>1,450,935,791</td><td>2024</td></tr><tr><td>Other row</td><td>999</td></tr></tbody></table>
    <input role="combobox" aria-label="Append query" value="old" aria-haspopup="listbox">
    <button id="replace">Replace target</button><a id="identity" href="/chosen">Identity target</a>
    <input id="drift" role="combobox" aria-label="Drifting focus" aria-haspopup="listbox"><input id="other" aria-label="Untouched field" value="keep">
    <input id="reset" role="combobox" aria-label="Reset value" aria-haspopup="listbox">
    <script>
    document.querySelector('#replace').onclick=()=>document.querySelector('#identity').outerHTML='<a id="identity" href="/wrong">Identity target</a>';
    document.querySelector('#drift').oninput=()=>document.querySelector('#other').focus();
    document.querySelector('#reset').oninput=e=>{if(e.isTrusted)e.target.value='page override'};
    </script>`);
});
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex');
const binaryHash = await hash();
try {
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'codex-turn-efficiency',version:'1'}});
  before = await ok('browser_tabs',{});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const {tabId} = await ok('browser_open',{workspace,url:origin}); owned.add(tabId);
  const find = args => ok('browser_find',{tabId,...args});
  const read = args => ok('browser_get_text',{tabId,...args});
  await ok('browser_wait',{tabId,condition:'load',loadState:'complete',timeout:5000});
  const row = await find({by:'role',value:'link',name:'India',exact:true,ancestors:'row'});
  check('semantic row returns complete row without neighboring row',row.matches?.[0]?.block?.includes('1,450,935,791') && !row.matches[0].block.includes('999'),row.matches);
  const readRow = await read({ref:row.matches[0].ref,ancestors:'row'});
  check('get_text shares semantic row selection',readRow.text.includes('1,450,935,791') && !readRow.text.includes('999'),readRow);
  const typed = await ok('browser_type',{tabId,locator:{by:'role',value:'combobox',name:'Append query',exact:true},text:'new',append:true});
  const value = await ok('browser_get_property',{tabId,ref:typed.ref,properties:['value']});
  check('append remains append when autocomplete produces no suggestions',JSON.stringify(value).includes('oldnew'),value);
  const identity = (await find({by:'css',value:'#identity'})).matches[0].ref;
  await ok('browser_click',{tabId,locator:{by:'role',value:'button',name:'Replace target',exact:true}});
  const stale = await call('browser_click',{tabId,ref:identity});
  check('replacement with identical name is not clicked',stale.error && JSON.stringify(stale.result).includes('stale_ref'),stale.result);
  for (let i=0;i<3;i++) {
    await ok('browser_navigate',{tabId,url:origin});
    const input = await ok('browser_type',{tabId,locator:{by:'role',value:'textbox',name:'Query',exact:true},text:'Berlin'});
    const press = await ok('browser_press',{tabId,ref:input.ref,key:'Enter',expectedValue:'Berlin',waitFor:{title:'Turn efficiency fixture',url:origin+'/results*',text:'Search results',timeout:5000}});
    const hint = press.page?.hints?.controls?.find(c => c.name === 'Berlin Population');
    const clicked = hint ? await call('browser_click',{tabId,ref:hint.ref,reveal:0,waitFor:{text:'Correct destination',timeout:3000}}) : undefined;
    check('navigation hint ref is immediately actionable #'+(i+1),hint && clicked && !clicked.error,{hint,result:clicked?.result});
    await ok('browser_navigate',{tabId,url:origin+'/results'});
    await ok('browser_wait',{tabId,waitFor:{text:'Search results',timeout:5000}});
    const ambiguous = await call('browser_click',{tabId,locator:{by:'role',value:'link',name:'Berlin Population'}});
    const message = JSON.stringify(ambiguous.result);
    check('ambiguity includes live candidate refs without dispatch #'+(i+1),ambiguous.error && message.includes('ambiguous_target') && /g\d+-e\d+/.test(message),ambiguous.result);
    if (extended) {
      const ref = message.match(/(g\d+-e\d+) <a>/)?.[1];
      const selected = ref && await call('browser_click',{tabId,ref,waitFor:{text:'Correct destination',timeout:3000}});
      check('candidate ref from ambiguity is actionable #'+(i+1),selected && !selected.error,selected?.result);
      await ok('browser_navigate',{tabId,url:origin+'/results'});
    }
    const exact = await ok('browser_click',{tabId,locator:{by:'role',value:'link',name:'Berlin Population',exact:true},waitFor:{text:'Correct destination',timeout:3000}});
    check('explicit exact match selects correct destination #'+(i+1),exact.ok === true);
  }
  if (extended) {
    await ok('browser_navigate',{tabId,url:origin});
    const drift = await ok('browser_type',{tabId,locator:{by:'label',value:'Drifting focus'},text:'typed'});
    const untouched = await ok('browser_get_property',{tabId,locator:{by:'label',value:'Untouched field'},properties:['value']});
    check('autocomplete fallback never types into a field that stole focus',untouched.values.value === 'keep' && !drift.nativeRetype,{drift,untouched});
    const reset = await call('browser_type',{tabId,locator:{by:'label',value:'Reset value'},text:'typed'});
    check('partial native fallback does not report false success',reset.error && JSON.stringify(reset.result).includes('dispatched'),reset.result);
    const noRow = await call('browser_get_text',{tabId,locator:{by:'label',value:'Untouched field'},ancestors:'row'});
    check('missing semantic row is explicit, not a body read',noRow.error && JSON.stringify(noRow.result).includes('context_not_found'),noRow.result);
    const noTarget = await call('browser_get_text',{tabId,ancestors:'row'});
    check('semantic row without target is rejected',noTarget.error);
    const bad = await call('browser_open',{workspace,url:origin,closeTab:true});
    check('close-on-open requires a read and creates no tab',bad.error && (await ok('browser_tabs',{})).tabs.length === before.tabs.length+owned.size);
    const failed = await ok('browser_open',{workspace,url:origin,find:{by:'role',value:'button',name:'does not exist',timeout:150},closeTab:true});owned.add(failed.tabId);
    check('failed initial read retains its new tab and recovery handle',failed.readOk === false && failed.closed === false && (await ok('browser_tabs',{})).tabs.some(t=>t.tabId===failed.tabId),failed);
    await ok('browser_close',{workspace,tabId:failed.tabId});owned.delete(failed.tabId);
    const snapshot = await ok('browser_open',{workspace,url:origin,snapshot:true,closeTab:true});
    if(!snapshot.closed)owned.add(snapshot.tabId);
    check('initial snapshot can close only its new tab',snapshot.closed===true && snapshot.refsUsable===false && snapshot.read.snapshot.includes('India'),snapshot);
    for (const mode of ['legacy','combined','combined','legacy','legacy','combined','combined','legacy']) {
      const start=performance.now(), offset=calls.length;
      let text;
      if(mode==='legacy') {
        const opened=await ok('browser_open',{workspace,url:origin});owned.add(opened.tabId);
        const row=await ok('browser_find',{tabId:opened.tabId,by:'role',value:'link',name:'India',exact:true,ancestors:'row'});
        text=row.matches[0].block;
        await ok('browser_close',{workspace,tabId:opened.tabId});owned.delete(opened.tabId);
      } else {
        const opened=await ok('browser_open',{workspace,url:origin,find:{by:'role',value:'link',name:'India',exact:true,ancestors:'row'},closeTab:true});
        if(!opened.closed)owned.add(opened.tabId);
        if(!opened.closed||!opened.readOk)throw Error('Combined lifecycle failed');
        text=opened.read.matches[0].block;
      }
      workflows.push({mode,calls:calls.length-offset,wallMs:performance.now()-start,correct:text.includes('1,450,935,791')&&!text.includes('999')});
    }
    check('combined read preserves facts while removing two calls',workflows.every(w=>w.correct&&w.calls===(w.mode==='legacy'?3:1)),workflows);
  }
} catch(error) { failure=String(error); }
finally {
  for (const tabId of owned) { const closed=await call('browser_close',{tabId,workspace,endSession:true}).catch(()=>null); if(closed&&!closed.error)owned.delete(tabId); }
  const after=await ok('browser_tabs',{}).catch(()=>null);
  check('original tabs retained',JSON.stringify(before?.tabs?.map(t=>t.tabId).sort())===JSON.stringify(after?.tabs?.map(t=>t.tabId).sort()));
  if(session)await fetch(endpoint,{method:'DELETE',headers:{'Mcp-Session-Id':session},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
check('binary unchanged',binaryHash===await hash());
const report={createdAt:new Date().toISOString(),binaryHash,workspace,endpoint:String(endpoint),failure,checks,calls,workflows,unclosedTabs:[...owned]};
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length,failure}));
if(failure||owned.size||checks.some(c=>!c.passed))process.exitCode=1;
