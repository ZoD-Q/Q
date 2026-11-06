import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { amountMinor, money, decodeCapabilities, decodeQuote, decodeOrder, decodeWallet, decodeLedger, safeCheckout, PaymentError } = await import('./validation.ts');
const { createPaymentJournal } = await import('./journal-core.ts');
const { createFundingController, createPaymentDetailController } = await import('./controller.ts');
const { createPaymentClient } = await import('./client.ts');
test.after(() => resolver.deregister());
const owner = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const quoteId = '33333333-3333-4333-8333-333333333333';
const paymentId = '44444444-4444-4444-8444-444444444444';
const stamp = '2026-11-02T00:00:00Z';
const clock = Date.parse(stamp);
const caps = () => ({ enabled: true, unavailable_reason: null, channels: [{ id: 'wechat', enabled: true, unavailable_reason: null }, { id: 'alipay', enabled: false, unavailable_reason: null }], credit_currency: 'HKD', pay_currency: 'CNY', min_credit_amount_minor_hkd: 100, max_credit_amount_minor_hkd: 100000, fee_basis_points: 100, quote_ttl_seconds: 60, checkout_detach_supported: true, payment_history_supported: true, independent_orders_supported: false, approval_mode: 'governance_maker_checker_v1', server_time: stamp });
const quote = () => ({ quote_id: quoteId, account_id: owner, channel: 'wechat', credit_currency: 'HKD', pay_currency: 'CNY', credit_amount_minor_hkd: 10000, base_amount_minor_cny: 9000, fee_minor_cny: 90, pay_amount_minor_cny: 9090, fee_basis_points: 100, rate_cny_per_100_hkd: '90', rate_source: 'Synthetic test source', rate_source_url: 'https://example.invalid/rate', rate_source_date: '2026-11-02', rate_at: stamp, rate_fetched_at: stamp, rate_evidence_sha256: 'a'.repeat(64), expires_at: '2026-11-02T00:01:00Z', server_time: stamp, rounding_policy: 'total_ceiling_minor_v1' });
const order = (patch = {}) => ({ ...quote(), payment_id: paymentId, client_request_id: key, status: 'creating', checkout_url: null, checkout_expires_at: '2026-11-02T00:30:00Z', checkout_detached: false, terminal: false, safe_to_start_new: false, can_detach_checkout: false, poll_after_seconds: 1, created_at: stamp, updated_at: stamp, error_code: null, credited_transaction_id: null, evidence_version: 0, ...patch });
const pending = () => ({ version: 1, origin: 'https://payments-fixture.invalid', ownerId: owner, request: { quote_id: quoteId, client_request_id: key }, creditAmount: 10000, channel: 'wechat', possiblySent: true });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function fixture(overrides = {}) {
  const rows = new Map(); let current = true; const events = []; const credited = [];
  const storage = { get: async k => rows.get(k) ?? null, set: async (k, v) => { events.push('persist'); rows.set(k, v); }, remove: async k => rows.delete(k) };
  const journal = createPaymentJournal(storage, pending().origin, owner);
  const client = { origin: pending().origin, capabilities: async () => caps(), active: async () => null, quote: async () => quote(), create: async () => { events.push('post'); return order(); }, byKey: async () => order(), get: async () => order(), orders: async () => ({ items: [], next_cursor: null }), detach: async () => ({ payment: order(), active_payment: null, can_start_new_checkout: false }), ...overrides };
  const controller = createFundingController({ client, journal, identity: { ownerId: owner, generation: 1 }, isCurrent: () => current, now: () => clock, newId: () => key, onCredited: o => credited.push(o) });
  return { controller, client, journal, rows, storage, events, credited, invalidate: () => { current = false; } };
}
test('amounts preserve cents and reject ambiguous, nonpositive, excess precision and unsafe values', () => {
  assert.equal(amountMinor('100.01'), 10001); assert.equal(amountMinor('0.01'), 1);
  for (const value of ['0', '-1', '+1', '01', '1e2', '1.001', 'NaN', 'Infinity', ' 1', '1,00', '90071992547409.92']) assert.equal(amountMinor(value), null, value);
  assert.equal(amountMinor('90071992547409.91'), Number.MAX_SAFE_INTEGER);
});
test('currency formatting preserves every accepted integer cent without floating point division', () => {
  assert.equal(money(9007199254740990, 'CNY'), '¥90071992547409.90');
  assert.equal(money(Number.MAX_SAFE_INTEGER, 'CNY'), '¥90071992547409.91');
  assert.equal(money(0, 'HKD'), 'HK$0.00'); assert.equal(money(1, 'HKD'), 'HK$0.01');
  assert.equal(money(-101, 'CNY'), '-¥1.01'); assert.equal(money(-Number.MAX_SAFE_INTEGER, 'HKD'), '-HK$90071992547409.91');
  for (const value of [9007199254740992, -9007199254740992, 1.5, NaN, Infinity]) assert.throws(() => money(value, 'CNY'), { code: 'INVALID_AMOUNT' });
});
test('disabled unconfigured capabilities accept null values, enabled capabilities require real limits', () => {
  const disabled = { ...caps(), enabled: false, min_credit_amount_minor_hkd: null, max_credit_amount_minor_hkd: null, quote_ttl_seconds: null, fee_basis_points: null };
  assert.equal(decodeCapabilities(disabled).enabled, false);
  assert.throws(() => decodeCapabilities({ ...disabled, enabled: true }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeCapabilities({ ...caps(), channels: [caps().channels[0], caps().channels[0]] }));
});
test('strict quote/order validation requires correct currencies, integer math and confirmed credit evidence', () => {
  assert.equal(decodeOrder(order()).evidence_version, 0);
  for (const patch of [{ pay_currency: 'HKD' }, { credit_amount_minor_hkd: NaN }, { fee_minor_cny: -1 }, { pay_amount_minor_cny: 9000 }, { rate_evidence_sha256: 'not-proof' }]) assert.throws(() => decodeQuote({ ...quote(), ...patch }));
  assert.throws(() => decodeOrder(order({ status: 'credited' })));
  assert.throws(() => decodeOrder(order({ checkout_url: 'https://api.payqixiang.cn.evil.invalid/' })));
  assert.equal(safeCheckout('https://api.payqixiang.cn/pay?id=x'), true);
  for (const url of ['http://api.payqixiang.cn/', 'javascript:alert(1)', 'https://user@api.payqixiang.cn/', 'https://api.payqixiang.cn:444/']) assert.equal(safeCheckout(url), false);
});
test('refund balances validate the reserved/available invariant while older servers remain readable', () => {
  const old = { currency: 'HKD', balance_minor: 1000, updated_at: stamp };
  assert.equal(decodeWallet(old).available_minor, undefined);
  assert.equal(decodeWallet({ ...old, frozen_minor: 300, available_minor: 700 }).available_minor, 700);
  for (const patch of [{ frozen_minor: 300 }, { frozen_minor: -1, available_minor: 1001 }, { frozen_minor: 300, available_minor: 701 }, { frozen_minor: 1100, available_minor: 0 }]) {
    assert.throws(() => decodeWallet({ ...old, ...patch }), { code: 'INVALID_RESPONSE' });
  }
});
test('refund metadata must be complete and ledger reversals carry an original refund reference', () => {
  assert.equal(decodeOrder(order({ refund_id: key, refund_status: 'refunded', refunded_at: stamp, refund_version: 2 })).refund_status, 'refunded');
  for (const patch of [{ refund_id: key }, { refund_id: key, refund_status: 'refunded', refunded_at: null }, { refund_id: null, refund_status: 'unknown', refunded_at: null }]) {
    assert.throws(() => decodeOrder(order(patch)), { code: 'INVALID_RESPONSE' });
  }
  const entry = { transaction_id: key, payment_id: paymentId, amount_minor: -1000, balance_after_minor: 0, created_at: stamp };
  const decoded = decodeLedger({ items: [{ ...entry, kind: 'refund_reversal', refund_id: quoteId }], next_cursor: null });
  assert.equal(decoded.items[0].amount_minor, -1000);
  assert.equal(decoded.items[0].refund_id, quoteId);
  for (const patch of [{}, { kind: 'credit', refund_id: quoteId }, { kind: 'refund_reversal', refund_id: null }, { amount_minor: 0, kind: 'credit', refund_id: null }]) {
    assert.throws(() => decodeLedger({ items: [{ ...entry, ...patch }], next_cursor: null }), { code: 'INVALID_RESPONSE' });
  }
});
test('refunded intent A recovers without blocking checkout B or authorizing duplicate funding', async () => {
  const refunded = order({ status: 'failed', error_code: 'refunded', terminal: true, evidence_version: 1, refund_id: quoteId, refund_status: 'refunded', refunded_at: stamp, refund_version: 2 });
  const other = order({ payment_id: quoteId, client_request_id: owner, quote_id: owner, status: 'awaiting_payment' });
  let creates = 0;
  const f = fixture({ byKey: async () => refunded, active: async () => other, create: async () => { creates++; return other; } });
  await f.journal.save(pending());
  await f.controller.load();
  assert.equal(await f.journal.read(), null);
  assert.equal(f.controller.getSnapshot().order.payment_id, quoteId);
  await f.controller.quote('100', 'wechat');
  assert.equal(f.controller.getSnapshot().error, 'PAYMENT_OPERATION_PENDING');
  assert.equal(creates, 0);
  f.controller.dispose();
});
test('both readers refresh balances for new refund versions and fence old versions and sign-out', async () => {
  for (const kind of ['funding', 'detail']) {
    const f = fixture(); let current = true; let delayed = null;
    const original = order({ status: 'credited', terminal: true, safe_to_start_new: true, credited_transaction_id: quoteId, evidence_version: 1, refund_id: null, refund_status: null, refunded_at: null, refund_version: null });
    let response = original; const events = [];
    const client = { ...f.client, active: async () => response, get: async () => delayed ? delayed.promise : response };
    const deps = { client, ownerId: owner, isCurrent: () => current, onCredited: () => events.push('credit'), onRefundChanged: value => events.push(value.refund_status) };
    const reader = kind === 'funding'
      ? createFundingController({ ...deps, journal: f.journal, identity: { ownerId: owner, generation: 1 }, newId: () => key, now: () => clock })
      : createPaymentDetailController({ ...deps, canDetach: () => false });
    if (kind === 'funding') await reader.load();
    else { reader.setActive(true); reader.select(paymentId); await new Promise(resolve => setImmediate(resolve)); }
    assert.deepEqual(events, ['credit']);
    response = { ...original, refund_id: key, refund_status: 'requested', refund_version: 1 };
    await reader.refresh();
    response = { ...response, refund_status: 'refunded', refund_version: 2, refunded_at: stamp };
    await reader.refresh(); await reader.refresh();
    assert.deepEqual(events, ['credit', 'requested', 'refunded']);
    response = { ...response, refund_status: 'requested', refund_version: 1, refunded_at: null };
    await reader.refresh();
    assert.equal(reader.getSnapshot().error, 'PAYMENT_RESPONSE_MISMATCH');
    assert.equal(reader.getSnapshot().order.refund_status, 'refunded');
    delayed = deferred(); const late = reader.refresh(); current = false;
    delayed.resolve({ ...response, refund_status: 'unknown', refund_version: 3 }); await late;
    assert.deepEqual(events, ['credit', 'requested', 'refunded']);
    reader.dispose(); f.controller.dispose();
  }
});
test('journal strips token-like fields, scopes by owner and origin, and verifies writes before submission', async () => {
  const f = fixture(); await f.journal.save({ ...pending(), token: 'NEVER_STORE', request: { ...pending().request, Authorization: 'secret' } });
  for (const [k, v] of f.rows) { assert.match(k, /^[A-Za-z0-9._-]+$/); assert.ok(!v.includes('secret')); assert.ok(!v.includes('NEVER_STORE')); }
  const other = createPaymentJournal(f.storage, pending().origin, key); assert.equal(await other.read(), null);
  const anotherOrigin = createPaymentJournal(f.storage, 'https://other.invalid', owner); assert.equal(await anotherOrigin.read(), null);
  await assert.rejects(f.journal.save({ ...pending(), request: { ...pending().request, client_request_id: owner } }));
  f.storage.set = async () => {}; const broken = createPaymentJournal(f.storage, 'https://broken.invalid', owner);
  await assert.rejects(broken.save({ ...pending(), origin: 'https://broken.invalid' }), { code: 'PAYMENT_STORAGE_ERROR' });
});
test('confirm persists twice before one create and unknown results are queried without replaying POST', async () => {
  let creates = 0; let queries = 0;
  const f = fixture({ create: async () => { creates++; f.events.push('post'); throw new PaymentError('REQUEST_TIMEOUT'); }, byKey: async value => { queries++; assert.equal(value, key); return order(); } });
  await f.controller.load(); await f.controller.quote('100', 'wechat');
  await Promise.all([f.controller.confirm(), f.controller.confirm()]);
  assert.equal(creates, 1); assert.deepEqual(f.events.slice(0, 3), ['persist', 'persist', 'post']);
  assert.equal(f.controller.getSnapshot().pending.request.client_request_id, key);
  await f.controller.refresh(); await f.controller.confirm();
  assert.equal(queries, 1); assert.equal(creates, 1); f.controller.dispose();
});
test('storage failure prevents create', async () => {
  let creates = 0; const f = fixture({ create: async () => { creates++; return order(); } });
  f.storage.set = async () => { throw Error('locked'); };
  await f.controller.load(); await f.controller.quote('100', 'wechat'); await f.controller.confirm();
  assert.equal(creates, 0); assert.equal(f.controller.getSnapshot().error, 'PAYMENT_STORAGE_ERROR'); f.controller.dispose();
});
for (const status of [401, 429]) test(`${status} recovery retains original key across a new controller`, async () => {
  const f = fixture({ byKey: async () => { throw new PaymentError(status === 401 ? 'UNAUTHORIZED' : 'RATE_LIMITED', status); } });
  await f.journal.save(pending()); await f.controller.load();
  assert.equal((await f.journal.read()).request.client_request_id, key); assert.ok(f.controller.getSnapshot().pending);
  f.controller.dispose();
  const next = createFundingController({ client: f.client, journal: f.journal, identity: { ownerId: owner, generation: 2 }, isCurrent: () => true, newId: () => assert.fail('recovery cannot generate a new key'), now: () => clock });
  await next.load(); assert.equal(next.getSnapshot().pending.request.client_request_id, key); next.dispose();
});
test('identity generation change discards late quote and cannot persist or create', async () => {
  const late = deferred(); const f = fixture({ quote: () => late.promise }); await f.controller.load();
  const job = f.controller.quote('100', 'wechat'); f.invalidate(); late.resolve(quote()); await job;
  assert.equal(f.controller.getSnapshot().quote, null); assert.equal(f.rows.size, 0); f.controller.dispose();
});
test('wrong owner/order reply keeps pending and never invokes credit callback', async () => {
  const f = fixture({ byKey: async () => order({ account_id: key }) }); await f.journal.save(pending()); await f.controller.load();
  assert.equal(f.controller.getSnapshot().error, 'PAYMENT_RESPONSE_MISMATCH'); assert.ok(await f.journal.read()); assert.equal(f.credited.length, 0); f.controller.dispose();
});
test('disabled channel cannot request quote and viewing history cannot bypass an active unsafe order', async () => {
  let quotes = 0; const historical = order({ payment_id: quoteId, terminal: true, safe_to_start_new: true, status: 'failed' });
  const f = fixture({ active: async () => order(), get: async () => historical, quote: async () => { quotes++; return quote(); } });
  await f.controller.load(); await f.controller.select(historical); await f.controller.quote('100', 'wechat'); assert.equal(quotes, 0);
  f.controller.dispose(); const g = fixture({ quote: async () => { quotes++; return quote(); } }); await g.controller.load(); await g.controller.quote('100', 'alipay'); assert.equal(quotes, 0); g.controller.dispose();
});
test('server credited evidence clears original pending and refreshes balance once', async () => {
  const paid = order({ status: 'credited', terminal: true, safe_to_start_new: true, credited_transaction_id: quoteId, evidence_version: 1 });
  const f = fixture({ byKey: async () => paid, get: async () => paid }); await f.journal.save(pending()); await f.controller.load(); await f.controller.refresh();
  assert.equal(await f.journal.read(), null); assert.equal(f.credited.length, 1); f.controller.dispose();
});
test('old server unavailable responses never become local success', async () => {
  for (const status of [404, 501]) {
    const client = createPaymentClient({ baseUrl: 'https://payments-fixture.invalid', getToken: () => 'synthetic-token', transport: async () => new Response('', { status }) });
    await assert.rejects(client.capabilities(), { code: 'PAYMENTS_UNAVAILABLE', status });
  }
});
test('transport ignoring abort still settles timeout; no automatic write retry', async () => {
  let calls = 0;
  const client = createPaymentClient({ baseUrl: 'https://payments-fixture.invalid', getToken: () => 'synthetic-token', timeoutMs: 10, transport: () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(client.create(pending().request), { code: 'REQUEST_TIMEOUT' }); assert.equal(calls, 1);
});
test('foreground polling clamps short provider interval to five seconds and stops at twenty polls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: clock });
  let reads = 0; const f = fixture({ get: async () => { reads++; return order(); } });
  await f.controller.load(); await f.controller.select(order());
  f.controller.setActive(true); await new Promise(resolve => setImmediate(resolve)); const immediate = reads;
  t.mock.timers.tick(4999); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, immediate);
  for (let i = 0; i < 25; i++) { t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(reads, immediate + 20); f.controller.setActive(false);
  t.mock.timers.tick(60_000); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, immediate + 20); f.controller.dispose();
});
test('history view switch clears cursor and discards late responses from previous view', async () => {
  const late = deferred(); const requests = []; const f = fixture({ orders: async (view, cursor) => { requests.push([view, cursor]); return view === 'pending' ? late.promise : { items: [order({ terminal: true, safe_to_start_new: true, status: 'failed' })], next_cursor: null }; } });
  const old = f.controller.loadOrders('pending'); await f.controller.loadOrders('history');
  late.resolve({ items: [order()], next_cursor: 'wrong-cursor' }); await old;
  assert.equal(f.controller.getSnapshot().orders.view, 'history'); assert.equal(f.controller.getSnapshot().orders.cursor, null); assert.deepEqual(requests, [['pending', null], ['history', null]]); f.controller.dispose();
});
test('authoritative Q not-found after lost original POST replays exact original command, never a new key', async () => {
  const sent = []; let lookups = 0;
  const f = fixture({ byKey: async value => { lookups++; assert.equal(value, key); throw new PaymentError('PAYMENT_NOT_FOUND', 404); }, create: async body => { sent.push(body); return order(); } });
  await f.journal.save(pending()); await f.controller.load();
  assert.equal(lookups, 1); assert.deepEqual(sent, [pending().request]); assert.equal(f.controller.getSnapshot().order.client_request_id, key);
  assert.equal((await f.journal.read()).request.client_request_id, key); f.controller.dispose();
});
test('generic missing endpoint never authorizes Q command replay', async () => {
  let creates = 0; const f = fixture({ byKey: async () => { throw new PaymentError('PAYMENTS_UNAVAILABLE', 404); }, create: async () => { creates++; return order(); } });
  await f.journal.save(pending()); await f.controller.load(); assert.equal(creates, 0); assert.ok(await f.journal.read()); f.controller.dispose();
});
test('only awaiting-payment can open checkout; returning from checkout does not credit', async () => {
  for (const status of ['creating', 'awaiting_payment', 'confirming', 'awaiting_credit_approval', 'crediting', 'review_required']) {
    const f = fixture({ active: async () => order({ status, checkout_url: 'https://api.payqixiang.cn/checkout' }), get: async () => order({ status, checkout_url: 'https://api.payqixiang.cn/checkout' }) });
    await f.controller.load(); f.controller.setActive(true); await new Promise(resolve => setImmediate(resolve)); let opened = 0; await f.controller.openCheckout(async () => { opened++; });
    assert.equal(opened, status === 'awaiting_payment' ? 1 : 0); assert.equal(f.credited.length, 0); assert.equal(f.controller.getSnapshot().order.status, status); f.controller.dispose();
  }
});
test('create response cannot change the reviewed CNY payable amount or frozen rate evidence', async () => {
  const f = fixture({ create: async () => order({ pay_amount_minor_cny: 9091, fee_minor_cny: 91 }) });
  await f.controller.load(); await f.controller.quote('100', 'wechat'); await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().error, 'PAYMENT_RESPONSE_MISMATCH'); assert.equal(f.controller.getSnapshot().order, null); assert.ok(await f.journal.read()); f.controller.dispose();
});
test('explicit capability reload activates an unconfigured instance and preserves the original pending request', async () => {
  let enabled = false; const seen = [];
  const f = fixture({ capabilities: async () => ({ ...caps(), enabled }), byKey: async value => { seen.push(value); return order(); } });
  await f.controller.load(); assert.equal(f.controller.getSnapshot().capabilities.enabled, false);
  enabled = true; await f.controller.load(); assert.equal(f.controller.getSnapshot().capabilities.enabled, true); assert.equal(f.controller.getSnapshot().phase, 'amount');
  await f.journal.save(pending()); await f.controller.load();
  assert.deepEqual(seen, [key]); assert.equal(f.controller.getSnapshot().pending.request.client_request_id, key);
  assert.deepEqual((await f.journal.read()).request, pending().request); f.controller.dispose();
});
test('history background abort immediately releases busy and permits a fresh same-view read', async () => {
  const late = deferred(); let oldSignal; let calls = 0;
  const f = fixture({ orders: async (_view, _cursor, signal) => { calls++; if (calls === 1) { oldSignal = signal; return late.promise; } return { items: [order({ status: 'failed', terminal: true, safe_to_start_new: true })], next_cursor: null }; } });
  const previous = f.controller.loadOrders('pending'); assert.equal(f.controller.getSnapshot().orders.busy, true);
  f.controller.setActive(false); assert.equal(oldSignal.aborted, true); assert.equal(f.controller.getSnapshot().orders.busy, false);
  await f.controller.loadOrders('pending'); assert.equal(calls, 2); assert.equal(f.controller.getSnapshot().orders.items[0].status, 'failed');
  late.resolve({ items: [order()], next_cursor: 'old-cursor' }); await previous;
  assert.equal(f.controller.getSnapshot().orders.items[0].status, 'failed'); assert.equal(f.controller.getSnapshot().orders.cursor, null); f.controller.dispose();
});
test('history view switch and disposal abort their owned fetch signals', async () => {
  const delayed = []; const signals = [];
  const f = fixture({ orders: async (_view, _cursor, signal) => { const wait = deferred(); delayed.push(wait); signals.push(signal); return wait.promise; } });
  const first = f.controller.loadOrders('pending'); const second = f.controller.loadOrders('history');
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  f.controller.dispose(); assert.equal(signals[1].aborted, true);
  for (const wait of delayed) wait.resolve({ items: [], next_cursor: null }); await Promise.all([first, second]);
});
test('authoritative original-key not-created terminal proof releases pending and permits a new quote', async () => {
  let quotes = 0; const sent = [];
  const f = fixture({ byKey: async () => { throw new PaymentError('PAYMENT_NOT_FOUND', 404); }, create: async request => {
    sent.push(request); return order({ status: 'failed', error_code: 'not_created', terminal: true, safe_to_start_new: true });
  }, quote: async () => { quotes++; return quote(); } });
  await f.journal.save(pending()); await f.controller.load();
  assert.deepEqual(sent, [pending().request]); assert.equal(await f.journal.read(), null); assert.equal(f.controller.getSnapshot().pending, null);
  f.controller.edit(); await f.controller.quote('100', 'wechat'); assert.equal(quotes, 1); assert.equal(f.controller.getSnapshot().phase, 'review'); f.controller.dispose();
});
test('multi-device not-created proof clears only intent A while active checkout B still blocks new payment', async () => {
  let quotes = 0; const original = pending();
  const other = order({ payment_id: quoteId, quote_id: owner, client_request_id: paymentId, status: 'awaiting_payment', checkout_url: 'https://api.payqixiang.cn/pay' });
  const f = fixture({ byKey: async () => { throw new PaymentError('PAYMENT_NOT_FOUND', 404); }, create: async request => {
    assert.deepEqual(request, original.request); return order({ status: 'failed', error_code: 'not_created', terminal: true, safe_to_start_new: false });
  }, active: async () => other, quote: async () => { quotes++; return quote(); } });
  await f.journal.save(original); await f.controller.load();
  assert.equal(await f.journal.read(), null); assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().order.payment_id, other.payment_id);
  await f.controller.quote('100', 'wechat'); assert.equal(quotes, 0); assert.equal(f.controller.getSnapshot().error, 'PAYMENT_OPERATION_PENDING'); f.controller.dispose();
});
test('not-created proof with false slot flag and empty active lookup never permits a new checkout', async () => {
  let quotes = 0;
  const f = fixture({ byKey: async () => order({ status: 'failed', error_code: 'not_created', terminal: true, safe_to_start_new: false }), quote: async () => { quotes++; return quote(); } });
  await f.journal.save(pending()); await f.controller.load();
  assert.equal(await f.journal.read(), null); assert.equal(f.controller.getSnapshot().error, 'PAYMENT_OPERATION_PENDING');
  await f.controller.quote('100', 'wechat'); assert.equal(quotes, 0); f.controller.dispose();
});

test('primary checkout requires fresh evidence in the same activation and never uses a failed resume cache', async () => {
  let fail = false; const opened = [];
  const payable = order({ status: 'awaiting_payment', checkout_url: 'https://api.payqixiang.cn/pay/A' });
  const f = fixture({ active: async () => payable, get: async () => { if (fail) throw new PaymentError('NETWORK_ERROR'); return payable; } });
  try {
    await f.controller.load(); await f.controller.openCheckout(async url => opened.push(url)); assert.deepEqual(opened, []);
    f.controller.setActive(true); await new Promise(resolve => setImmediate(resolve));
    await f.controller.openCheckout(async url => opened.push(url)); assert.equal(opened.length, 1);
    f.controller.setActive(false); await f.controller.openCheckout(async url => opened.push(url)); assert.equal(opened.length, 1);
    fail = true; f.controller.setActive(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.controller.getSnapshot().order.status, 'awaiting_payment'); assert.equal(f.controller.getSnapshot().error, 'NETWORK_ERROR');
    await f.controller.openCheckout(async url => opened.push(url)); assert.equal(opened.length, 1, 'failed resume must not make cached checkout ready');
    fail = false; await f.controller.refresh(); await f.controller.openCheckout(async url => opened.push(url)); assert.equal(opened.length, 2);
  } finally { f.controller.dispose(); }
});
