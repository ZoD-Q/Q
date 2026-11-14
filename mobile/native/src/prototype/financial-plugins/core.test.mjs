import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { FINANCIAL_PROVIDERS, decodeFinancialCatalog, decodeFinancialConnection, decodeFinancialAuthorization, decodeAuthorizationAttempt, financialError } = await import('./core.ts');
const { WorkbenchError } = await import('../api-workbench/core.ts');
test.after(() => resolver.deregister());
const id='11111111-1111-4111-8111-111111111111';
const connection = provider => ({ id, revision: 1, title: 'Official service', name: 'service', description: '', version: '1', card_url: 'https://example.com/', endpoint_url: 'https://example.com/mcp', connection_kind: 'remote_mcp', builtin_service_id: null, financial_provider_id: ['tavily','fred'].includes(provider) ? null : provider, ...(['tavily','fred'].includes(provider) ? {research_provider_id:provider} : {}), owner_name: null, status: 'auth_required', auth_status: 'required', pending_update: false, last_error_code: null, created_at: '2026-11-02', updated_at: '2026-11-02' });
const catalog = () => ({ available: true, credentials_configured: true, oauth_configured: true, providers: Object.entries(FINANCIAL_PROVIDERS).map(([id,p]) => ({ id, name:p.name, description:p.description[0], homepage_url:p.home, auth_mode:p.auth, connection:connection(id) })) });
test('catalog accepts version-two research profiles and the old six-provider response', () => {
  const value=decodeFinancialCatalog(catalog()); assert.equal(value.providers.length,8);
  const old = catalog(); old.providers = old.providers.slice(0,6);
  assert.equal(decodeFinancialCatalog(old).providers.length,6);
  assert.equal(value.providers[0].connection.connection_kind,'remote_mcp');
  assert.throws(()=>decodeFinancialConnection(connection('ifind'),'jin10'));
  assert.throws(()=>decodeFinancialConnection({...connection('ifind'),financial_provider_id:['ifind']},'ifind'));
  for (const mutate of [c=>c.providers.push(c.providers[0]), c=>c.providers[0].id='unknown', c=>c.providers[0].auth_mode='none', c=>c.providers[0].homepage_url='https://attacker.example/mcp',c=>delete c.providers[0].connection]) {
    const c=catalog(); mutate(c); assert.throws(()=>decodeFinancialCatalog(c));
  }
});
test('research identity cannot impersonate a financial or bank connection', () => {
  assert.equal(decodeFinancialConnection(connection('fred'),'fred').financial_provider_id,null);
  assert.equal(decodeFinancialConnection(connection('tavily'),'tavily').research_provider_id,'tavily');
  for(const patch of [{financial_provider_id:'ifind'}, {research_provider_id:['fred']}, {research_provider_id:'unknown'}, {research_provider_id:null}, {connection_kind:'bank_demo'}]) {
    assert.throws(()=>decodeFinancialConnection({...connection('fred'),...patch},'fred'));
  }
  assert.throws(()=>decodeFinancialConnection(connection('tavily'),'fred'));
  const a=decodeFinancialAuthorization({attempt_id:id,authorization_url:'https://mcp.stlouisfed.org/authorize?state=x&code_challenge=y'},'fred',id);
  assert.equal(a.provider,'fred');
  assert.throws(()=>decodeFinancialAuthorization({attempt_id:id,authorization_url:'https://fred.stlouisfed.org/authorize?state=x&code_challenge=y'},'fred',id));
});
test('OAuth browser targets require the selected provider origin and required flow parameters', () => {
  const value={attempt_id:id,authorization_url:'https://auth.massive.com/oauth2/auth?state=random&code_challenge=pkce'};
  const a=decodeFinancialAuthorization(value,'massive',id);assert.equal(a.connectionId,id);
  for(const url of ['http://auth.massive.com/?state=x&code_challenge=y','https://attacker.test/?state=x&code_challenge=y','https://auth.massive.com/?state=x','https://user:secret@auth.massive.com/?state=x&code_challenge=y']) assert.throws(()=>decodeFinancialAuthorization({...value,authorization_url:url},'massive',id));
  assert.throws(()=>decodeFinancialAuthorization(value,'ifind',id));
  assert.equal(decodeAuthorizationAttempt({id,connection_id:id,status:'succeeded'},a),true);
  assert.throws(()=>decodeAuthorizationAttempt({id,connection_id:'other',status:'succeeded'},a));
  assert.throws(()=>decodeAuthorizationAttempt({id,connection_id:id,status:'pending'},a),e=>e.code==='PLUGIN_AUTH_PENDING');
});
test('safe errors never render an arbitrary upstream message or key',()=>{
  assert.match(financialError(new WorkbenchError('REQUEST_FAILED',404),(_,en)=>en,'catalog'),/does not provide/);
  assert.doesNotMatch(financialError(new Error('sensitive key abc'),(_,en)=>en),/sensitive|abc/);
});


test('connection and authorization 404s do not imply an unsupported server', () => {
 for(const locale of ['zh','en']){
  const translate=(zh,en)=>locale==='zh'?zh:en;
  for(const scope of ['connection','catalog']) assert.match(financialError(new WorkbenchError('PLUGIN_NOT_FOUND',404),translate,scope),locale==='zh'?/连接不存在或已断开/:/connection no longer exists/);
  assert.match(financialError(new WorkbenchError('NOT_FOUND',404),translate),locale==='zh'?/连接或授权记录/:/connection or authorization record/);
  assert.match(financialError(new WorkbenchError('NOT_FOUND',404),translate,'catalog'),locale==='zh'?/服务器尚未提供/:/server does not provide/);
 }
});
test('Tavily access extensions are explicit, provider bound and never accept anonymous personal readiness', () => {
 const input=catalog(), tavily=input.providers.find(p=>p.id==='tavily');
 tavily.access_modes=[{id:'shared',auth_mode:'none'},{id:'personal',auth_mode:'api_key'}];tavily.connection_access_mode='personal';
 assert.equal(decodeFinancialCatalog(input).providers.find(p=>p.id==='tavily').connection_access_mode,'personal');
 for(const mutate of [p=>delete p.access_modes,p=>delete p.connection_access_mode,p=>p.access_modes[1].auth_mode='none',p=>p.access_modes.push(p.access_modes[0]),p=>p.connection_access_mode='other',p=>p.connection.auth_status='anonymous',p=>p.connection.status='ready',p=>p.connection=null]){
  const bad=structuredClone(input);mutate(bad.providers.find(p=>p.id==='tavily'));assert.throws(()=>decodeFinancialCatalog(bad));
 }
 const foreign=structuredClone(input);Object.assign(foreign.providers[0],{access_modes:tavily.access_modes,connection_access_mode:'personal'});assert.throws(()=>decodeFinancialCatalog(foreign));
 tavily.connection=null;tavily.connection_access_mode=null;assert.equal(decodeFinancialCatalog(input).providers.find(p=>p.id==='tavily').connection,null);
 const old=decodeFinancialCatalog(catalog()).providers.find(p=>p.id==='tavily');assert.equal(old.access_modes,undefined);assert.equal(old.auth_mode,'none');
});
