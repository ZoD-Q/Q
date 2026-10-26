import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { argumentRows, bankReadPresentation, isConversationalText, invocationActionTitle, visibleValue } = await import('./presentation.ts');
const { decodeInvocation } = await import('./core.ts');
resolver.deregister();
const text = (zh, en) => zh;
const id = '11111111-1111-4111-8111-111111111111';
const invocation = { id, connection_id: id, connection_revision: 1, connection_title: '汇丰', card_url: 'urn:q:bank-demo:hsbc', endpoint_url: 'urn:q:bank-demo:hsbc', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc', tool_name: 'bank_balance', arguments: {}, status: 'succeeded', result: { content: [], structuredContent: { kind: 'bank_balance', mode: 'demo', currency: 'HKD', bank_id: 'hsbc', balance_minor: 12345 } }, error_code: null, created_at: '2026-10-26', updated_at: '2026-10-26', expires_at: '2026-10-27' };

test('chat preserves readable text and excludes transport JSON and standalone endpoints', () => {
  for (const value of ['{"balance":10}', '[{"x":1}]', '```json\n{"x":1}\n```', 'https://service.test/mcp', 'urn:q:bank-demo:hsbc', 'ui://view', '']) assert.equal(isConversationalText(value), false, value);
  for (const value of ['账户余额为 HK$123.45。', 'A normal answer.', 'The result is {available}.']) assert.equal(isConversationalText(value), true, value);
});
test('saved argument schema provides labels while nested values remain complete and read-only', () => {
  const rows = argumentRows({ recipient: { name: '陈小明', addresses: ['香港', '上海'] }, amount_minor: 12345, notify: false }, { properties: { recipient: { title: '收款人', properties: { name: { title: '姓名' }, addresses: { title: '地址' } } }, amount_minor: { title: '金额（分）' }, notify: { title: '通知' } } }, text);
  assert.deepEqual(rows, [{ label: '收款人', value: '姓名: 陈小明\n地址: 1. 香港\n2. 上海' }, { label: '金额（分）', value: '12345' }, { label: '通知', value: '否' }]);
  assert.deepEqual(argumentRows({}, null, text), []);
  assert.equal(invocationActionTitle(invocation, text), '确认这项操作');
  assert.equal(invocationActionTitle({ ...invocation, tool_title: '预订门票' }, text), '预订门票');
});
test('bank read presentation validates immutable bank identity and actual result without leaking identifiers', () => {
  const result = bankReadPresentation(invocation, text);
  assert.match(result.title, /余额/); assert.match(result.lines[0], /123\.45/);
  for (const value of [{ ...invocation, connection_kind: 'remote_mcp' }, { ...invocation, result: { ...invocation.result, structuredContent: { ...invocation.result.structuredContent, bank_id: 'bochk' } } }, { ...invocation, result: { ...invocation.result, structuredContent: { ...invocation.result.structuredContent, balance_minor: -1 } } }]) assert.equal(bankReadPresentation(value, text), null);
  const transactions = { ...invocation, tool_name: 'bank_transactions', result: { content: [], structuredContent: { kind: 'bank_transactions', mode: 'demo', currency: 'HKD', bank_id: 'hsbc', items: [] } } };
  assert.deepEqual(bankReadPresentation(transactions, text).lines, ['暂无交易记录']);
});
test('optional saved tool metadata accepts old responses and rejects malformed new fields', () => {
  assert.equal(decodeInvocation(invocation).tool_title, undefined);
  assert.deepEqual(decodeInvocation({ ...invocation, tool_title: '查询余额', input_schema: { properties: {} } }).input_schema, { properties: {} });
  for (const extra of [{ tool_title: {} }, { input_schema: [] }, { input_schema: 'json' }]) assert.throws(() => decodeInvocation({ ...invocation, ...extra }), { code: 'INVALID_RESPONSE' });
});


test('confirmation preserves zero, false, empty, null, URLs and control characters without invisible direction changes', () => {
  const args = { zero: 0, no: false, empty: '', nothing: null, upload_url: 'https://files.test/target', nested: { unknown_key: ['a', 0, false, null, ''] }, deceptive: 'pay\u202e123\n' };
  const rows = argumentRows(args, null, text);
  assert.equal(rows.length, Object.keys(args).length);
  assert.equal(rows[0].value, '0'); assert.equal(rows[1].value, '否'); assert.equal(rows[2].value, '空文本'); assert.equal(rows[3].value, '空值');
  assert.equal(rows[4].value, 'https://files.test/target');
  assert.match(rows[5].value, /unknown key: 1. a\n2. 0\n3. 否\n4. 空值\n5. 空文本/);
  assert.equal(rows[6].value, 'pay\\u202e123\\u000a');
  assert.equal(visibleValue('a\u2066b\u2069'), 'a\\u2066b\\u2069');
});
