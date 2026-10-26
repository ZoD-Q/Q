import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('./core.ts'), presentation = await import('./presentation.ts'), workbench = await import('../api-workbench/core.ts');
const bankingResult = await import('../banking/result.ts'), bankingCore = await import('../banking/core.ts'), bankCatalog = await import('../banking/catalog.ts');
resolver.deregister();
const source = ts.transpileModule(readFileSync(new URL('./chat-invocation.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const id = '11111111-1111-4111-8111-111111111111';
const base = { id, connection_id: id, connection_revision: 1, connection_title: 'Tickets', card_url: 'https://service.test/card', endpoint_url: 'https://service.test/rpc', connection_kind: 'remote_mcp', builtin_service_id: null, tool_name: 'reserve_ticket', tool_title: '预订门票', input_schema: { properties: { count: { title: '张数' } } }, arguments: { count: 2 }, status: 'awaiting_confirmation', result: null, error_code: null, created_at: '2026-10-26', updated_at: '2026-10-26', expires_at: '2026-10-27' };
const all = (tree, result = []) => { if (Array.isArray(tree)) tree.forEach(value => all(value, result)); else if (tree && typeof tree === 'object') { result.push(tree); all(tree.props?.children, result); } return result; };
function harness(invocation = base, respond = async () => ({ ...base, status: 'succeeded', result: { content: [{ type: 'text', text: '已预订' }] } }), mediaOnly = false) {
  const slots = [], calls = [], resolved = [], effects = []; let cursor = 0, dirty = true, tree;
  const props = { invocation, token: 'token', mediaOnly, onChanged: value => { props.invocation = value; dirty = true; }, onResolved: value => resolved.push(value) };
  const react = { useState: initial => { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, value => { slots[index].value = value; dirty = true; }]; }, useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; }, useEffect: fn => { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(fn); } } };
  const jsx = (type, properties) => ({ type, props: properties });
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ActivityIndicator: 'Spinner', View: 'View' }, '../design': { Action: 'Action', Type: 'Type', useDesign: () => ({ colors: {}, text: zh => zh }) }, '../api-workbench/core': workbench, '../banking/proposal': { BankProposalView: 'BankProposalView' }, '../banking/result': bankingResult, '../banking/core': bankingCore, '../banking/catalog': bankCatalog, './core': core, './presentation': presentation, './result-view': { PluginResultView: 'PluginResultView' }, './client': { pluginRequest: async (token, path, decode, options) => { calls.push({ path, ...options }); return decode(await respond(calls.length)); } } };
  const module = { exports: {} }; runInNewContext(source, { module, exports: module.exports, AbortController, Error, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  const render = () => { if (dirty) { dirty = false; cursor = 0; tree = module.exports.ChatInvocationView(props); effects.splice(0).forEach(fn => fn()); } return tree; };
  render();
  return { calls, resolved, nodes: () => all(render()), press(label) { const button = all(render()).find(node => node.type === 'Action' && node.props.label === label); assert.ok(button, label); button.props.onPress(); }, async flush() { for (let n = 0; n < 20; n++) { await Promise.resolve(); render(); } }, set(value) { props.invocation = value; dirty = true; render(); }, setDisabled(value) { props.disabled = value; dirty = true; render(); } };
}
test('chat confirmation shows meaningful arguments but no RPC details and only executes after a deliberate press', async () => {
  const view = harness(); await view.flush(); assert.equal(view.calls.length, 0); assert.equal(view.resolved.length, 0);
  const text = view.nodes().filter(node => node.type === 'Type').map(node => node.props.children).join(' ');
  assert.match(text, /预订门票/); assert.match(text, /张数/); assert.match(text, /2/);
  assert.doesNotMatch(text, /reserve_ticket|https:|rpc|\{"|awaiting_confirmation/);
  view.press('确认'); view.press('确认'); await view.flush();
  assert.equal(view.calls.length, 1); assert.match(view.calls[0].path, /\/confirm$/); assert.equal(view.resolved.length, 1);
});
test('the host can block confirmation until the originating history is saved', async () => {
  const view = harness(); view.setDisabled(true);
  assert.equal(view.nodes().find(node => node.type === 'Action' && node.props.label === '确认').props.disabled, true);
  view.press('确认'); view.press('取消'); await view.flush(); assert.equal(view.calls.length, 0);
  view.setDisabled(false); view.press('确认'); await view.flush();
  assert.equal(view.calls.length, 1); assert.equal(view.resolved.length, 1);
});
test('unknown confirmation outcomes allow only querying the original invocation and resolve after a confirmed read', async () => {
  const view = harness(base, async count => { if (count === 1) throw new workbench.WorkbenchError('NETWORK_ERROR'); return { ...base, status: 'succeeded', result: { content: [{ type: 'text', text: '已完成' }] } }; });
  view.press('确认'); await view.flush(); assert.equal(view.resolved.length, 0);
  assert.equal(view.nodes().some(node => node.type === 'Action' && node.props.label === '确认'), false);
  view.press('查看进度'); await view.flush();
  assert.equal(view.calls.length, 2); assert.equal(view.calls[1].method, 'GET'); assert.equal(view.calls[1].path, `/v1/plugins/invocations/${id}`); assert.equal(view.resolved.length, 1);
});
test('historical results and media-only presentations never resume, confirm or duplicate text on mount', async () => {
  const completed = { ...base, status: 'succeeded', result: { content: [{ type: 'text', text: 'Already summarized' }] } };
  const full = harness(completed); await full.flush(); assert.equal(full.calls.length, 0); assert.equal(full.resolved.length, 0);
  const media = harness(completed, undefined, true); await media.flush();
  assert.equal(media.nodes().filter(node => node.type === 'Action').length, 0);
  assert.equal(media.nodes().filter(node => node.type === 'Type').length, 0);
  const result = media.nodes().find(node => node.type === 'PluginResultView'); assert.equal(result.props.mediaOnly, true); assert.equal(result.props.compact, true);
  assert.equal(media.calls.length, 0); assert.equal(media.resolved.length, 0);
});
test('cancel and incomplete status reads never continue the model', async () => {
  const view = harness(base, async () => ({ ...base, status: 'cancelled' })); view.press('取消'); await view.flush(); assert.equal(view.resolved.length, 0); assert.match(view.calls[0].path, /\/cancel$/);
  const waiting = harness({ ...base, status: 'unknown' }, async () => ({ ...base, status: 'running' })); waiting.press('查看进度'); await waiting.flush(); assert.equal(waiting.resolved.length, 0); assert.equal(waiting.calls[0].method, 'GET');
});

test('busy confirmation stays disabled and a refreshed old waiting record cannot repeat an uncertain confirmation', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const view = harness(base, () => pending);
  view.press('确认');
  assert.equal(view.nodes().find(node => node.type === 'Action' && node.props.label === '确认').props.disabled, true);
  view.press('确认'); assert.equal(view.calls.length, 1);
  finish({ ...base, status: 'unknown' }); await view.flush();
  assert.equal(view.resolved.length, 0);
  assert.equal(view.nodes().some(node => node.type === 'Action' && node.props.label === '确认'), false);
  const uncertain = harness(base, async count => { if (count === 1) throw new workbench.WorkbenchError('REQUEST_TIMEOUT'); return base; });
  uncertain.press('确认'); await uncertain.flush(); uncertain.press('查看进度'); await uncertain.flush();
  assert.equal(uncertain.calls.length, 2); assert.equal(uncertain.calls[1].method, 'GET');
  assert.equal(uncertain.nodes().some(node => node.type === 'Action' && node.props.label === '确认'), false);
});


test('consumed bank transfers retain a verified concise business receipt without controls or identifiers', async () => {
  const bank = { ...base, connection_title: '汇丰', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc', card_url: 'urn:q:bank-demo:hsbc', endpoint_url: 'urn:q:bank-demo:hsbc', tool_name: 'bank_transfer', arguments: { to_bank_id: 'bochk', recipient: 'demo_chen', amount_minor: 12345 }, status: 'succeeded', result: { isError: false, content: [], structuredContent: { kind: 'bank_transfer', id, source_bank_id: 'hsbc', destination_bank_id: 'bochk', recipient: 'demo_chen', amount_minor: 12345, currency: 'HKD', mode: 'demo', source_balance_minor: 100, destination_balance_minor: null, memo: '', created_at: '2026-10-26T12:00:00Z' } } };
  const receipt = harness(bank, undefined, true); await receipt.flush();
  const text = receipt.nodes().filter(node => node.type === 'Type').map(node => node.props.children).join(' ');
  assert.match(text, /123\.45/); assert.match(text, /陈小明/); assert.match(text, /模拟 HKD/);
  assert.doesNotMatch(text, /11111111|2026|bank_transfer/);
  assert.equal(receipt.nodes().filter(node => node.type === 'Action').length, 0);
  const mismatched = harness({ ...bank, result: { ...bank.result, structuredContent: { ...bank.result.structuredContent, amount_minor: 1 } } }, undefined, true);
  assert.equal(mismatched.nodes().filter(node => node.type === 'Type').length, 0, 'unverified receipts never claim a transfer completed');
  const failed = harness({ ...bank, status: 'tool_error', result: { isError: true, content: [], structuredContent: { kind: 'bank_error', mode: 'demo', error_code: 'INSUFFICIENT_FUNDS' } } }, undefined, true);
  assert.match(failed.nodes().filter(node => node.type === 'Type').map(node => node.props.children).join(' '), /模拟余额不足/);
  assert.equal(failed.calls.length, 0); assert.equal(failed.resolved.length, 0);
});
