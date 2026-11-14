import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const core=await import('./fred-core.ts'), provider=await import('./core.ts'), workbench=await import('../api-workbench/core.ts');
test.after(()=>resolver.deregister());
const source=ts.transpileModule(readFileSync(new URL('./fred-panel.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const tool={name:'fred-search-series',description:'Search data',inputSchema:{type:'object',properties:{search_text:{type:'string'}},required:['search_text']}};
const catalog={connection_revision:2,retention:'ephemeral',items:[tool]};
const reply={connection_id:'connection',connection_revision:2,tool_name:tool.name,retention:'ephemeral',retrieved_at:'2026-11-08T00:00:00Z',result:{structuredContent:{title:'PRIVATE TEMPORARY RESULT',observations:[{date:'2026-01-01',value:'.'}]}}};
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
function harness({override}={}){
 let slots=[],cursor=0,effects=[],dirty=true,tree,mounted=true,writes=0,background,backs=0;const calls=[];let props={token:'owner-a',connection:{id:'connection',revision:2},active:true,onBack:()=>backs++};
 const appState={currentState:'active',addEventListener(_,cb){background=cb;return{remove(){}};}};
 const react={useState(initial){const i=cursor++;slots[i]??={value:initial};return[slots[i].value,value=>{if(!mounted)writes++;slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true;}];},useRef(initial){return slots[cursor++]??={current:initial};},useEffect(cb,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j])){const old=slots[i]?.cleanup;slots[i]={deps};effects.push(()=>{old?.();slots[i].cleanup=cb();});}}};react.useLayoutEffect=react.useEffect;
 const jsx=(type,props)=>({type,props});const imports={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{View:'View',AppState:appState,ActivityIndicator:'Spinner',Linking:{openURL:async()=>{}}},'lucide-react-native':{ArrowLeft:'Back'},'../design':{...Object.fromEntries(['Page','Action','Choice','Input','Type'].map(x=>[x,x])),useDesign:()=>({colors:{},locale:'en',text:(_,en)=>en})},'../api-workbench/core':workbench,'./core':provider,'./fred-core':core,'../plugin-host/client':{pluginRequest:async(token,path,decode,options)=>{const call={token,path,...options};calls.push(call);return decode(await override?.(call)??(path.endsWith('/tools')?catalog:reply));}}};
 const module={exports:{}};runInNewContext(source,{module,exports:module.exports,AbortController,require:name=>{assert.ok(name in imports,name);return imports[name];}});
 function nodes(node,result=[]){if(Array.isArray(node))node.forEach(n=>nodes(n,result));else if(node&&typeof node==='object'){result.push(node);nodes(node.props?.children,result);nodes(node.props?.action,result);}return result;}
 function render(patch={}){props={...props,...patch};dirty=true;let count=0;while(dirty){assert.ok(count++<15);dirty=false;cursor=0;tree=module.exports.FredResearchPanel(props);effects.splice(0).forEach(e=>e());}return nodes(tree);}
 function press(label){const node=render().find(n=>n.type==='Action'&&n.props.label===label);assert.ok(node,label);assert.equal(Boolean(node.props.disabled),false);node.props.onPress();render();}
 return{calls,render,press,get writes(){return writes;},get backs(){return backs;},text(){return render().filter(n=>n.type==='Type').flatMap(n=>n.props.children).join(' ');},enter(value){render().find(n=>n.type==='Input').props.onChangeText(value);render();},async flush(){for(let i=0;i<35;i++){await Promise.resolve();if(mounted)render();}},background(){appState.currentState='background';background('background');render();},unmount(){mounted=false;slots.forEach(s=>s.cleanup?.());}};
}
async function query(h){h.render();h.press('Load query options');await h.flush();h.enter('private query');h.press('Query FRED');await h.flush();}
test('FRED query requires explicit action and never uses ordinary invocation or history endpoints',async()=>{
 const h=harness();h.render();assert.equal(h.calls.length,0);assert.match(h.text(),/does not cache/);await query(h);assert.match(h.text(),/PRIVATE TEMPORARY RESULT/);assert.equal(h.calls.length,2);assert.ok(h.calls.every(c=>/\/fred\/(tools|query)$/.test(c.path)));assert.deepEqual(h.calls[1].body.arguments,{search_text:'private query'});assert.ok(h.render().filter(n=>n.type==='Type').every(n=>!n.props.selectable));
});
test('background, leave, account and revision transitions discard inputs and results',async()=>{
 for(const mode of ['background','inactive','account','revision','back']){const h=harness();await query(h);if(mode==='background')h.background();if(mode==='inactive')h.render({active:false});if(mode==='account')h.render({token:'owner-b'});if(mode==='revision')h.render({connection:{id:'connection',revision:3}});if(mode==='back')h.press('Back to FRED');assert.doesNotMatch(h.text(),/PRIVATE TEMPORARY RESULT/);assert.ok(!h.render().some(n=>n.type==='Input'));assert.equal(h.calls.length,2);}
});
test('late query responses cannot republish after account change or unmount',async()=>{
 for(const mode of ['account','unmount']){const pending=deferred();const h=harness({override:c=>c.path.endsWith('/query')?pending.promise:undefined});h.render();h.press('Load query options');await h.flush();h.enter('private query');h.press('Query FRED');const req=h.calls[1];if(mode==='account')h.render({token:'owner-b'});else h.unmount();assert.equal(req.signal.aborted,true);pending.resolve(reply);await h.flush();if(mode!=='unmount')assert.doesNotMatch(h.text(),/PRIVATE TEMPORARY RESULT/);assert.equal(h.writes,0);}
});
test('unsupported form or invalid required input cannot send a query',async()=>{
 const h=harness({override:async c=>c.path.endsWith('/tools')?{...catalog,items:[{...tool,inputSchema:{type:'object',properties:{nested:{type:'object'}},required:['nested']}}]}:undefined});h.render();h.press('Load query options');await h.flush();assert.equal(h.render().find(n=>n.props.label==='Query FRED').props.disabled,true);assert.equal(h.calls.length,1);
 const simple=harness();simple.render();simple.press('Load query options');await simple.flush();simple.press('Query FRED');assert.equal(simple.calls.length,1);assert.match(simple.text(),/Check required fields/);
});


test('deleted FRED connection clears temporary inputs and offers connection recovery',async()=>{
 const h=harness({override:async c=>{if(c.path.endsWith('/query'))throw new workbench.WorkbenchError('PLUGIN_NOT_FOUND',404);}});await query(h);assert.match(h.text(),/connection no longer exists/);assert.doesNotMatch(h.text(),/server does not provide|PRIVATE TEMPORARY RESULT/);assert.equal(h.render().some(n=>n.type==='Input'),false);h.press('Back to FRED');assert.equal(h.backs,1);
});
