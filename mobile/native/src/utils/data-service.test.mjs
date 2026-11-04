import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
test.after(() => resolver.deregister());
const { dataServices, dataServiceById, priceText, REAL_CHANNEL_CONNECTED, DATA_SERVICE_REVIEWED_ON, fundOptions, fundById, trustedFundUrl } = await import('../prototype/data-service/catalog.ts');
const { createServiceLedger, topUpDemoCredit, chargeService, markDelivered, refundOrder, redeemProQaCredit, DEMO_INITIAL_TOPUP_MINOR_CNY } = await import('../prototype/data-service/core.ts');

const newId = (() => { let n = 0; return () => `id-${++n}`; })();
const at = '2026-11-03T10:00:00.000Z';
const funded = () => topUpDemoCredit(createServiceLedger(), DEMO_INITIAL_TOPUP_MINOR_CNY, at, newId);

test('service catalogue prices every service inside the documented pay-per-use band', () => {
  assert.equal(dataServices.length, 4);
  for (const service of dataServices) {
    assert.ok(service.priceMinorCny >= 5 && service.priceMinorCny <= 50, service.id);
    assert.ok(service.title.every(Boolean) && service.summary.every(Boolean) && service.deliverable.every(Boolean), service.id);
    assert.match(service.sourceUrl, /^https:/);
    assert.ok(['market-report', 'fund-profile', 'qa-credit'].includes(service.delivery), service.id);
    assert.ok(dataServiceById(service.id) === service);
  }
  assert.equal(dataServiceById('missing'), null);
  assert.equal(priceText(5), '¥0.05');
  assert.equal(priceText(50), '¥0.50');
  assert.equal(DATA_SERVICE_REVIEWED_ON, '2026-11-03');
  assert.equal(REAL_CHANNEL_CONNECTED, false);
});

test('fund options carry public disclosures, non-fixed fee notes and trusted official urls', () => {
  assert.equal(fundOptions.length, 2);
  for (const fund of fundOptions) {
    assert.ok(fund.name.every(Boolean) && fund.feeNote.every(Boolean) && fund.risk.every(Boolean), fund.id);
    assert.match(fund.risk[0], /不保证|有风险/);
    assert.equal(trustedFundUrl(fund.url), true, fund.id);
    assert.equal(fundById(fund.id), fund);
  }
  assert.equal(fundById('missing'), null);
  assert.equal(trustedFundUrl('http://www.efunds.com.cn/'), false);
  assert.equal(trustedFundUrl('https://example.com/fund'), false);
});

test('charging debits once, records a charge event and grants one Pro credit', () => {
  const first = chargeService(funded(), 'crypto-quote', at, newId);
  assert.ok(first.ok);
  assert.equal(first.state.balanceMinorCny, DEMO_INITIAL_TOPUP_MINOR_CNY - 5);
  assert.equal(first.order.status, 'awaiting_delivery');
  assert.equal(first.state.events[0].kind, 'charge');
  assert.equal(first.state.events[0].deltaMinorCny, -5);
  const pro = chargeService(first.state, 'pro-qa', at, newId);
  assert.ok(pro.ok);
  assert.equal(pro.state.proQaCredits, 1);
  assert.equal(pro.state.balanceMinorCny, DEMO_INITIAL_TOPUP_MINOR_CNY - 55);
  assert.ok(chargeService(createServiceLedger(), 'crypto-quote', at, newId).error === 'insufficient_balance');
  assert.ok(chargeService(funded(), 'not-a-service', at, newId).error === 'unknown_service');
});

test('delivery marks the order and a failed delivery refunds the full charge with paired entries', () => {
  const charged = chargeService(funded(), 'company-filings', at, newId);
  assert.ok(charged.ok);
  const delivered = markDelivered(charged.state, charged.order.id, 'AAPL · 12 filings');
  assert.equal(delivered.orders[0].status, 'delivered');
  assert.equal(delivered.orders[0].detail, 'AAPL · 12 filings');
  assert.equal(markDelivered(delivered, 'missing', ''), delivered);
  const failed = refundOrder(charged.state, charged.order.id, at, newId);
  assert.equal(failed.balanceMinorCny, DEMO_INITIAL_TOPUP_MINOR_CNY);
  assert.equal(failed.orders[0].status, 'refunded');
  assert.equal(failed.events[0].kind, 'refund');
  assert.equal(failed.events[0].deltaMinorCny, 30);
  assert.equal(refundOrder(failed, charged.order.id, at, newId), failed, 'double refund is a no-op');
  const deliveredThenRefund = refundOrder(delivered, charged.order.id, at, newId);
  assert.equal(deliveredThenRefund, delivered, 'a delivered order is never refunded');
});

test('Pro credits redeem once and failed pro orders do not keep the credit', () => {
  const bought = chargeService(funded(), 'pro-qa', at, newId);
  assert.ok(bought.ok);
  const redeemed = redeemProQaCredit(bought.state);
  assert.ok(redeemed.ok && redeemed.state.proQaCredits === 0);
  assert.ok(redeemProQaCredit(redeemed.state).error === 'no_credit_to_redeem');
  const refundedPro = refundOrder(bought.state, bought.order.id, at, newId);
  assert.equal(refundedPro.proQaCredits, 0);
});
