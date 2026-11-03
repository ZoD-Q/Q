import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerHooks } from 'node:module';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const validation = await import('./validation.ts'); test.after(() => resolver.deregister());
const jsx = (type, props) => ({ type, props }); const noop = () => {};
const design = { useDesign: () => ({ text: zh => zh, colors: {}, phone: true }), ...Object.fromEntries(['Action', 'Choice', 'Divider', 'IconAction', 'Input', 'Page', 'Row', 'Sheet', 'Tabs', 'Type'].map(value => [value, value])) };
const module = { exports: {} };
const source = readFileSync(new URL('./ui.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const imports = { react: { useState: initial => [typeof initial === 'function' ? initial() : initial, noop], useEffect: noop }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View' }, 'expo-linking': {}, 'lucide-react-native': {}, '../design': design, './validation': validation };
runInNewContext(output, { exports: module.exports, module, require: name => imports[name] });
function nodes(value, result = []) { if (Array.isArray(value)) value.forEach(item => nodes(item, result)); else if (value && typeof value === 'object') { result.push(value); if (typeof value.type === 'function') nodes(value.type(value.props), result); else if (value.type !== 'Sheet' || value.props.visible) nodes(value.props?.children, result); } return result; }
function detail(patch) {
  const order = { status: 'failed', error_code: 'not_created', terminal: true, evidence_version: 0, credited_transaction_id: null, checkout_url: null, safe_to_start_new: true, checkout_detached: false, can_detach_checkout: false, credit_amount_minor_hkd: 10000, pay_amount_minor_cny: 9090, payment_id: 'synthetic-order', created_at: '2026-11-02T00:00:00Z', ...patch };
  return nodes(module.exports.PaymentDetail({ order, busy: false, onRefresh: noop, onOpenCheckout: noop, onDetach: noop, onBack: noop }));
}
test('detail names quoted CNY payable rather than claiming the amount was paid', () => {
  const tree = detail({}); assert.ok(tree.some(node => node.props.label === '订单应付（CNY）'));
  assert.ok(!tree.some(node => node.props.label === '实际支付（CNY）'));
});
test('not-submitted/no-debit wording requires complete authoritative terminal proof', () => {
  const proven = detail({}); assert.ok(proven.some(node => node.props.children === '未提交付款'));
  assert.ok(proven.some(node => typeof node.props.children === 'string' && node.props.children.includes('没有扣款')));
  for (const patch of [{ error_code: null }, { terminal: false }, { evidence_version: 1 }, { credited_transaction_id: 'any-transaction' }, { checkout_url: 'https://api.payqixiang.cn/pay' }, { status: 'review_required' }, { status: 'confirming' }]) {
    const tree = detail(patch);
    assert.ok(!tree.some(node => node.props.children === '未提交付款'));
    assert.ok(!tree.some(node => typeof node.props.children === 'string' && node.props.children.includes('没有扣款')));
  }
  const occupiedSlot = detail({ safe_to_start_new: false });
  assert.ok(occupiedSlot.some(node => node.props.children === '未提交付款'));
  assert.ok(occupiedSlot.some(node => typeof node.props.children === 'string' && node.props.children.includes('其他充值订单仍需单独查询')));
});
test('quote read errors before any intent explain that no new order exists, without confusing pending payments', () => {
  const flow = patch => nodes(module.exports.FundingFlow({ state: { phase: 'amount', capabilities: { enabled: true, channels: [{ id: 'wechat', enabled: true }], min_credit_amount_minor_hkd: 1, max_credit_amount_minor_hkd: 100000 }, pending: null, order: null, quote: null, busy: false, retryAt: null, serverOffset: 0, error: 'NETWORK_ERROR', ...patch }, amount: '100', channel: 'wechat', onAmountChange: noop, onChannelChange: noop, onQuote: noop, onConfirm: noop, onRefresh: noop, onOpenCheckout: noop, onDetach: noop, onOrders: noop, onBack: noop }));
  for (const error of ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE']) {
    const strings = flow({ error }).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []);
    assert.ok(strings.includes('未能取得可用报价，尚未创建新的充值订单。请稍后重试。'));
    assert.ok(!strings.some(value => value.includes('不要重复付款') || value.includes('查询原充值')));
  }
  for (const patch of [{ error: 'UNAUTHORIZED' }, { error: 'RATE_LIMITED' }, { phase: 'result' }, { pending: { request: {} } }]) {
    const strings = flow(patch).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []);
    assert.ok(!strings.some(value => value.includes('尚未创建新的充值订单')));
  }
});

test('failed order reads never claim an empty history, and still offer explicit retry', () => {
  for (const view of ['pending', 'history']) {
    let retried = 0;
    const render = error => nodes(module.exports.PaymentOrders({ state: { view, items: [], cursor: null, busy: false, error }, onView: noop, onRefresh: () => { retried++; }, onMore: noop, onSelect: noop, onBack: noop }));
    const failed = render('PAYMENT_HISTORY_UNAVAILABLE');
    assert.ok(!failed.some(node => node.props.children === '暂无充值订单'), 'an unavailable list is not evidence of no orders');
    assert.ok(failed.some(node => typeof node.props.children === 'string' && node.props.children.includes('暂时无法读取充值订单')));
    failed.find(node => node.props.label === '刷新订单').props.onPress();
    assert.equal(retried, 1);
    const empty = render('');
    assert.ok(empty.some(node => node.props.children === '暂无充值订单'), 'a successful empty response may show the empty state');
  }
});
