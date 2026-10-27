import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as core from './core.ts';

// Execute the real request owner while replacing only the unused native hook imports.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(new URL('./use-market-data.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
new Function('require', 'exports', compiled)(name => {
  if (name === './core') return core;
  if (name === './client') return { requestMarketReport: () => { throw new Error('Native transport must not be called in an offline test'); } };
  if (['react', 'react-native', 'expo/fetch'].includes(name)) return {};
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);
const { MarketDataSession, createMarketDataMemory } = exports;
const apple = { kind: 'filings', company: 'AAPL' };
const microsoft = { kind: 'filings', company: 'MSFT' };
const report = (query = apple) => ({
  kind: 'filings', query, source: { id: 'sec', name: 'SEC EDGAR', url: 'https://www.sec.gov/', developmentOnly: false },
  fetchedAt: '2026-10-27T01:00:00.000Z', asOf: '2026-10-27', freshness: 'recent', limitations: [], records: [],
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(request, query = apple, memory) {
  let now = 100_000;
  let currentKey = core.marketQueryKey(query);
  let active = true;
  const changes = [];
  const owner = new MarketDataSession(query, { request, memory, now: () => now, onChange: value => changes.push(value), isCurrent: key => active && key === currentKey });
  return {
    owner, changes,
    advance(ms) { now += ms; },
    select(next, enabled = true) { currentKey = core.marketQueryKey(next); active = enabled; owner.configure(next, enabled); },
    deactivateImmediately() { active = false; },
  };
}

test('configuration is passive, inactive queries are rejected, and pending duplicates are rejected', async () => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(() => { calls += 1; return pending.promise; });
  f.select(apple, false);
  assert.equal(await f.owner.run(), false);
  f.select(apple);
  assert.equal(calls, 0);
  const first = f.owner.run();
  assert.equal(await f.owner.run(), false);
  assert.equal(calls, 1);
  pending.resolve(report());
  assert.equal(await first, true);
  assert.equal(f.owner.state.phase, 'ready');
});

test('cancel aborts the request and ignores a transport that resolves after abort', async () => {
  const pending = deferred();
  let signal;
  const f = fixture((_query, nextSignal) => { signal = nextSignal; return pending.promise; });
  f.select(apple);
  const first = f.owner.run();
  f.owner.cancel();
  assert.equal(signal.aborted, true);
  const count = f.changes.length;
  pending.resolve(report());
  assert.equal(await first, false);
  assert.equal(f.changes.length, count);
  assert.equal(f.owner.state.phase, 'cancelled');
  assert.equal(f.owner.state.report, null);
});

test('a render-level inactive guard blocks completion before lifecycle cleanup', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  f.select(apple);
  const first = f.owner.run();
  f.deactivateImmediately();
  const count = f.changes.length;
  pending.resolve(report());
  assert.equal(await first, false);
  assert.equal(f.changes.length, count);
  assert.equal(f.owner.state.report, null);
});

test('backgrounding cancels and foregrounding never starts another request', async () => {
  const pending = deferred();
  let calls = 0;
  let signal;
  const f = fixture((_query, nextSignal) => { calls += 1; signal = nextSignal; return pending.promise; });
  f.select(apple);
  const first = f.owner.run();
  f.select(apple, false);
  f.select(apple, true);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  pending.reject(new Error('late failure'));
  assert.equal(await first, false);
  assert.equal(f.owner.state.report, null);
});

test('a different company cannot receive an old response, cached result or error result', async () => {
  const old = deferred();
  const next = deferred();
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? old.promise : next.promise);
  f.select(apple);
  const first = f.owner.run();
  f.select(microsoft);
  assert.equal(f.owner.state.report, null);
  f.advance(1_001);
  const second = f.owner.run();
  old.resolve(report(apple));
  assert.equal(await first, false);
  assert.equal(f.owner.state.report, null);
  next.reject(new Error('unavailable'));
  assert.equal(await second, false);
  assert.equal(f.owner.state.key, core.marketQueryKey(microsoft));
  assert.equal(f.owner.state.report, null);
  assert.equal(f.owner.state.phase, 'error');
});

test('successful data is cached for a finite TTL; a failed refresh retains only its matching old data', async () => {
  let calls = 0;
  const f = fixture(async query => { calls += 1; if (calls > 1) throw new Error('offline'); return report(query); });
  f.select(apple);
  assert.equal(await f.owner.run(), true);
  const first = f.owner.state.report;
  assert.equal(await f.owner.run(), true);
  assert.equal(calls, 1);
  assert.equal(f.owner.state.fromCache, true);
  f.advance(5 * 60_000 + 1);
  assert.equal(await f.owner.run(), false);
  assert.equal(calls, 2);
  assert.equal(f.owner.state.phase, 'error');
  assert.equal(f.owner.state.report, first);
  f.select(microsoft);
  assert.equal(f.owner.state.report, null);
});

test('rate limiting is shared across queries to the same provider and never auto-retries', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; throw new core.MarketDataError('rate_limited'); });
  f.select(apple);
  assert.equal(await f.owner.run(), false);
  f.select(microsoft);
  assert.equal(await f.owner.run(), false);
  assert.equal(f.owner.state.phase, 'cooldown');
  assert.equal(calls, 1);
  f.advance(60_001);
  assert.equal(calls, 1);
  assert.equal(await f.owner.run(), false);
  assert.equal(calls, 2);
});

test('a report for an unexpected query is rejected before caching or presentation', async () => {
  const f = fixture(async () => report(microsoft));
  f.select(apple);
  assert.equal(await f.owner.run(), false);
  assert.equal(f.owner.state.phase, 'error');
  assert.equal(f.owner.state.error.code, 'invalid_data');
  assert.equal(f.owner.state.report, null);
});

test('different company data may be requested after the short provider interval, without waiting for cache TTL', async () => {
  let calls = 0;
  const f = fixture(async query => { calls += 1; return report(query); });
  f.select(apple);
  assert.equal(await f.owner.run(), true);
  f.select(microsoft);
  assert.equal(await f.owner.run(), false);
  f.advance(1_001);
  assert.equal(await f.owner.run(), true);
  assert.equal(calls, 2);
  f.select(apple);
  assert.equal(await f.owner.run(), true);
  assert.equal(calls, 2);
  assert.equal(f.owner.state.fromCache, true);
});

test('crypto and GDELT use short shared provider intervals independently of each query cache', async () => {
  for (const [first, next, interval] of [
    [{ kind: 'crypto', asset: 'BTC' }, { kind: 'crypto', asset: 'ETH' }, 2_000],
    [{ kind: 'news', topic: 'markets' }, { kind: 'news', topic: 'crypto' }, 5_000],
  ]) {
    let calls = 0;
    const f = fixture(async query => {
      calls += 1;
      return { ...report(), query, kind: query.kind, source: core.marketSource(query), ...(query.kind === 'news' ? { hotspots: [] } : {}) };
    }, first);
    f.select(first);
    assert.equal(await f.owner.run(), true);
    f.select(next);
    f.advance(interval - 1);
    assert.equal(await f.owner.run(), false);
    f.advance(2);
    assert.equal(await f.owner.run(), true);
    assert.equal(calls, 2);
  }
});

test('provider Retry-After survives page destruction and cannot be bypassed by another company', async () => {
  let calls = 0;
  const memory = createMarketDataMemory();
  const request = async () => { calls += 1; throw new core.MarketDataError('rate_limited', 429, 120_000); };
  const first = fixture(request, apple, memory);
  first.select(apple);
  assert.equal(await first.owner.run(), false);
  first.owner.dispose();
  const second = fixture(request, microsoft, memory);
  second.select(microsoft);
  second.advance(60_001);
  assert.equal(await second.owner.run(), false);
  assert.equal(calls, 1);
  second.advance(60_000);
  assert.equal(await second.owner.run(), false);
  assert.equal(calls, 2);
});

test('public cache survives navigation without keeping the previous page request owner active', async () => {
  let calls = 0;
  const memory = createMarketDataMemory();
  const request = async query => { calls += 1; return report(query); };
  const first = fixture(request, apple, memory);
  first.select(apple);
  assert.equal(await first.owner.run(), true);
  first.owner.dispose();
  const second = fixture(request, apple, memory);
  second.select(apple);
  assert.equal(second.owner.state.fromCache, true);
  assert.equal(await second.owner.run(), true);
  assert.equal(calls, 1);
});
