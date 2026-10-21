import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Expo resolves extensionless TS imports; match that one boundary in Node's test runner.
const hook=registerHooks({resolve(specifier,context,next){
  if(['../api-workbench/core','../plugin-workbench/materials','../banking/catalog'].includes(specifier) && context.parentURL?.endsWith('/plugin-host/core.ts')) return next(specifier+'.ts',context);
  return next(specifier,context);
}});
const {decodeResourceImage,decodeResult,decodeInvocation,decodePluginConnection,decodeDiscovery,parseArguments,publicHttps,pluginOrigin,connectionStatusLabel,authorizationLabel,pluginEntryIntentReducer,initialPluginEntryState,pluginAuthModalReducer,canPresentPluginConnectionPage,pluginError}=await import('./core.ts');
hook.deregister();
test('raster decoding refuses HTML, SVG, external URLs and oversized blobs',()=>{
  const make=(mimeType,blob)=>({contents:[{mimeType,blob}]});
  assert.equal(decodeResourceImage(make('image/jpeg','aGVsbG8=')),'data:image/jpeg;base64,aGVsbG8=');
  for(const input of [make('text/html','aGVsbG8='),make('image/svg+xml','aGVsbG8='),make('image/png','https://evil.test/image'),make('image/png','a'.repeat(1400001)),{contents:[]}]) assert.throws(()=>decodeResourceImage(input),{code:'INVALID_RESPONSE'});
});
test('plugin HTML is inert text while image resource links keep attribution metadata',()=>{
  const result=decodeResult({content:[{type:'resource_link',uri:'beauty://photos/1',name:'1',description:'Title / Author / CC BY / Source',mimeType:'image/jpeg'},{type:'resource',resource:{mimeType:'text/html',text:'<script>sideEffect()</script>'}}]});
  assert.equal(result.content[0].description,'Title / Author / CC BY / Source');
  assert.equal(result.content[1].type,'text');
  assert.match(result.content[1].text,/<script>/);
});
test('unknown invocation outcomes remain distinct and invalid statuses fail closed',()=>{
  const input={id:'11111111-1111-4111-8111-111111111111',connection_id:'22222222-2222-4222-8222-222222222222',connection_revision:1,connection_title:'Gallery',card_url:'https://example.test/card',endpoint_url:'https://example.test/mcp',tool_name:'browse',arguments:{},status:'unknown',result:null,error_code:null,created_at:'2026-10-19',updated_at:'2026-10-19',expires_at:'2026-10-19'};
  assert.equal(decodeInvocation(input).status,'unknown');
  assert.throws(()=>decodeInvocation({...input,status:'repeat_now'}),{code:'INVALID_RESPONSE'});
});
test('argument editor accepts only bounded JSON objects and external links require HTTPS',()=>{
  assert.deepEqual(parseArguments('{"limit":3}'),{limit:3});
  for(const value of ['null','[]','invalid','"text"',' '.repeat(16001)]) assert.throws(()=>parseArguments(value),{code:'PLUGIN_ARGUMENTS_INVALID'});
  for(const value of ['javascript:alert(1)','file:///tmp/a','http://example.test','https://user:secret@example.test']) assert.equal(publicHttps(value),null);
  assert.equal(publicHttps('https://commons.wikimedia.org/wiki/File:A.jpg'),'https://commons.wikimedia.org/wiki/File:A.jpg');
});
test('remote plugin auth and Q identity expiration use different messages',()=>{
  const text=(zh,en)=>en;
  assert.match(pluginError('PLUGIN_AUTH_REQUIRED',text),/Q session is still valid/);
  assert.match(pluginError('UNAUTHORIZED',text),/session expired/);
});

test('connection, candidate and invocation owners accept legacy fields and ignore invalid claims',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const base={id,card_url:'https://example.test/card',endpoint_url:'https://example.test/mcp',name:'com.example/tool',title:'Tool',description:'Example',version:'1.0.0',revision:1,status:'ready',auth_status:'none',last_error_code:null,created_at:'2026-10-20',updated_at:'2026-10-20',pending_update:false};
  const invocation={...base,connection_id:id,connection_revision:1,connection_title:'Tool',tool_name:'example',arguments:{},status:'awaiting_confirmation',result:null,error_code:null,expires_at:'2026-10-20'};
  const candidate={...base,candidate_id:id};
  for(const owner_name of [undefined,null,{name:'someone'},'bad\u202e','x'.repeat(81),'']){
    assert.equal(decodePluginConnection({...base,owner_name}).owner_name,null);
    assert.equal(decodeInvocation({...invocation,owner_name}).owner_name,null);
    assert.equal(decodeDiscovery({discovery_id:id,expires_at:'2026-10-20',candidates:[{...candidate,owner_name}]}).candidates[0].owner_name,null);
  }
  assert.equal(decodePluginConnection({...base,owner_name:'  Studio Q  '}).owner_name,'Studio Q');
  const discovered=decodeDiscovery({discovery_id:id,expires_at:'2026-10-20',candidates:[{...candidate,owner_name:'Studio A'},{...candidate,candidate_id:'22222222-2222-4222-8222-222222222222',owner_name:'Studio B'}]});
  assert.deepEqual(discovered.candidates.map(item=>item.owner_name),['Studio A','Studio B']);
  assert.equal(decodeInvocation({...invocation,owner_name:'Original Studio'}).owner_name,'Original Studio');
});

test('source origins stay distinct from publisher claims and states have readable labels',()=>{
  assert.equal(pluginOrigin('https://service.example:8443/Card?x=1'),'https://service.example:8443');
  assert.equal(pluginOrigin('https://name:pass@example.test/private'),null);
  assert.equal(pluginOrigin('javascript:alert(1)'),null);
  const zh=(value)=>value;
  assert.equal(connectionStatusLabel('needs_review',zh),'有更新待确认');
  assert.equal(authorizationLabel('none',zh),'无需单独授权');
  assert.doesNotMatch(pluginError('INVALID_RESPONSE',zh),/INVALID_RESPONSE/);
  assert.match(pluginError('REQUEST_TIMEOUT',zh),/不要重复执行/);
});

test('handoff preserves explicit domain semantics and initialization only prefills the form',t=>{
  const requests=t.mock.method(globalThis,'fetch',()=>{throw new Error('Unexpected automatic discovery or mutation');});
  const intent=Object.freeze({entry:'https://example.com/',kind:'domain'});
  const pending=pluginEntryIntentReducer(null,{type:'received',intent});
  assert.equal(pending,intent);
  assert.deepEqual(initialPluginEntryState(pending),{entry:'https://example.com/',kind:'domain',adding:true,advanced:true});
  assert.deepEqual(initialPluginEntryState(null),{entry:'',kind:'auto',adding:false,advanced:false});
  const auto={entry:'https://example.com/specific/Card/?tag=b&tag=a',kind:'auto'};
  assert.deepEqual(initialPluginEntryState(auto),{...auto,adding:true,advanced:false});
  assert.equal(pending,intent,'presenting the form does not acknowledge or mutate the pending intent');
  assert.equal(requests.mock.callCount(),0,'presenting a pending link must not discover, add, or authorize automatically');
});

test('an expired session and re-login preserve pending input until discovery or explicit dismissal',()=>{
  const intent=Object.freeze({entry:'https://example.com/',kind:'domain'});
  let pending=pluginEntryIntentReducer(null,{type:'received',intent});
  const firstMount=initialPluginEntryState(pending);
  pending=pluginEntryIntentReducer(pending,{type:'session',authenticated:false});
  assert.equal(pending,intent,'401/unmount is not a successful discovery or a user dismissal');
  pending=pluginEntryIntentReducer(pending,{type:'session',authenticated:true});
  assert.deepEqual(initialPluginEntryState(pending),firstMount,'re-login restores both the original URL and explicit kind');
  assert.equal(pluginEntryIntentReducer(pending,{type:'settled',intent,outcome:'discovered'}),null);
  assert.equal(pluginEntryIntentReducer(pending,{type:'settled',intent,outcome:'dismissed'}),null);
  const replacement={entry:intent.entry,kind:'auto'};
  pending=pluginEntryIntentReducer(pending,{type:'received',intent:replacement});
  assert.equal(pluginEntryIntentReducer(pending,{type:'settled',intent,outcome:'discovered'}),replacement,'a stale outcome with another explicit kind cannot consume the newer intent');
  const another={entry:'https://other.example/card',kind:'card'};
  pending=pluginEntryIntentReducer(pending,{type:'received',intent:another});
  assert.equal(pluginEntryIntentReducer(pending,{type:'settled',intent:replacement,outcome:'dismissed'}),another);
});

test('iOS sign-in waits for native dismissal before presenting a pending plugin link',t=>{
  const requests=t.mock.method(globalThis,'fetch',()=>{throw new Error('Unexpected automatic plugin request');});
  const intent=Object.freeze({entry:'https://example.com/',kind:'domain'});
  const pending=pluginEntryIntentReducer(null,{type:'received',intent});
  let authModalPending=pluginAuthModalReducer(false,'requested');
  let state={platform:'ios',authenticated:false,authOpen:true,authModalPending};
  assert.equal(canPresentPluginConnectionPage(state),false);
  authModalPending=pluginAuthModalReducer(authModalPending,'shown');
  state={...state,authenticated:true,authOpen:false,authModalPending};
  assert.equal(canPresentPluginConnectionPage(state),false,'session success and visible=false precede native dismissal');
  authModalPending=pluginAuthModalReducer(authModalPending,'dismissed');
  assert.equal(canPresentPluginConnectionPage({...state,authModalPending}),true);
  assert.deepEqual(initialPluginEntryState(pending),{entry:intent.entry,kind:'domain',adding:true,advanced:true});
  assert.equal(pending,intent,'the modal handoff never consumes the pending connection intent');
  assert.equal(requests.mock.callCount(),0,'dismissal only enables the form, never discovery, adding, or authorization');
});

test('cancelled and failed sign-ins can reopen without releasing a plugin modal early',()=>{
  let authModalPending=false;
  const state={platform:'ios',authenticated:false,authOpen:true};
  for(let attempt=0;attempt<3;attempt++){
    authModalPending=pluginAuthModalReducer(authModalPending,'requested');
    authModalPending=pluginAuthModalReducer(authModalPending,'shown');
    assert.equal(canPresentPluginConnectionPage({...state,authModalPending}),false,'failed login keeps its existing form active');
    assert.equal(canPresentPluginConnectionPage({...state,authOpen:false,authModalPending}),false,'cancel without a session cannot present a plugin page');
    authModalPending=pluginAuthModalReducer(authModalPending,'dismissed');
    assert.equal(canPresentPluginConnectionPage({...state,authOpen:false,authModalPending}),false);
  }
  authModalPending=pluginAuthModalReducer(authModalPending,'requested');
  assert.equal(canPresentPluginConnectionPage({...state,authenticated:true,authOpen:false,authModalPending}),false);
  authModalPending=pluginAuthModalReducer(authModalPending,'dismissed');
  assert.equal(canPresentPluginConnectionPage({...state,authenticated:true,authOpen:false,authModalPending}),true);
});

test('restored sessions need no dismissal and non-iOS platforms do not wait for an iOS-only event',()=>{
  assert.equal(canPresentPluginConnectionPage({platform:'ios',authenticated:true,authOpen:false,authModalPending:false}),true);
  for(const platform of ['android','web']){
    assert.equal(canPresentPluginConnectionPage({platform,authenticated:true,authOpen:false,authModalPending:true}),true);
    assert.equal(canPresentPluginConnectionPage({platform,authenticated:true,authOpen:true,authModalPending:true}),false);
    assert.equal(canPresentPluginConnectionPage({platform,authenticated:false,authOpen:false,authModalPending:false}),false);
  }
});
