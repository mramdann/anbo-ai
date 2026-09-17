import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const arg = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
const beforeRoot = arg('before-root'), afterRoot = arg('after-root'), output = arg('output');
if (!beforeRoot || !afterRoot || !output || existsSync(output)) throw Error('Explicit source roots and fresh --output required');
async function load(root, reference = false) {
  const dir = root + '/src-tauri/src/modules/browser_automation/';
  const rust = await readFile(dir + 'locator.rs', 'utf8');
  const start = rust.indexOf('r#"(function()', rust.indexOf('pub fn build_find_js')) + 3;
  let template = rust.slice(start, rust.indexOf('"#,', start));
  if (reference) template = template
    .replace('if (!hits.length) pocketCandidate(el);', 'pocketCandidate(el);');
  const visibility = await readFile(dir + 'visibility.rs', 'utf8');
  const sources = {
    REF_REGISTRY_JS: await readFile(dir + 'refRegistry.js', 'utf8'),
    ACCESSIBLE_NAME_JS: await readFile(dir + 'accessibleName.js', 'utf8'),
    VISIBILITY_JS: visibility.slice(visibility.indexOf('r#"') + 3, visibility.indexOf('"#;')),
    cache: await readFile(dir + 'locatorCache.js', 'utf8'),
    candidates: template.includes('{candidates}') ? await readFile(dir + 'locatorCandidates.js', 'utf8') : '',
  };
  return { hash: createHash('sha256').update(template + JSON.stringify(sources)).digest('hex'), build(query, generation) {
    const values = {...sources, generation, ref_prefix: JSON.stringify('g' + generation + '-e'), by:JSON.stringify(query.by), value:JSON.stringify(query.value), name:JSON.stringify(query.name ?? null), exact:query.exact ?? true, include_hidden:query.includeHidden ?? false, limit:query.limit ?? 20, relaxations:'[]'};
    return template.replace(/\{\{|\}\}|\{([A-Za-z_]+)\}/g, (token,key) => token === '{{' ? '{' : token === '}}' ? '}' : String(values[key]));
  }};
}
const sources = [await load(beforeRoot, arg('reference-walk') === 'true'), await load(afterRoot)];
const { chromium } = await import(pathToFileURL(arg('playwright')).href);
const browser = await chromium.launch({headless:true, executablePath:arg('chrome')});
const page = await browser.newPage();
const checks = [], timings = [];
const check = (name, passed, detail) => { checks.push({name,passed,detail}); console.log(JSON.stringify(checks.at(-1))); };
const fixtures = [
  {name:'17k-flat', html:'<button id="target">Target</button>' + '<i></i>'.repeat(17000) + '<button id="last">Last</button>', queries:[{by:'css',value:'#target'}, {by:'css',value:'#last'}, {by:'role',value:'button',name:'Last'}, {by:'css',value:'button',limit:1}, {by:'role',value:'button',name:'Missing'}, {by:'css',value:'.missing'}, {by:'css',value:':scope',limit:3}, {by:'css',value:'['}]},
  {name:'shadow-and-hidden', html:'<button id="first">First</button><div id="host"></div><button hidden>Hidden</button><button style="opacity:0">Transparent</button><button role="switch checkbox">Switch</button><input type="search" aria-label="Search"><div id="escaped:id">Escaped</div><svg><a href="/svg"><text>SVG link</text></a></svg><anbo-design-layer></anbo-design-layer>' + '<span></span>'.repeat(300), shadow:true, queries:[{by:'css',value:'button'}, {by:'role',value:'button'}, {by:'role',value:'button',includeHidden:true}, {by:'role',value:'textbox'}, {by:'role',value:'link'}, {by:'role',value:'switch'}, {by:'css',value:'#escaped\\:id'}, {by:'css',value:'anbo-design-layer,button'}, {by:'role',value:'button',name:'Missing'}]},
  {name:'bounded-55k', html:'<button>Before cap</button>' + '<i></i>'.repeat(55000) + '<button id="late">After cap</button>', queries:[{by:'css',value:'#late'}, {by:'role',value:'button',name:'After cap'}, {by:'role',value:'button'}, {by:'css',value:'button'}]},
  {name:'inherited-editability', html:'<section contenteditable="true">' + '<div>Editable child</div>'.repeat(220) + '</section><button>Beyond pool</button>' + '<i></i>'.repeat(300), queries:[{by:'role',value:'button',name:'Missing'}, {by:'role',value:'button'}, {by:'role',value:'box',exact:false}]},
  {name:'implicit-role-family', html:'<header>Banner</header><main><header>Nested header</header><form aria-label="Form"><input type="search" aria-label="Search"><select multiple aria-label="Multi"><option>One</option></select></form><h2>Heading</h2><nav>Nav</nav></main><footer>Footer</footer><span role="switch checkbox">Explicit</span>' + '<i></i>'.repeat(300), queries:[{by:'role',value:'box',exact:false}, {by:'role',value:'banner'}, {by:'role',value:'contentinfo'}, {by:'role',value:'heading'}, {by:'role',value:'navigation'}, {by:'role',value:'switch'}]},
];
let generation = 1;
try {
  for (const fixture of fixtures) {
    for (const query of fixture.queries) {
      const results = [];
      for (const source of sources) {
        await page.goto('about:blank');
        await page.setContent('<!doctype html><title>Differential</title><body>' + fixture.html);
        if (fixture.shadow) await page.evaluate(() => { document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<button id="nested">Nested</button>' + '<i></i>'.repeat(300) + '<button>Nested last</button>'; });
        const raw = await page.evaluate(source.build(query, generation));
        results.push(JSON.parse(raw));
      }
      check(fixture.name + ' ' + JSON.stringify(query), JSON.stringify(results[0]) === JSON.stringify(results[1]), {before:results[0],after:results[1]});
      generation += 1;
    }
  }
  await page.goto('about:blank');
  await page.setContent('<!doctype html><body>' + fixtures[0].html);
  for (const query of [{by:'css',value:'#target'},{by:'role',value:'button',name:'Last'},{by:'role',value:'button',name:'Missing'}]) {
    for(let i=0;i<25;i++) for(const index of (i%2 ? [1,0] : [0,1])) {
      const script=sources[index].build(query, generation++);
      const ms=await page.evaluate(script => { const start=performance.now(); (0,eval)(script); return performance.now()-start; },script);
      if(i>=5)timings.push({query,index,ms});
    }
  }
} catch(error) {check('suite completed',false,String(error));}
finally {await browser.close();}
const report = {timestamp:new Date().toISOString(), engine:'headless Chrome, paired page script only, not MCP',referenceWalk:arg('reference-walk') === 'true',sources:sources.map(s=>s.hash),checks,timings};
await writeFile(output, JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
