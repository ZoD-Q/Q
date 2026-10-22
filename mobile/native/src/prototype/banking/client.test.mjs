import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real bank and plugin request wrappers; replace only native transport/session I/O.
const fixtureKey = '__q_banking_client_fixture';
const fixture = { transport: () => assert.fail('Unexpected request'), removed: [] };
globalThis[fixtureKey] = fixture;
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/plugin-host/client.ts')) {
    if (specifier === 'expo/fetch') return { url: moduleUrl(`export const fetch=(...args)=>globalThis.${fixtureKey}.transport(...args);`), shortCircuit: true };
    if (specifier === '../../services/api') return { url: moduleUrl('export const API_URL="https://bank-fixture.invalid";'), shortCircuit: true };
    if (specifier === '../../services/session-store') return { url: moduleUrl(`export async function removeToken(token){globalThis.${fixtureKey}.removed.push(token);}`), shortCircuit: true };
  }
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { fetchBankWallet, connectBanks, fetchBankTransactions, fetchBankEntries, bankingError } = await import('./client.ts');
const { pluginRequest } = await import('../plugin-host/client.ts');
const { WorkbenchError } = await import('../api-workbench/core.ts');
test.after(() => { resolver.deregister(); delete globalThis[fixtureKey]; });
test.beforeEach(() => { fixture.removed = []; fixture.transport = () => assert.fail('Unexpected request'); });
const zh = value => value;
const en = (_zh, value) => value;
const token = 'synthetic-test-session';

test('bank collection 404 and 501 mean unavailable support, with one request and no sign-out', async () => {
  const actions = [
    [() => fetchBankWallet(token), '/v1/banking/wallet', 'GET'],
    [() => connectBanks(token, ['hsbc']), '/v1/banking/connect', 'POST'],
    [() => fetchBankTransactions(token), '/v1/banking/transactions?limit=20', 'GET'],
    [() => fetchBankEntries(token), '/v1/banking/entries?limit=30', 'GET'],
  ];
  for (const status of [404, 501]) for (const [run, path, method] of actions) {
    let calls = 0;
    fixture.transport = async (url, options) => {
      calls++; assert.equal(new URL(url).pathname + new URL(url).search, path); assert.equal(options.method, method);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      if (method === 'POST') assert.deepEqual(JSON.parse(options.body), { bank_ids: ['hsbc'] });
      return new Response('<html>PRIVATE_ERROR_BODY</html>', { status });
    };
    await assert.rejects(run(), error => error.code === 'BANKING_UNAVAILABLE' && error.status === status
      && bankingError(error, zh).includes('当前服务暂不提供银行插件') && !bankingError(error, en).includes('PRIVATE_ERROR_BODY'));
    assert.equal(calls, 1);
    assert.deepEqual(fixture.removed, []);
  }
});

test('missing individual connections and named bank errors are not labelled unsupported service', async () => {
  fixture.transport = async () => new Response('', { status: 404 });
  await assert.rejects(pluginRequest(token, '/v1/plugins/connections/missing', value => value), error => {
    assert.equal(error.status, 404); assert.equal(error.code, 'REQUEST_FAILED');
    assert.match(bankingError(error, zh), /银行记录或连接/);
    assert.doesNotMatch(bankingError(error, zh), /暂不提供银行插件/);
    return true;
  });
  fixture.transport = async () => Response.json({ error: { code: 'BANK_ACCOUNT_UNAVAILABLE' } }, { status: 404 });
  await assert.rejects(fetchBankWallet(token), error => error.code === 'BANK_ACCOUNT_UNAVAILABLE'
    && bankingError(error, zh) === '请先添加收款银行插件。');
  assert.deepEqual(fixture.removed, []);
});

test('only an actual HTTP 401 clears the matching session; other failures remain distinct', async () => {
  fixture.transport = async () => new Response('', { status: 401 });
  await assert.rejects(fetchBankWallet(token), error => error.code === 'UNAUTHORIZED' && error.status === 401
    && bankingError(error, zh).includes('重新登录'));
  assert.deepEqual(fixture.removed, [token]);
  fixture.removed = [];
  fixture.transport = async () => Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 503 });
  await assert.rejects(fetchBankWallet(token), error => error.status === 503 && bankingError(error, zh).includes('服务暂时不可用'));
  fixture.transport = async () => new Response('rate limit', { status: 429 });
  await assert.rejects(fetchBankWallet(token), error => error.status === 429 && bankingError(error, zh).includes('操作较频繁'));
  fixture.transport = async () => { throw new TypeError('PRIVATE_NETWORK_DETAIL'); };
  await assert.rejects(fetchBankWallet(token), error => error.code === 'NETWORK_ERROR' && bankingError(error, zh).includes('检查网络'));
  fixture.transport = async () => Response.json({ accounts: [] });
  await assert.rejects(fetchBankWallet(token), error => error.code === 'INVALID_RESPONSE' && bankingError(error, zh).includes('无法识别钱包数据'));
  assert.deepEqual(fixture.removed, []);
});

test('timeout, cancellation and shape messages preserve uncertainty without developer-facing guidance', () => {
  for (const [code, expected] of [['REQUEST_TIMEOUT', /超时/], ['CANCELLED', /停止等待/], ['INVALID_RESPONSE', /无法识别钱包数据/]]) {
    const error = new WorkbenchError(code);
    assert.match(bankingError(error, zh), expected);
    assert.match(bankingError(error, zh), /查询状态/);
    assert.doesNotMatch(bankingError(error, zh), /后端|版本/);
    assert.doesNotMatch(bankingError(error, en), /backend|version|PRIVATE/);
  }
  assert.match(bankingError(new WorkbenchError('REQUEST_FAILED', 403), zh), /无法访问/);
  assert.doesNotMatch(bankingError(new Error('PRIVATE_DETAIL'), zh), /PRIVATE_DETAIL/);
});

test('a valid empty wallet still loads normally without fabricating accounts or balances', async () => {
  const wallet = { mode: 'demo', currency: 'HKD', accounts: [], total_balance_minor: 0, recipients: [{ id: 'demo_chen', display_name: '陈小明', demo: true }] };
  fixture.transport = async () => Response.json(wallet);
  assert.deepEqual(await fetchBankWallet(token), wallet);
  assert.deepEqual(fixture.removed, []);
});
