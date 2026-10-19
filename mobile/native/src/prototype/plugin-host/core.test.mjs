import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Expo resolves extensionless TS imports; match that one boundary in Node's test runner.
const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='../api-workbench/core' && context.parentURL?.endsWith('/plugin-host/core.ts')) return next(specifier+'.ts',context);
  return next(specifier,context);
}});
const {decodeResourceImage,decodeResult,decodeInvocation,parseArguments,publicHttps,pluginError}=await import('./core.ts');
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
