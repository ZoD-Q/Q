import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const controllers = await import('./controller.ts');
const validation = await import('./validation.ts');
test.after(() => resolver.deregister());
const tick = () => new Promise(resolve => setImmediate(resolve));
const owner = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const quoteId = '33333333-3333-4333-8333-333333333333';
const idA = '44444444-4444-4444-8444-444444444444';
const idB = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-11-02T00:00:00Z';
const orderA = { quote_id: quoteId, account_id: owner, channel: 'wechat', credit_currency: 'HKD', pay_currency: 'CNY', credit_amount_minor_hkd: 10000, base_amount_minor_cny: 9000, fee_minor_cny: 90, pay_amount_minor_cny: 9090, fee_basis_points: 100, rate_cny_per_100_hkd: '90', rate_source: 'Synthetic', rate_source_url: 'https://example.invalid/rate', rate_source_date: '2026-11-02', rate_at: stamp, rate_fetched_at: stamp, rate_evidence_sha256: 'a'.repeat(64), expires_at: stamp, server_time: stamp, rounding_policy: 'total_ceiling_minor_v1', payment_id: idA, client_request_id: key, status: 'confirming', checkout_url: null, checkout_expires_at: stamp, checkout_detached: false, terminal: false, safe_to_start_new: false, can_detach_checkout: false, poll_after_seconds: 60, created_at: stamp, updated_at: stamp, error_code: null, credited_transaction_id: null, evidence_version: 0 };
const orderB = { ...orderA, quote_id: idB, payment_id: idB, client_request_id: idB, status: 'expired', checkout_detached: true };

function walletView(client, journal, openCheckout = async () => {}) {
  const slots = []; let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const react = { useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }, useEffect(effect, deps) { const index = cursor++; const previous = slots[index]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; } }, useSyncExternalStore: (_subscribe, get) => get() };
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, View: 'View' }, 'expo-router/react-navigation': { useIsFocused: () => true }, 'expo/fetch': {}, 'expo-crypto': { randomUUID: () => assert.fail('detail cannot mint a key') }, 'expo-linking': { openURL: openCheckout }, 'lucide-react-native': {}, '../design': { useDesign: () => ({ text: zh => zh, colors: {}, phone: true }), ...Object.fromEntries(['Action', 'Divider', 'IconAction', 'Page', 'Type'].map(x => [x, x])) }, '../privacy': {}, '../../services/api': { API_URL: client.origin }, '../../services/session-store': { getSessionRevision: () => 1, subscribeSession: () => () => {} }, './client': { createPaymentClient: () => client }, './controller': controllers, './journal': { paymentJournal: () => journal }, './validation': validation, './ui': Object.fromEntries(['FundingFlow', 'PaymentDetail', 'PaymentOrders', 'WithdrawContact'].map(x => [x, x])) };
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL('./wallet-entry.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(output, { module, exports: module.exports, require: name => imports[name], URL, AbortController, setTimeout, clearTimeout, queueMicrotask });
  const entry = module.exports.PaymentWalletEntry({ token: 'fixture-token', ownerId: owner });
  const render = () => { cursor = 0; return entry.type(entry.props); };
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  return { render, nodes, getRuntime: () => slots.find(value => value?.controller && value?.refreshWallet) };
}

test('actual detail retry targets B while pending A recovery never blanks B or permits duplicate funding', async () => {
  const intent = { version: 1, origin: 'https://fixture.invalid', ownerId: owner, request: { quote_id: quoteId, client_request_id: key }, creditAmount: 10000, channel: 'wechat', possiblySent: true };
  let saved = intent; let clears = 0; let quoteCalls = 0; let failedB = false; const gets = [];
  const journal = { read: async () => saved, save: async () => assert.fail('detail cannot persist new intents'), clear: async () => { clears++; saved = null; } };
  const client = { origin: intent.origin, capabilities: async () => ({ enabled: true, channels: [{ id: 'wechat', enabled: true }], server_time: stamp }), active: async () => orderA,
    byKey: async received => { assert.equal(received, key); return orderA; }, get: async id => { gets.push(id); if (id === idB && !failedB) { failedB = true; throw new validation.PaymentError('NETWORK_ERROR'); } return id === idB ? orderB : orderA; },
    orders: async () => ({ items: [orderB], next_cursor: null }), wallet: async () => ({ currency: 'HKD', balance_minor: 0, updated_at: stamp }), quote: async () => { quoteCalls++; assert.fail('pending A must block new quotes'); }, create: async () => assert.fail('detail must never create a payment') };
  const { render, nodes, getRuntime } = walletView(client, journal);
  const overview = render(); await tick();
  const runtime = getRuntime();
  try {
    assert.equal(runtime.controller.getSnapshot().order.payment_id, idA);
    nodes(overview).find(node => node.props?.label === '充值订单').props.onPress(); await tick();
    render().props.onSelect(orderB); await tick();
    let detail = render(); await tick(); detail = render();
    assert.equal(detail.type, 'PaymentDetail'); assert.equal(detail.props.order, null); assert.equal(detail.props.error, 'NETWORK_ERROR');
    detail.props.onRefresh(); await tick(); detail = render();
    assert.equal(detail.props.order?.payment_id, idB, 'retry must recover the selected historical order B');
    assert.deepEqual(gets, [idB, idB]);
    await runtime.controller.refresh(); detail = render();
    assert.equal(detail.props.order?.payment_id, idB, 'primary pending A recovery must not replace the visible detail B');
    assert.equal(runtime.controller.getSnapshot().pending.request.client_request_id, key);
    assert.equal(saved, intent); assert.equal(clears, 0);
    await runtime.controller.quote('100', 'wechat');
    assert.equal(runtime.controller.getSnapshot().error, 'PAYMENT_OPERATION_PENDING'); assert.equal(quoteCalls, 0);
  } finally { runtime.dispose(); }
});

test('detail reads fence late selections, background responses and identity changes', async () => {
  const waits = []; const signals = []; let current = true;
  const details = controllers.createPaymentDetailController({ ownerId: owner, isCurrent: () => current, canDetach: () => false,
    client: { get: (_id, signal) => { signals.push(signal); return new Promise(resolve => waits.push(resolve)); } },
  });
  try {
    details.select(idA); assert.equal(waits.length, 0);
    details.setActive(true); assert.equal(waits.length, 1);
    details.select(idB); assert.equal(signals[0].aborted, true);
    waits[1](orderB); await tick(); assert.equal(details.getSnapshot().order.payment_id, idB);
    waits[0](orderA); await tick(); assert.equal(details.getSnapshot().order.payment_id, idB);
    const pending = details.refresh(); details.setActive(false); assert.equal(signals[2].aborted, true);
    waits[2]({ ...orderB, status: 'failed' }); await pending;
    assert.equal(details.getSnapshot().order.status, 'expired');
    details.setActive(true); current = false; waits[3]({ ...orderB, status: 'failed' }); await tick();
    assert.equal(details.getSnapshot().order.status, 'expired');
  } finally { details.dispose(); }
});

test('detail checkout and uncertain detach use only B, never create or replay a supplier command', async () => {
  let gets = 0; let detaches = 0; const opened = [];
  const payableB = { ...orderB, status: 'awaiting_payment', checkout_detached: false, can_detach_checkout: true, checkout_url: 'https://api.payqixiang.cn/pay/B', server_time: new Date().toISOString(), checkout_expires_at: new Date(Date.now() + 60_000).toISOString() };
  const details = controllers.createPaymentDetailController({ ownerId: owner, isCurrent: () => true, canDetach: () => true,
    client: { get: async id => { assert.equal(id, idB); gets++; return payableB; }, detach: async id => { assert.equal(id, idB); detaches++; throw new validation.PaymentError('REQUEST_TIMEOUT'); }, create: () => assert.fail('detail must not create a payment') },
  });
  try {
    details.select(idB); details.setActive(true); await tick();
    await details.openCheckout(async url => { opened.push(url); }); assert.deepEqual(opened, [payableB.checkout_url]);
    await details.detach(); assert.equal(details.getSnapshot().error, 'REQUEST_TIMEOUT'); assert.equal(detaches, 1);
    await details.refresh(); assert.equal(gets, 3); assert.equal(detaches, 1);
    details.setActive(false); await details.openCheckout(async () => assert.fail('background cannot open checkout'));
  } finally { details.dispose(); }
});

test('actual wallet disconnect and synchronous reconnect release detail busy without publishing stale responses', async () => {
  const module = { exports: {} };
  const output = ts.transpileModule(readFileSync(new URL('./wallet-entry.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(output, { module, exports: module.exports, require: name => name === './controller' ? controllers : name === './validation' ? validation : {}, URL, AbortController, setTimeout, clearTimeout, queueMicrotask });
  const waits = []; const signals = [];
  const runtime = module.exports.createPaymentWalletSession({ token: 'fixture-session', ownerId: owner,
    store: { getRevision: () => 1, subscribe: () => () => {} }, newId: () => assert.fail('reconnect cannot create an intent'),
    journal: { read: async () => null, save: async () => assert.fail('detail cannot write a journal'), clear: async () => assert.fail('detail cannot clear a journal') },
    makeClient: () => ({ get: (id, signal) => { assert.equal(id, idB); signals.push(signal); return new Promise(resolve => waits.push(resolve)); } }), onWallet: () => {},
  });
  let publications = 0;
  runtime.details.subscribe(() => publications++);
  try {
    runtime.connect(); runtime.details.select(idB); runtime.details.setActive(true);
    assert.equal(runtime.details.getSnapshot().busy, true); const before = publications;
    runtime.disconnect();
    assert.equal(signals[0].aborted, true); assert.equal(publications, before, 'disconnected identity must not publish cancellation');
    assert.equal(runtime.details.getSnapshot().busy, false, 'cancellation must release internal busy even while publication is fenced');
    runtime.connect(); runtime.details.setActive(true);
    assert.equal(waits.length, 2, 'same-generation reconnect must restart the selected detail read');
    waits[0]({ ...orderB, status: 'failed' }); await tick();
    assert.equal(runtime.details.getSnapshot().order, null); assert.equal(runtime.details.getSnapshot().busy, true, 'old response cannot release the new request');
    waits[1](orderB); await tick();
    assert.equal(runtime.details.getSnapshot().order.payment_id, idB); assert.equal(runtime.details.getSnapshot().order.status, 'expired'); assert.equal(runtime.details.getSnapshot().busy, false);
  } finally { runtime.dispose(); }
});

test('actual detail detachment aborts primary old reads and funding cannot reopen until fresh resume evidence', async () => {
  const stamp = new Date().toISOString();
  const payable = { ...orderA, status: 'awaiting_payment', can_detach_checkout: true, checkout_url: 'https://api.payqixiang.cn/pay/A', server_time: stamp, checkout_expires_at: new Date(Date.now() + 600_000).toISOString() };
  const detached = { ...payable, checkout_detached: true, can_detach_checkout: false, checkout_url: null, safe_to_start_new: true };
  const intent = { version: 1, origin: 'https://fixture.invalid', ownerId: owner, request: { quote_id: quoteId, client_request_id: key }, creditAmount: 10000, channel: 'wechat', possiblySent: true };
  let saved = intent; let remoteDetached = false; let oldRead = false; let holdResume = true; let releaseOld; let oldSignal; const resumed = []; const opened = [];
  const journal = { read: async () => saved, save: async () => assert.fail('no new intent'), clear: async () => { saved = null; } };
  const client = { origin: intent.origin, capabilities: async () => ({ enabled: true, channels: [{ id: 'wechat', enabled: true }], checkout_detach_supported: true, server_time: stamp }), wallet: async () => ({ currency: 'HKD', balance_minor: 0, updated_at: stamp }), orders: async () => ({ items: [payable], next_cursor: null }), active: async () => payable,
    byKey: async (received, signal) => { assert.equal(received, key); if (oldRead) { oldRead = false; oldSignal = signal; return new Promise(resolve => { releaseOld = resolve; }); } if (remoteDetached && holdResume) return new Promise(resolve => resumed.push(resolve)); return remoteDetached ? detached : payable; },
    get: async received => { assert.equal(received, idA); return remoteDetached ? detached : payable; }, detach: async received => { assert.equal(received, idA); remoteDetached = true; return { payment: detached, active_payment: null, can_start_new_checkout: true }; }, create: async () => assert.fail('no supplier creation') };
  const { render, nodes, getRuntime } = walletView(client, journal, async url => { opened.push(url); });
  const overview = render(); await tick(); await tick(); const runtime = getRuntime();
  try {
    nodes(overview).find(node => node.props?.label === '充值订单').props.onPress(); await tick();
    const orders = render(); oldRead = true; const pendingRead = runtime.controller.refresh();
    orders.props.onSelect(payable); render(); await tick();
    assert.equal(oldSignal.aborted, true, 'entering the detail must abort primary recovery');
    const detail = render(); detail.props.onDetach(); await tick();
    assert.equal(runtime.details.getSnapshot().order.checkout_detached, true); assert.equal(saved, intent, 'detaching detail must not clear the primary journal before recovery');
    releaseOld(payable); await pendingRead;
    await runtime.controller.openCheckout(async url => { opened.push(url); }); assert.deepEqual(opened, []);
    detail.props.onBack(); render(); await tick();
    await runtime.controller.openCheckout(async url => { opened.push(url); }); assert.deepEqual(opened, [], 'resume cannot hand off cached awaiting-payment before its fresh read');
    holdResume = false; for (let i = 0; i < 4; i++) { resumed.splice(0).forEach(resolve => resolve(detached)); await tick(); }
    assert.equal(runtime.controller.getSnapshot().order.checkout_detached, true);
    render().props.onBack(); const wallet = render();
    nodes(wallet).find(node => node.props?.label === '充值').props.onPress(); const funding = render(); await tick();
    funding.props.onOpenCheckout(); await tick(); assert.deepEqual(opened, []);
    assert.equal(runtime.controller.getSnapshot().order, null, 'starting a new draft must discard the detached cached checkout');
  } finally { runtime.dispose(); }
});

test('detail handoff rechecks cached order and refuses an uncertain refresh or completed detachment', async () => {
  let fail = false; let detached = false; const opened = [];
  const payable = { ...orderB, status: 'awaiting_payment', checkout_detached: false, checkout_url: 'https://api.payqixiang.cn/pay/B', server_time: new Date().toISOString(), checkout_expires_at: new Date(Date.now() + 600_000).toISOString() };
  const details = controllers.createPaymentDetailController({ ownerId: owner, isCurrent: () => true, canDetach: () => false, client: { get: async () => { if (fail) throw new validation.PaymentError('NETWORK_ERROR'); return detached ? { ...payable, checkout_detached: true, checkout_url: null } : payable; } } });
  try {
    details.select(idB); details.setActive(true); await tick(); fail = true;
    await details.refresh(); await details.openCheckout(async url => opened.push(url)); assert.deepEqual(opened, []);
    fail = false; detached = true; await details.openCheckout(async url => opened.push(url)); assert.deepEqual(opened, []);
  } finally { details.dispose(); }
});

for (const from of ['overview', 'detail']) for (const outcome of ['success', 'failure']) test(`actual ${from}-to-orders navigation preserves delayed history ${outcome}`, async () => {
  let settle; let signal; let delayNext = from === 'overview';
  const client = { origin: 'https://fixture.invalid', capabilities: async () => ({ enabled: false, channels: [], server_time: stamp }), wallet: async () => ({ currency: 'HKD', balance_minor: 0, updated_at: stamp }), active: async () => null, get: async () => orderB,
    orders: async (_view, _cursor, input) => { if (!delayNext) return { items: [orderB], next_cursor: null }; signal = input; return new Promise((resolve, reject) => { settle = () => outcome === 'success' ? resolve({ items: [orderB], next_cursor: null }) : reject(new validation.PaymentError('PAYMENTS_UNAVAILABLE', 404)); }); } };
  const journal = { read: async () => null, save: async () => assert.fail('read-only navigation'), clear: async () => assert.fail('read-only navigation') };
  const { render, nodes, getRuntime } = walletView(client, journal);
  const overview = render(); await tick(); await tick(); const runtime = getRuntime();
  try {
    if (from === 'detail') {
      nodes(overview).find(node => node.props?.label === '充值订单').props.onPress(); await tick();
      render().props.onSelect(orderB); render(); await tick();
      delayNext = true; render().props.onOrders();
    } else nodes(overview).find(node => node.props?.label === '充值订单').props.onPress();
    const orders = render();
    assert.equal(orders.type, 'PaymentOrders'); assert.equal(signal.aborted, false, 'committing the orders page must not cancel its new history read');
    settle(); await tick(); const state = render().props.state;
    assert.equal(state.busy, false);
    if (outcome === 'success') { assert.equal(state.items.length, 1); assert.equal(state.items[0].payment_id, idB); assert.equal(state.error, ''); }
    else { assert.equal(state.items.length, 0); assert.equal(state.error, 'PAYMENT_HISTORY_UNAVAILABLE', 'failed read must publish its error rather than appear as an empty history'); }
  } finally { runtime.dispose(); }
});
