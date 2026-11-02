import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const controller = await import('./controller.ts'); const validation = await import('./validation.ts');
test.after(() => resolver.deregister());
const source = readFileSync(new URL('./wallet-entry.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} };
runInNewContext(output, { module, exports: module.exports, require: name => name === './controller' ? controller : name === './validation' ? validation : {}, URL, AbortController, setTimeout, clearTimeout, queueMicrotask });
const { createPaymentWalletSession } = module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ownerId = '11111111-1111-4111-8111-111111111111';
const caps = { enabled: false, unavailable_reason: 'PAYMENTS_NOT_READY', channels: [], credit_currency: 'HKD', pay_currency: 'CNY', min_credit_amount_minor_hkd: null, max_credit_amount_minor_hkd: null, fee_basis_points: null, quote_ttl_seconds: null, checkout_detach_supported: false, payment_history_supported: true, independent_orders_supported: false, approval_mode: 'governance_maker_checker_v1', server_time: '2026-11-02T00:00:00Z' };
function fixture(overrides = {}) {
  let revision = 1; let token = 'synthetic-session'; let accessToken; let walletCalls = 0; let pendingReads = 0; let clears = 0;
  const listeners = new Set(); const snapshots = []; const signals = [];
  const runtime = createPaymentWalletSession({ token, ownerId,
    store: { getRevision: () => revision, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    newId: () => assert.fail('read-only wrapper cannot create an intent without confirm'),
    journal: { read: async () => { pendingReads++; return null; }, save: async () => assert.fail('unexpected payment write'), clear: async () => { clears++; } },
    makeClient: getter => { accessToken = getter; return { origin: 'https://fixture.invalid', capabilities: async () => caps, active: async () => null, wallet: async signal => { walletCalls++; signals.push(signal); return { currency: 'HKD', balance_minor: 0, updated_at: caps.server_time }; }, ...overrides }; },
    onWallet: value => snapshots.push(value),
  });
  runtime.connect();
  return { runtime, snapshots, signals, listeners, get reads() { return pendingReads; }, get walletCalls() { return walletCalls; }, get clears() { return clears; }, getToken: () => accessToken(), invalidate: () => { revision++; token = null; for (const fn of [...listeners]) fn(token); } };
}
test('wrapper only reads while focused/foreground and rereads owner pending intent after resume', async () => {
  const f = fixture(); await tick(); assert.equal(f.walletCalls, 0); assert.equal(f.reads, 0);
  f.runtime.setActive(true); await tick(); assert.equal(f.walletCalls, 1); assert.equal(f.reads, 1);
  f.runtime.setActive(false); const before = f.walletCalls; await f.runtime.refreshWallet(); assert.equal(f.walletCalls, before);
  f.runtime.setActive(true); await tick(); assert.equal(f.walletCalls, before + 1); assert.equal(f.reads, 2); f.runtime.dispose();
});
test('synchronous logical sign-out blocks token access, cancels requests and ignores late balances', async () => {
  const late = deferred(); let signal;
  const f = fixture({ wallet: input => { signal = input; return late.promise; } });
  f.runtime.setActive(true); await tick(); const count = f.snapshots.length;
  assert.equal(f.getToken(), 'synthetic-session'); f.invalidate();
  assert.equal(f.getToken(), null); assert.equal(signal.aborted, true); assert.equal(f.listeners.size, 0);
  late.resolve({ currency: 'HKD', balance_minor: 999900, updated_at: caps.server_time }); await tick();
  assert.equal(f.snapshots.length, count); assert.equal(f.clears, 0); assert.equal(f.runtime.isCurrent(), false);
});
test('unsupported wallet has null balance and error rather than a fabricated zero', async () => {
  const f = fixture({ wallet: async () => { throw new validation.PaymentError('PAYMENTS_UNAVAILABLE', 404); } });
  f.runtime.setActive(true); await tick(); const last = f.snapshots.at(-1);
  assert.equal(last.wallet, null); assert.equal(last.busy, false); assert.equal(last.error, 'PAYMENTS_UNAVAILABLE'); f.runtime.dispose();
});
test('stale earlier balance cannot overwrite the latest refresh', async () => {
  const first = deferred(); let calls = 0;
  const f = fixture({ wallet: async () => ++calls === 1 ? first.promise : { currency: 'HKD', balance_minor: 200, updated_at: caps.server_time } });
  f.runtime.setActive(true); await tick(); await f.runtime.refreshWallet();
  first.resolve({ currency: 'HKD', balance_minor: 100, updated_at: caps.server_time }); await tick();
  assert.equal(f.snapshots.at(-1).wallet.balance_minor, 200); f.runtime.dispose();
});
test('development effect disconnect/reconnect remains usable without restoring a logged-out identity', async () => {
  const f = fixture(); f.runtime.setActive(true); f.runtime.disconnect(); f.runtime.connect(); f.runtime.setActive(true);
  await tick(); await tick(); assert.equal(f.runtime.isCurrent(), true); assert.equal(f.runtime.controller.getSnapshot().capabilities.enabled, false);
  assert.equal(f.snapshots.at(-1).wallet.balance_minor, 0);
  f.invalidate(); f.runtime.connect(); assert.equal(f.runtime.isCurrent(), false); assert.equal(f.getToken(), null); f.runtime.dispose();
});
