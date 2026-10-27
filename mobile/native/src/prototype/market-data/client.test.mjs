import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { getEventListeners } from 'node:events';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/market-data/client.ts') && specifier === './core') return next('./core.ts', context);
  return next(specifier, context);
} });
const { requestMarketReport, MARKET_TIMEOUT_MS, MARKET_RESPONSE_LIMIT_BYTES } = await import('./client.ts');
test.after(() => resolver.deregister());
const crypto = { kind: 'crypto', asset: 'BTC' };
const markets = { kind: 'news', topic: 'markets' };
const fed = { kind: 'news', topic: 'fed' };
const coin = { id: 'btc-bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, last_updated: '2026-10-27T11:00:00Z', quotes: { USD: { price: 100 } } };
const payload = value => Response.json(value);
const fails = (action, code) => assert.rejects(action, error => error.code === code && error.message === code);
const withUrl = (response, url) => { Object.defineProperty(response, 'url', { value: url }); return response; };

test('crypto requires explicit development opt-in and never starts a blocked request', async () => {
  let calls = 0;
  const transport = async () => { calls++; return payload(coin); };
  await fails(requestMarketReport(crypto, { transport }), 'development_only');
  await fails(requestMarketReport(crypto, { transport, allowDevelopmentSources: false }), 'development_only');
  assert.equal(calls, 0);
  const result = await requestMarketReport(crypto, { transport, allowDevelopmentSources: true });
  assert.equal(calls, 1); assert.equal(result.records[0].priceUsd, 100);
});

test('transport receives exactly one anonymous GET with safe fixed URL and no account headers', async () => {
  let calls = 0;
  const report = await requestMarketReport(markets, { transport: async (url, init) => {
    calls++;
    assert.equal(new URL(url).origin, 'https://api.gdeltproject.org');
    assert.equal(new URL(url).searchParams.get('maxrecords'), '20');
    assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(init.headers, { Accept: 'application/json' }); assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    return withUrl(payload({ articles: [] }), url);
  } });
  assert.equal(calls, 1); assert.deepEqual(report.records, []);
});

test('SEC adds only its public user agent and verifies the issuer response', async () => {
  const query = { kind: 'filings', company: 'MSFT' };
  const result = await requestMarketReport(query, { transport: async (url, init) => {
    assert.equal(url, 'https://data.sec.gov/submissions/CIK0000789019.json');
    assert.deepEqual(init.headers, { Accept: 'application/json', 'User-Agent': 'Q-Public-Research/0.1 (+https://q.kaicloudpay.com)' });
    return payload({ cik: 789019, tickers: ['MSFT'], name: 'Microsoft', filings: { recent: { accessionNumber: [], filingDate: [], reportDate: [], acceptanceDateTime: [], form: [], primaryDocument: [] } } });
  } });
  assert.equal(result.kind, 'filings');
});

test('Fed uses its fixed feed and XML accept types', async () => {
  const result = await requestMarketReport(fed, { transport: async (url, init) => {
    assert.equal(url, 'https://www.federalreserve.gov/feeds/press_monetary.xml');
    assert.equal(Object.keys(init.headers).length, 1);
    return new Response('<rss><channel><title>Public feed</title></channel></rss>', { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
  } });
  assert.equal(result.records.length, 0);
});

test('invalid selectors never reach transport, including arbitrary URL additions', async () => {
  let calls = 0;
  for (const query of [{ ...markets, url: 'https://evil.example/' }, { kind: 'crypto', asset: '__proto__' }, null]) {
    await fails(requestMarketReport(query, { transport: async () => { calls++; return payload({ articles: [] }); } }), 'invalid_query');
  }
  assert.equal(calls, 0);
});

test('redirect flags, changed URLs and 3xx responses are rejected without a follow-up', async () => {
  for (const make of [
    () => new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }),
    () => { const response = payload({ articles: [] }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => withUrl(payload({ articles: [] }), 'https://evil.example/'),
  ]) {
    let calls = 0;
    await fails(requestMarketReport(markets, { transport: async () => { calls++; return make(); } }), 'redirect');
    assert.equal(calls, 1);
  }
});

test('429 is safe and carries bounded Retry-After; there is no automatic retry', async () => {
  for (const [header, expected] of [['120', 120000], ['999999999', 86400000], ['private-error', null]]) {
    let calls = 0;
    await assert.rejects(requestMarketReport(markets, { transport: async () => { calls++; return new Response('SECRET_PROVIDER_BODY', { status: 429, headers: { 'Retry-After': header } }); } }), error => {
      assert.equal(error.code, 'rate_limited'); assert.equal(error.status, 429); assert.equal(error.retryAfterMs, expected);
      assert.doesNotMatch(error.message, /SECRET/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('401/403/500 remain source HTTP failures without credential recovery', async () => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    await assert.rejects(requestMarketReport(markets, { transport: async () => { calls++; return new Response('PRIVATE_AUTH_PROMPT', { status }); } }), error => error.code === 'http' && error.status === status && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('pre-cancelled request never calls transport; in-flight cancellation rejects promptly', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await fails(requestMarketReport(markets, { signal: before.signal, transport: async () => { calls++; return payload({ articles: [] }); } }), 'cancelled');
  assert.equal(calls, 0);
  const active = new AbortController(); let requestSignal;
  const pending = requestMarketReport(markets, { signal: active.signal, transport: async (_url, init) => { requestSignal = init.signal; return new Promise(() => undefined); } });
  const rejection = fails(pending, 'cancelled'); active.abort(); await rejection; assert.equal(requestSignal.aborted, true);
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
});

test('10 second timeout covers an unresponsive transport and aborts it', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal; const external = new AbortController();
  const pending = requestMarketReport(markets, { signal: external.signal, transport: async (_url, init) => { signal = init.signal; return new Promise(() => undefined); } });
  const rejection = fails(pending, 'timeout');
  context.mock.timers.tick(MARKET_TIMEOUT_MS); await rejection;
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('timeout and user cancellation also interrupt an open response body', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled++; } });
  const pending = requestMarketReport(markets, { transport: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) });
  const rejection = fails(pending, 'timeout');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  context.mock.timers.tick(MARKET_TIMEOUT_MS); await rejection;
  assert.equal(cancelled, 1);
});

test('user cancellation during body reading cancels the reader without displaying partial JSON', async () => {
  const external = new AbortController(); let cancelled = 0; let started;
  const reading = new Promise(resolve => { started = resolve; });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"articles":')); }, pull() { started(); }, cancel() { cancelled++; } });
  const pending = requestMarketReport(markets, { signal: external.signal, transport: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) });
  const rejection = fails(pending, 'cancelled');
  await reading; external.abort(); await rejection;
  assert.equal(cancelled, 1);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('a transport resolving after cancellation has its body cancelled and cannot return data', async () => {
  const external = new AbortController(); let finish; let cancelled = 0;
  const pending = requestMarketReport(markets, { signal: external.signal, transport: () => new Promise(resolve => { finish = resolve; }) });
  const rejection = fails(pending, 'cancelled'); external.abort(); await rejection;
  const stream = new ReadableStream({ cancel() { cancelled++; } });
  finish(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, 1);
});

test('stream limits count bytes, reject oversized chunks and cancel without full-body helpers', async () => {
  for (const declared of [null, '1', String(MARKET_RESPONSE_LIMIT_BYTES + 1)]) {
    let cancelled = false; let helperCalls = 0;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MARKET_RESPONSE_LIMIT_BYTES + 1)); }, cancel() { cancelled = true; } });
    const headers = { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': declared } : {}) };
    const response = new Response(stream, { headers });
    response.json = response.text = response.arrayBuffer = () => { helperCalls++; throw new Error('should not read full body'); };
    await fails(requestMarketReport(markets, { transport: async () => response }), 'too_large');
    assert.equal(cancelled, true); assert.equal(helperCalls, 0);
  }
});

test('exact byte limit is accepted and multibyte chunk boundaries decode correctly', async () => {
  const base = JSON.stringify({ articles: [] });
  const exact = base + ' '.repeat(MARKET_RESPONSE_LIMIT_BYTES - base.length);
  assert.deepEqual((await requestMarketReport(markets, { transport: async () => new Response(exact, { headers: { 'Content-Type': 'application/json' } }) })).records, []);
  const encoded = new TextEncoder().encode(JSON.stringify({ articles: [{ title: '比特币市场', url: 'https://example.com/a', seendate: '20261027T115000Z' }] }));
  const stream = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const report = await requestMarketReport(markets, { transport: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(report.records[0].title, '比特币市场');
});

test('missing stream is rejected without falling back to unbounded text or json', async () => {
  let reads = 0;
  const response = { ok: true, status: 200, url: '', redirected: false, type: 'basic', headers: new Headers({ 'Content-Type': 'application/json' }), body: null,
    text() { reads++; }, json() { reads++; } };
  await fails(requestMarketReport(markets, { transport: async () => response }), 'stream_unavailable'); assert.equal(reads, 0);
});

test('malformed JSON, wrong media type, invalid UTF-8 and schema failures are safe invalid-data errors', async () => {
  for (const response of [new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), new Response('<html>PRIVATE</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(Uint8Array.of(255, 254), { headers: { 'Content-Type': 'application/json' } }), payload({ error: 'PRIVATE' }),
  ]) await fails(requestMarketReport(markets, { transport: async () => response }), 'invalid_data');
  await fails(requestMarketReport(crypto, { allowDevelopmentSources: true, transport: async () => payload({ ...coin, symbol: 'ETH' }) }), 'invalid_data');
});

test('network and stream exceptions do not expose diagnostic details', async () => {
  await fails(requestMarketReport(markets, { transport: async () => { throw new Error('PRIVATE_NETWORK_INFORMATION'); } }), 'network');
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_STREAM_INFORMATION')); } });
  await fails(requestMarketReport(markets, { transport: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) }), 'network');
});

test('every admitted failure aborts the transport, preserves its error and removes caller listeners', async () => {
  const cases = [
    { code: 'redirect', status: 302, bytes: '', open: true },
    { code: 'redirect', responseUrl: 'https://elsewhere.example.com/', bytes: '', open: true },
    { code: 'http', status: 403, bytes: '', open: true },
    { code: 'rate_limited', status: 429, bytes: '', open: true },
    { code: 'invalid_data', contentType: 'text/html', bytes: 'wrong media type', open: true },
    { code: 'too_large', length: String(MARKET_RESPONSE_LIMIT_BYTES + 1), bytes: '', open: true },
    { code: 'too_large', bytes: new Uint8Array(MARKET_RESPONSE_LIMIT_BYTES + 1), open: true },
    { code: 'invalid_data', bytes: '{broken' },
    { code: 'invalid_data', bytes: '{"articles":false}' },
    { code: 'invalid_data', bytes: Uint8Array.of(255) },
    { code: 'stream_unavailable', missingBody: true },
    { code: 'network', networkFailure: true },
  ];
  for (const fixture of cases) {
    const external = new AbortController();
    let transportSignal; let cancelled = 0;
    const operation = requestMarketReport(markets, { signal: external.signal, transport: async (_url, init) => {
      transportSignal = init.signal;
      if (fixture.networkFailure) throw new Error('PRIVATE_NETWORK_FAILURE');
      const body = fixture.missingBody ? null : new ReadableStream({ start(controller) {
        controller.enqueue(typeof fixture.bytes === 'string' ? new TextEncoder().encode(fixture.bytes) : fixture.bytes);
        if (!fixture.open) controller.close();
      }, cancel() { cancelled++; } });
      const response = new Response(body, { status: fixture.status ?? 200, headers: {
        'Content-Type': fixture.contentType ?? 'application/json', ...(fixture.length ? { 'Content-Length': fixture.length } : {}),
      } });
      return fixture.responseUrl ? withUrl(response, fixture.responseUrl) : response;
    } });
    await fails(operation, fixture.code);
    assert.equal(transportSignal.aborted, true, fixture.code);
    assert.equal(external.signal.aborted, false, 'the caller owns its signal');
    assert.equal(getEventListeners(external.signal, 'abort').length, 0, fixture.code);
    if (fixture.open) assert.equal(cancelled, 1, `unread ${fixture.code} body is cancelled`);
  }
});

test('successful completion aborts the finished native request and detaches caller listeners', async () => {
  const external = new AbortController(); let transportSignal;
  const result = await requestMarketReport(markets, { signal: external.signal, transport: async (_url, init) => {
    transportSignal = init.signal; return payload({ articles: [] });
  } });
  assert.deepEqual(result.records, []);
  assert.equal(transportSignal.aborted, true);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});
