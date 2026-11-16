import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const core=await import('./core.ts'), plugin=await import('../plugin-host/core.ts'), workbench=await import('../api-workbench/core.ts');
test.after(()=>resolver.deregister());
const source=ts.transpileModule(readFileSync(new URL('./page.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const id='11111111-1111-4111-8111-111111111111', attemptId='22222222-2222-4222-8222-222222222222';
const saved=(provider,ready=false)=>({id,revision:1,title:'Provider',name:provider,description:'Public provider',version:'1',card_url:core.FINANCIAL_PROVIDERS[provider].home,endpoint_url:'https://service.example/mcp',connection_kind:'remote_mcp',builtin_service_id:null,financial_provider_id:['fred','tavily'].includes(provider)?null:provider,research_provider_id:['fred','tavily'].includes(provider)?provider:null,status:ready?'ready':'auth_required',auth_status:ready?'authorized':'required',pending_update:false,last_error_code:null,created_at:'2026-11-02',updated_at:'2026-11-02'});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
function harness({override,initial={},configured=true,legacy=false,initialProviderId,tavilyModes=false}={}){
 let slots=[],cursor=0,effects=[],dirty=true,tree,mounted=true,writesAfterUnmount=0,owner='owner-a',active=true;const calls=[],selected=[],opened=[],reviewed=[],connections={...initial};let background;
 const appState={currentState:'active',addEventListener(_,cb){background=cb;return{remove(){}};}};
 const react={
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{if(!mounted)writesAfterUnmount++;slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true;}];},
  useRef(initial){return slots[cursor++]??={current:initial};},
  useEffect(cb,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j])){const old=slots[i]?.cleanup;slots[i]={deps};effects.push(()=>{old?.();slots[i].cleanup=cb();});}},
 };
 react.useLayoutEffect=react.useEffect;
 const jsx=(type,props)=>({type,props});
 const design={...Object.fromEntries(['Action','Choice','Input','Page','Row','Sheet','Type'].map(name=>[name,name])),useDesign:()=>({colors:{},text:(_,en)=>en})};
 const catalog=()=>({available:true,credentials_configured:configured,oauth_configured:configured,providers:Object.entries(core.FINANCIAL_PROVIDERS).filter(([id])=>!legacy||!['fred','tavily'].includes(id)).map(([id,p])=>({id,name:p.name,description:p.description[1],homepage_url:p.home,auth_mode:p.auth,connection:connections[id]??null,...(id==='tavily'&&tavilyModes?{access_modes:[{id:'shared',auth_mode:'none'},{id:'personal',auth_mode:'api_key'}],connection_access_mode:connections[id]?connections[id].testMode??'shared':null}:{})}))});
 const imports={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{ActivityIndicator:'Spinner',AppState:appState,View:'View',Pressable:'Pressable',Linking:{openURL:async url=>opened.push(url)}},'lucide-react-native':{ArrowLeft:'Back',ChartNoAxesCombined:'Chart',RefreshCw:'Refresh'},'../design':design,'../api-workbench/core':workbench,'../plugin-host/core':plugin,'./core':core,'./fred-panel':{FredResearchPanel:'FredResearchPanel'},
 '../plugin-host/client':{pluginRequest:async(token,path,decode,options={})=>{
  const call={token,path,...options};calls.push(call);
  const external=await override?.(call);if(external!==undefined)return decode(external);
  let value;
  if(path==='/v1/plugins/financial/providers?catalog_version=2')value=catalog();
  else if(path==='/v1/plugins/financial/connections'){const provider=options.body.provider_id;value=connections[provider]={...saved(provider,['coingecko','tavily'].includes(provider)&&options.body.access_mode!=='personal'),...(provider==='tavily'?{testMode:options.body.access_mode??'shared'}:{})};}
  else if(path.endsWith('/credential')){const provider=connections.tavily?'tavily':'ifind';value=connections[provider]={...connections[provider],revision:2,status:'ready',auth_status:'authorized'};}
  else if(path.endsWith('/oauth/start'))value={attempt_id:attemptId,authorization_url:'https://auth.massive.com/oauth2/auth?state=fixture&code_challenge=fixture'};
  else if(path===`/v1/plugins/oauth/attempts/${attemptId}`){connections.massive={...connections.massive,status:'ready',auth_status:'authorized'};value={id:attemptId,connection_id:id,status:'succeeded'};}
  else if(path.endsWith('/tools'))value={items:[{name:'query',description:'Public query',inputSchema:{type:'object'}}]};
  else if(path===`/v1/plugins/connections/${id}`&&options.method==='DELETE'){for(const provider of Object.keys(connections))delete connections[provider];value=undefined;}
  else if(path===`/v1/plugins/connections/${id}`||path.endsWith('/refresh'))value=Object.values(connections)[0];
  else throw new Error(path);
  return decode(value);
 }}};
 const module={exports:{}};runInNewContext(source,{module,exports:module.exports,AbortController,URL,require:name=>{assert.ok(name in imports,name);return imports[name];}});
 function nodes(value,result=[]){if(Array.isArray(value))value.forEach(v=>nodes(v,result));else if(value&&typeof value==='object'){if(value.type==='Sheet'&&!value.props.visible)return result;result.push(value);nodes(value.props?.children,result);nodes(value.props?.action,result);}return result;}
 function render(){let loops=0;while(dirty){assert.ok(loops++<12);dirty=false;cursor=0;tree=module.exports.FinancialPluginCatalog({token:owner,active,initialProviderId,onSelect:value=>selected.push(value),onReviewConnection:value=>reviewed.push(value)});effects.splice(0).forEach(effect=>effect());}return nodes(tree);}
 function press(label){const node=render().find(n=>n.type==='Action'&&n.props.label===label);assert.ok(node,label);assert.equal(!!node.props.disabled,false,label);node.props.onPress();render();}
 return{calls,selected,opened,reviewed,connections,catalog,render,chooseMode(label){const node=render().find(n=>n.type==='Choice'&&n.props.label===label);assert.ok(node,label);assert.equal(Boolean(node.props.disabled),false);node.props.onPress();render();},press,get writesAfterUnmount(){return writesAfterUnmount;},
  async flush(){for(let i=0;i<40;i++){await Promise.resolve();render();}},
  choose(name){const row=render().find(n=>n.type==='Pressable'&&n.props.accessibilityLabel===name);assert.ok(row,name);assert.equal(Boolean(row.props.disabled),false);row.props.onPress();render();},
  enter(secret){const input=render().find(n=>n.type==='Input');assert.ok(input);input.props.onChangeText(secret);render();},
  text(){return render().filter(n=>n.type==='Type').flatMap(n=>n.props.children).join(' ');},
  closeKey(){render().find(n=>n.type==='Sheet'&&n.props.title==='Configure personal key').props.onClose();render();},
  background(){appState.currentState='background';background('background');render();},
  blur(){active=false;dirty=true;render();},
  changeOwner(next){owner=next;dirty=true;render();},
  unmount(){mounted=false;slots.forEach(s=>s.cleanup?.());},
 };
}
test('eight providers render without business queries; anonymous add and explicit chat selection use verified tools',async()=>{
 const h=harness();h.render();await h.flush();assert.equal(h.render().filter(n=>n.type==='Row').length,8);assert.equal(h.calls.length,1);
 h.choose('CoinGecko');h.press('Add financial plugin');await h.flush();
 assert.equal(h.calls.filter(c=>c.path.endsWith('/tools')).length,0);
 h.press('Use in chat');await h.flush();assert.equal(h.selected.length,1);assert.equal(h.selected[0].financial_provider_id,'coingecko');
 assert.equal(h.calls.some(c=>c.path.includes('invocation')),false);
});
test('recommended provider opens its existing authorization flow without adding or calling it automatically',async()=>{
 const h=harness({initialProviderId:'ifind'});h.render();await h.flush();
 assert.equal(h.render().find(n=>n.type==='Page').props.title,'iFinD');
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/v1/plugins/financial/providers?catalog_version=2');assert.equal(h.selected.length,0);
 assert.ok(h.render().some(n=>n.type==='Action'&&n.props.label==='Add financial plugin'));
 const invalid=harness({initialProviderId:'unrecognized-provider'});invalid.render();await invalid.flush();assert.equal(invalid.render().filter(n=>n.type==='Pressable').length,8);
});
test('personal keys stay masked and are cleared at submission, closing and background',async()=>{
 const h=harness({initial:{ifind:saved('ifind')}});h.render();await h.flush();h.choose('iFinD');h.press('Configure personal key');h.enter('fixture-key');
 const input=h.render().find(n=>n.type==='Input');assert.equal(input.props.secureTextEntry,true);assert.equal(input.props.autoComplete,'off');
 h.press('Save personal key');assert.equal(h.render().some(n=>n.type==='Input'),false);await h.flush();
 const post=h.calls.find(c=>c.path.endsWith('/credential'));assert.equal(post.body.secret,'fixture-key');assert.equal(h.selected.length,0);
 h.press('Replace personal key');assert.equal(h.render().find(n=>n.type==='Input').props.value,'');h.enter('another-fixture');h.closeKey();h.press('Replace personal key');assert.equal(h.render().find(n=>n.type==='Input').props.value,'');
 h.enter('background-fixture');h.background();assert.equal(h.render().some(n=>n.type==='Input'),false);
});
test('secure storage unavailable disables key entry and legacy servers explain update requirements',async()=>{
 const h=harness({initial:{ifind:saved('ifind')},configured:false});h.render();await h.flush();h.choose('iFinD');
 assert.equal(h.render().find(n=>n.props.label==='Configure personal key').props.disabled,true);
 const old=harness({override:async()=>{throw new workbench.WorkbenchError('NOT_FOUND',404);}});old.render();await old.flush();assert.ok(old.render().filter(n=>n.type==='Row').every(n=>n.props.subtitle.includes('Connection state not loaded')));old.choose('iFinD');
 assert.match(old.text(),/does not provide financial plugins/);assert.equal(old.render().find(n=>n.props.label==='Add financial plugin').props.disabled,true);
 old.press('Back to financial plugins');assert.match(old.text(),/does not provide financial plugins/);old.choose('Massive');assert.match(old.text(),/does not provide financial plugins/);assert.match(old.text(),/without saved temporary tables/);
});
test('OAuth only opens after an explicit browser action and checks the bound result before chat',async()=>{
 const h=harness({initial:{massive:saved('massive')}});h.render();await h.flush();h.choose('Massive');h.press('Connect provider account');await h.flush();assert.equal(h.opened.length,0);
 h.press('Authorize in browser');await h.flush();assert.equal(h.opened[0],'https://auth.massive.com/oauth2/auth?state=fixture&code_challenge=fixture');
 h.press('Check authorization result');await h.flush();assert.equal(h.selected.length,0);h.press('Use in chat');await h.flush();assert.equal(h.selected.length,1);
});
test('failed key save requires state recovery and never restores secret input',async()=>{
 const h=harness({initial:{ifind:saved('ifind')},override:async c=>{if(c.path.endsWith('/credential'))throw new workbench.WorkbenchError('REQUEST_TIMEOUT');}});h.render();await h.flush();h.choose('iFinD');h.press('Configure personal key');h.enter('test-key');h.press('Save personal key');await h.flush();
 assert.match(h.text(),/result is unconfirmed/);assert.equal(h.render().some(n=>n.type==='Input'),false);
 assert.equal(h.render().find(n=>n.props.label==='Configure personal key').props.disabled,true);
 h.press('Refresh connection state');await h.flush();h.press('Configure personal key');assert.equal(h.render().find(n=>n.type==='Input').props.value,'');
});
test('late responses cannot select chat or republish another owner’s connection',async()=>{
 for(const mode of ['background','unmount','account','blur']){
  const pending=deferred();const h=harness({initial:{coingecko:saved('coingecko',true)},override:c=>c.path.endsWith('/tools')?pending.promise:undefined});h.render();await h.flush();h.choose('CoinGecko');h.press('Use in chat');await h.flush();
  const call=h.calls.find(c=>c.path.endsWith('/tools'));assert.ok(call);
  if(mode==='background')h.background();else if(mode==='unmount')h.unmount();else if(mode==='blur')h.blur();else h.changeOwner('owner-b');
  assert.equal(call.signal.aborted,true);pending.resolve({items:[{name:'query',description:'data',inputSchema:{type:'object'}}]});await h.flush();assert.equal(h.selected.length,0);assert.equal(h.writesAfterUnmount,0);
 }
});
test('disconnect requires its own confirmation and clears only the chosen connection',async()=>{
 const h=harness({initial:{coingecko:saved('coingecko',true)}});h.render();await h.flush();h.choose('CoinGecko');h.press('Disconnect plugin');assert.equal(h.calls.some(c=>c.method==='DELETE'),false);h.press('Confirm disconnect');await h.flush();assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);assert.ok(h.render().some(n=>n.props.label==='Add financial plugin'));
});


test('route blur and account changes clear entered keys before a return or new request',async()=>{
 for(const mode of ['blur','account']){
  const h=harness({initial:{ifind:saved('ifind')}});h.render();await h.flush();h.choose('iFinD');h.press('Configure personal key');h.enter('discarded-fixture');
  if(mode==='blur')h.blur();else h.changeOwner('owner-b');
  assert.equal(h.render().some(n=>n.type==='Input'),false);await h.flush();assert.equal(h.calls.some(c=>c.path.endsWith('/credential')),false);
 }
});
test('a succeeded OAuth attempt cannot publish an unexpected connection or unapproved authorization',async()=>{
 for(const change of [{id:attemptId},{auth_status:'required'}]){
  const h=harness({initial:{massive:saved('massive')},override:async c=>c.path===`/v1/plugins/connections/${id}`?{...saved('massive',true),...change}:undefined});h.render();await h.flush();h.choose('Massive');h.press('Connect provider account');await h.flush();h.press('Check authorization result');await h.flush();
  assert.equal(h.selected.length,0);assert.doesNotMatch(h.text(),/Authorization completed/);
 }
});

test('new sources are unavailable on a legacy six-provider catalog without blocking original services',async()=>{
 const h=harness({legacy:true});h.render();await h.flush();h.choose('FRED');
 assert.match(h.text(),/has not enabled this source/);assert.equal(h.render().find(n=>n.props.label==='Add financial plugin').props.disabled,true);
 h.press('Back to financial plugins');h.choose('iFinD');assert.equal(h.render().find(n=>n.props.label==='Add financial plugin').props.disabled,false);
});
test('FRED enters its ephemeral page without calling ordinary plugin tools or chat',async()=>{
 const h=harness({initial:{fred:saved('fred',true)}});h.render();await h.flush();h.choose('FRED');
 assert.equal(h.render().some(n=>n.props.label==='Use in chat'),false);assert.match(h.text(),/does not cache queries/);
 h.press('Start temporary research');assert.ok(h.render().some(n=>n.type==='FredResearchPanel'));assert.equal(h.selected.length,0);assert.equal(h.calls.some(c=>c.path.endsWith('/tools')),false);
 h.background();assert.equal(h.render().some(n=>n.type==='FredResearchPanel'),false);
});

test('cancelling an uncertain addition requires recovery and never republishes the late response',async()=>{
 const pending=deferred();const h=harness({override:c=>c.path==='/v1/plugins/financial/connections'?pending.promise:undefined});h.render();await h.flush();h.choose('CoinGecko');h.press('Add financial plugin');await h.flush();const post=h.calls.find(c=>c.path==='/v1/plugins/financial/connections');h.press('Cancel operation');assert.equal(post.signal.aborted,true);assert.match(h.text(),/may have been saved or changed/);pending.resolve(saved('coingecko',true));await h.flush();assert.equal(h.render().some(n=>n.props.label==='Use in chat'),false);assert.equal(h.render().find(n=>n.props.label==='Add financial plugin').props.disabled,true);
});
test('authorized FRED connection can retry a temporary failure through the ephemeral page',async()=>{
 const h=harness({initial:{fred:{...saved('fred',true),status:'blocked',last_error_code:'MCP_NETWORK_ERROR'}}});h.render();await h.flush();h.choose('FRED');h.press('Start temporary research');assert.ok(h.render().some(n=>n.type==='FredResearchPanel'));assert.equal(h.calls.some(c=>c.path.endsWith('/refresh')),false);
});


test('deleted connections recover through catalog refresh without a false server upgrade message',async()=>{
 const h=harness({initial:{ifind:saved('ifind')},override:async c=>{if(c.path.endsWith('/credential'))throw new workbench.WorkbenchError('PLUGIN_NOT_FOUND',404);}});h.render();await h.flush();h.choose('iFinD');h.press('Configure personal key');h.enter('fixture');h.press('Save personal key');await h.flush();
 assert.match(h.text(),/connection no longer exists/);assert.doesNotMatch(h.text(),/server does not provide/);delete h.connections.ifind;h.press('Refresh connection state');await h.flush();assert.ok(h.render().some(n=>n.props.label==='Add financial plugin'));assert.equal(h.render().some(n=>n.type==='Input'),false);
});
test('pending updates open only the bound connection and never accept them automatically',async()=>{
 const h=harness({initial:{ifind:{...saved('ifind',true),pending_update:true}}});h.render();await h.flush();h.choose('iFinD');h.press('Review service update');assert.deepEqual(h.reviewed,[id]);assert.equal(h.calls.length,1);assert.equal(h.render().some(n=>n.props.label==='Use in chat'),false);
});
test('personal Tavily requires an explicit choice and a masked key before chat',async()=>{
 const h=harness({tavilyModes:true});h.render();await h.flush();h.choose('Tavily');h.chooseMode('Use my Tavily key');h.press('Add financial plugin');await h.flush();
 assert.equal(h.calls.find(c=>c.path==='/v1/plugins/financial/connections').body.access_mode,'personal');assert.match(h.text(),/Personal Tavily access/);assert.equal(h.render().some(n=>n.props.label==='Use in chat'),false);assert.equal(h.render().some(n=>n.type==='Choice'),false);
 h.press('Configure personal key');h.enter('private-test-key');assert.match(h.text(),/your own Tavily API key/);assert.equal(h.render().find(n=>n.type==='Input').props.secureTextEntry,true);h.press('Save personal key');assert.equal(h.render().some(n=>n.type==='Input'),false);await h.flush();h.press('Use in chat');await h.flush();assert.equal(h.selected.length,1);
});
test('old Tavily servers preserve the shared path without new choices or personal credentials',async()=>{
 const h=harness();h.render();await h.flush();h.choose('Tavily');assert.equal(h.render().some(n=>n.type==='Choice'),false);h.press('Add financial plugin');await h.flush();assert.equal(h.calls.find(c=>c.path==='/v1/plugins/financial/connections').body.access_mode,undefined);assert.equal(h.render().some(n=>n.props.label==='Configure personal key'),false);
});
test('Tavily mode changes require confirmed disconnect; failed personal additions never fall back',async()=>{
 const h=harness({tavilyModes:true,initial:{tavily:{...saved('tavily',true),testMode:'shared'}}});h.render();await h.flush();h.choose('Tavily');assert.equal(h.render().some(n=>n.type==='Choice'),false);h.press('Disconnect plugin');assert.equal(h.calls.some(c=>c.method==='DELETE'),false);h.press('Confirm disconnect');await h.flush();h.chooseMode('Use my Tavily key');h.press('Add financial plugin');await h.flush();assert.equal(h.calls.find(c=>c.path==='/v1/plugins/financial/connections').body.access_mode,'personal');
 for(const code of ['PLUGIN_ACCESS_MODE_CONFLICT','REQUEST_TIMEOUT']){
  const bad=harness({tavilyModes:true,override:async c=>{if(c.path==='/v1/plugins/financial/connections')throw new workbench.WorkbenchError(code,code==='PLUGIN_ACCESS_MODE_CONFLICT'?409:undefined);}});bad.render();await bad.flush();bad.choose('Tavily');bad.chooseMode('Use my Tavily key');bad.press('Add financial plugin');await bad.flush();assert.equal(bad.calls.filter(c=>c.path==='/v1/plugins/financial/connections').length,1);assert.equal(bad.render().find(n=>n.props.label==='Add financial plugin').props.disabled,true);assert.equal(bad.render().some(n=>n.props.label==='Use in chat'),false);
 }
});


test('Tavily refresh and chat rebind access mode in both directions without continuing on stale consent',async()=>{
 for(const start of ['shared','personal'])for(const action of ['Refresh service capabilities','Use in chat']){
  const next=start==='shared'?'personal':'shared';
  const make=(mode,revision)=>({...saved('tavily',true),revision,testMode:mode,auth_status:mode==='personal'?'authorized':'anonymous'});
  const h=harness({tavilyModes:true,initial:{tavily:make(start,1)}});h.render();await h.flush();h.choose('Tavily');h.connections.tavily=make(next,4);h.press(action);await h.flush();
  assert.match(h.text(),/access mode changed on another device/);assert.equal(h.selected.length,0);assert.ok(h.render().some(n=>n.type==='Type'&&n.props.children===(next==='personal'?'Personal Tavily access':'Shared access')));assert.equal(h.render().some(n=>n.props.label==='Replace personal key'),next==='personal');assert.equal(h.calls.some(c=>c.path.endsWith('/credential')),false);
  h.press('Use in chat');await h.flush();assert.equal(h.selected.length,1);assert.equal(h.selected[0].revision,4);assert.equal(h.selected[0].auth_status,next==='personal'?'authorized':'anonymous');
 }
});
test('Tavily rejects a revision change between connection and mode reads, then permits explicit recovery',async()=>{
 let changed=false;const h=harness({tavilyModes:true,initial:{tavily:{...saved('tavily',true),testMode:'personal'}},override:async c=>{
  if(!changed&&c.path===`/v1/plugins/connections/${id}`&&c.method==='GET'){changed=true;h.connections.tavily={...h.connections.tavily,revision:3};return{...h.connections.tavily,revision:2};}
 }});h.render();await h.flush();h.choose('Tavily');h.press('Use in chat');await h.flush();assert.equal(h.selected.length,0);assert.match(h.text(),/connection changed during this action/);h.press('Use in chat');await h.flush();assert.equal(h.selected.length,1);assert.equal(h.selected[0].revision,3);
});
test('late Tavily mode recovery cannot republish after cancel, account change or background',async()=>{
 for(const transition of ['cancel','account','background']){
  const pending=deferred();let reads=0;
  const h=harness({tavilyModes:true,initial:{tavily:{...saved('tavily',true),testMode:'shared'}},override:c=>{if(c.path.includes('/providers')&&++reads===2)return pending.promise;}});
  h.render();await h.flush();h.choose('Tavily');h.connections.tavily={...saved('tavily',true),revision:4,testMode:'personal'};const stale=structuredClone(h.catalog());h.press('Refresh service capabilities');await h.flush();const recovery=h.calls.filter(c=>c.path.includes('/providers'))[1];assert.ok(recovery);
  if(transition==='cancel')h.press('Cancel operation');if(transition==='background')h.background();if(transition==='account'){h.connections.tavily={...saved('tavily',true),revision:8,testMode:'shared',auth_status:'anonymous'};h.changeOwner('owner-b');await h.flush();}
  assert.equal(recovery.signal.aborted,true);pending.resolve(stale);await h.flush();assert.equal(h.selected.length,0);assert.equal(h.render().some(n=>n.type==='Type'&&n.props.children==='Personal Tavily access'),false);assert.equal(h.render().some(n=>n.props.label==='Replace personal key'),false);
 }
});
test('uncertain Tavily credential writes lock actions until catalog recovery without resubmitting the key',async()=>{
 let failRecovery=false;
 const h=harness({tavilyModes:true,initial:{tavily:{...saved('tavily'),testMode:'personal'}},override:async c=>{
  if(c.path.endsWith('/credential')){h.connections.tavily={...saved('tavily',true),testMode:'personal',revision:2};failRecovery=true;return h.connections.tavily;}
  if(c.path.includes('/providers')&&failRecovery)throw new workbench.WorkbenchError('REQUEST_TIMEOUT');
 }});h.render();await h.flush();h.choose('Tavily');h.press('Configure personal key');h.enter('private-fixture');h.press('Save personal key');await h.flush();assert.equal(h.render().some(n=>n.type==='Input'),false);assert.equal(h.render().find(n=>n.props.label==='Configure personal key').props.disabled,true);assert.equal(h.calls.filter(c=>c.path.endsWith('/credential')).length,1);
 failRecovery=false;h.press('Refresh connection state');await h.flush();assert.ok(h.render().some(n=>n.props.label==='Replace personal key'));assert.equal(h.calls.filter(c=>c.path.endsWith('/credential')).length,1);
});
