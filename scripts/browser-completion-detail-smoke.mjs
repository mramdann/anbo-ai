import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?undefined:process.argv[i+1];};
const modulePath=arg('playwright'),output=arg('output');
if(!modulePath||!output?.endsWith('.json')||existsSync(output))throw Error('Explicit Playwright module and fresh output required');
const {chromium}=await import(pathToFileURL(modulePath).href);
const source=await readFile('src-tauri/src/modules/browser_automation/activityOverlay.js','utf8');
const browser=await chromium.launch({headless:true,executablePath:arg('browser')}),checks=[];
try{
  const page=await browser.newPage({viewport:{width:1000,height:720}});
  await page.setContent('<!doctype html><title>Completion detail fixture</title><button>Page control</button>');
  await page.evaluate(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=attach.call(this,options);window.testRoot=root;return root;};});
  await page.evaluate(source);
  let sequence=0;
  const emit=async phase=>{
    await page.evaluate(data=>{window.dispatchEvent(new CustomEvent('anbo-automation-visual',{detail:data}));}, {phase,sequence:++sequence,requestId:1,controlId:1,method:'click',actor:{brand:'claude',label:'Claude'},point:{x:420,y:310}});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const state=()=>page.evaluate(()=>{const root=window.testRoot,detail=root.querySelector('.detail'),cursor=root.querySelector('.cursor'),badge=root.querySelector('.badge');return {detail:detail.textContent,display:getComputedStyle(detail).display,cursor:getComputedStyle(cursor).display,name:root.querySelector('.name').textContent,tool:root.querySelector('.tool').textContent,height:badge.getBoundingClientRect().height,phase:badge.dataset.state,text:document.body.innerText};});
  await emit('running');const running=await state();
  assert(running.detail.startsWith('Clicking'));assert.notEqual(running.display,'none');checks.push('Running action detail remains visible');
  await emit('done');const done=await state();
  assert.equal(done.detail,'');assert.equal(done.display,'none');assert.equal(done.cursor,'block');assert.equal(done.name,'Claude');assert.equal(done.tool,'browser_click');assert(done.height<=running.height);assert.equal(done.text,'Page control');checks.push('Completed detail hidden; cursor, identity and page content retained');
  await emit('error');const error=await state();
  assert(error.detail.startsWith('Action stopped'));assert.notEqual(error.display,'none');checks.push('Errors remain visible after completion');
  await emit('running');assert.notEqual((await state()).display,'none');checks.push('Next action restores detail');
  await emit('ended');assert.equal(await page.locator('[data-anbo-visual]').count(),0);checks.push('Session end cleans up overlay');
  await writeFile(output,JSON.stringify({passed:true,checks,running,done,error,engine:browser.version(),scope:'Owned headless fixture only; no Dev window change or latency comparison.'},null,2),{flag:'wx'});
  console.log(JSON.stringify({passed:true,checks,output}));
}finally{await browser.close();}
