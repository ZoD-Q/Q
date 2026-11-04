import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
test.after(() => resolver.deregister());
const catalog = await import('../prototype/wealth-center/catalog.ts');
const core = await import('../prototype/wealth-center/core.ts');

const rng = () => 0.5;

test('simulated market steps are deterministic, bounded and respect the rolling window', () => {
  const seeded = core.seedCandles(30, catalog.SIM_START_NAV, rng);
  assert.equal(seeded.candles.length, 30);
  for (const candle of seeded.candles) {
    assert.ok(candle.h >= Math.max(candle.o, candle.c) && candle.l <= Math.min(candle.o, candle.c));
    assert.ok(candle.c > 0);
  }
  const next = core.nextCandle(seeded.price, rng);
  assert.equal(next.candle.o, seeded.price);
  assert.equal(next.candle.c, next.price);
  const window = core.sliceWindow(seeded.candles.concat(next.candle, next.candle), 26);
  assert.equal(window.length, 26);
  const bounds = core.windowBounds(window);
  assert.ok(bounds.max >= bounds.min);
});

test('today pnl and totals follow the fund-only equity units with a positive base', () => {
  const price = catalog.SIM_START_NAV + 0.001;
  const dayOpen = catalog.SIM_START_NAV;
  const pnl = core.todayPnl(price, dayOpen);
  assert.ok(Math.abs(pnl - 0.001 * catalog.EQUITY_UNITS) < 1e-6);
  assert.equal(core.todayPct(price, dayOpen) > 0, true);
  assert.equal(core.todayPnl(dayOpen, dayOpen), 0);
  const dist = core.distribution(catalog.FUND_MV, catalog.DEPOSIT_MV);
  assert.ok(Math.abs(dist.fundPct + dist.depositPct - 100) < 1e-9);
  assert.ok(catalog.HOLD_MV > catalog.HOLD_COST - 5000 && catalog.HOLD_COST > 0);
});

test('shelf and fund filters combine risk group and category exactly', () => {
  const stable = core.filterShelf(catalog.shelfItems, 'stable', 'all');
  assert.ok(stable.every(item => ['R1', 'R2'].includes(item.risk)));
  const stableShort = core.filterShelf(catalog.shelfItems, 'stable', 'short');
  assert.deepEqual(stableShort.map(item => item.name), ['同业存单指数（示例）', '短债基金（示例）']);
  assert.equal(core.filterShelf(catalog.shelfItems, 'aggressive', 'live').length, 0);
  const money = core.filterFunds(catalog.marketFunds, 'money');
  assert.equal(money.length, 3);
  assert.ok(core.filterFunds(catalog.marketFunds, 'all').length === catalog.marketFunds.length);
  assert.equal(core.filterFunds(catalog.marketFunds, 'qdii')[0].code, '000071');
});

test('catalogue keeps demo ledger disclaimers and https official urls only', () => {
  assert.match(catalog.DEMO_NOTE[0], /模拟/);
  assert.match(catalog.DISCLAIMER[0], /不构成投资建议/);
  for (const holding of catalog.holdings) assert.ok(holding.official === null || holding.official.startsWith('https:'));
  for (const fund of catalog.marketFunds) assert.match(fund.host, /^www\./);
  assert.equal(catalog.trustedExternalUrl('https://www.efunds.com.cn', ['https://www.efunds.com.cn']), true);
  assert.equal(catalog.trustedExternalUrl('http://www.efunds.com.cn', ['https://www.efunds.com.cn']), false);
  assert.equal(catalog.trustedExternalUrl('https://evil.example.com', []), false);
});
