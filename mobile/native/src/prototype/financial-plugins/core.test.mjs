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
const connection = provider => ({ id, revision: 1, title: 'Official service', name: 'service', description: '', version: '1', card_url: 'https://example.com/', endpoint_url: 'https://example.com/mcp', connection_kind: 'remote_mcp', builtin_service_id: null, financial_provider_id: provider, owner_name: null, status: 'auth_required', auth_status: 'required', pending_update: false, last_error_code: null, created_at: '2026-11-02', updated_at: '2026-11-02' });
const catalog = () => ({ available: true, credentials_configured: true, oauth_configured: true, providers: Object.entries(FINANCIAL_PROVIDERS).map(([id,p]) => ({ id, name:p.name, description:p.description[0], homepage_url:p.home, auth_mode:p.auth, connection:connection(id) })) });
test('catalog validates all six providers and binds connections without introducing a new connection kind', () => {
  const value=decodeFinancialCatalog(catalog()); assert.equal(value.providers.length,6);
  assert.equal(value.providers[0].connection.connection_kind,'remote_mcp');
  assert.throws(()=>decodeFinancialConnection(connection('ifind'),'jin10'));
  assert.throws(()=>decodeFinancialConnection({...connection('ifind'),financial_provider_id:['ifind']},'ifind'));
  for (const mutate of [c=>c.providers.push(c.providers[0]), c=>c.providers[0].id='unknown', c=>c.providers[0].auth_mode='none', c=>c.providers[0].homepage_url='https://attacker.example/mcp',c=>delete c.providers[0].connection]) {
    const c=catalog(); mutate(c); assert.throws(()=>decodeFinancialCatalog(c));
  }
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
  assert.match(financialError(new WorkbenchError('REQUEST_FAILED',404),(_,en)=>en),/does not provide/);
  assert.doesNotMatch(financialError(new Error('sensitive key abc'),(_,en)=>en),/sensitive|abc/);
});
