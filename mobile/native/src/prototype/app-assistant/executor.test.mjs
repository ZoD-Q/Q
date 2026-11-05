import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('./core.ts');
const marketCore = await import('../market-data/core.ts');
const client = await import('../market-data/client.ts');
const companyClient = await import('../company-research/client.ts');
const companyCore = await import('../company-research/core.ts');
test.after(() => resolver.deregister());
const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function runtime(platform) {
  const session = {};
  new Function('require', 'exports', transpile('../market-data/use-market-data.ts'))(name => {
    if (name === './core') return marketCore;
    if (name === './client') return client;
    return {};
  }, session);
  const executor = {};
  new Function('require', 'exports', 'process', transpile('./executor.ts'))(name => {
    if (name === './core') return core;
    if (name === '../company-research/client') return companyClient;
    if (name === '../company-research/core') return companyCore;
    if (name === '../market-data/core') return marketCore;
    if (name === '../market-data/client') return client;
    if (name === '../market-data/use-market-data') return session;
    throw new Error(name);
  }, executor, { env: { EXPO_OS: platform } });
  return { ...executor, session };
}
const fedCommand = { name: 'market_query', arguments: { kind: 'news', topic: 'fed' } };
const rss = '<rss><channel><item><title>Federal Reserve statement</title><description>Public test statement</description><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261101a.htm</link><pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>';

test('repeated browser-restricted assistant queries remain capability limits without cooldown or cache reads', async () => {
  const api = runtime('web'); let reads = 0;
  const options = { signal: new AbortController().signal, transport: async () => { reads++; throw new Error('must not fetch a browser-restricted source'); } };
  for (const locale of ['zh', 'en']) {
    for (const command of [fedCommand, { name: 'market_query', arguments: { kind: 'filings', company: 'AAPL' } }]) {
      const first = await api.executeAppCommand(command, locale, options);
      const repeated = await api.executeAppCommand(command, locale, options);
      assert.equal(first.data.success, false);
      assert.equal(first.data.code, 'browser_unsupported');
      assert.equal(first.data.nextAllowedAt, null);
      assert.equal(repeated.text, first.text);
      assert.deepEqual(repeated.data, first.data);
      assert.doesNotMatch(repeated.text, /cooling down|冷却/);
      assert.match(repeated.text, locale === 'zh' ? /小Q App|官方来源/ : /Q app|official source/);
      assert.equal(first.actions[0].module, 'market-data');
      assert.deepEqual(first.actions[0].marketQuery, command.arguments);
      assert.doesNotThrow(() => core.validateAppNavigationAction(first.actions[0]));
    }
  }
  assert.equal(reads, 0);
  assert.equal(api.session.publicMemory.cache.size, 0);
  assert.equal(api.session.publicMemory.cooldowns.size, 0);
  // A result acquired before the platform restriction must not bypass it.
  const cached = { report: marketCore.parseFedReport(rss, fedCommand.arguments, new Date().toISOString()), expiresAt: Date.now() + 60_000 };
  api.session.publicMemory.cache.set('news:fed', cached);
  const result = await api.executeAppCommand(fedCommand, 'en', options);
  assert.equal(result.data.code, 'browser_unsupported');
  assert.equal(api.session.publicMemory.cache.get('news:fed'), cached);
  assert.equal(api.session.publicMemory.cooldowns.size, 0);
  assert.equal(reads, 0);
});

test('already-cancelled browser assistant queries keep cancellation ahead of the capability response', async () => {
  const api = runtime('web'); const controller = new AbortController(); controller.abort();
  await assert.rejects(api.executeAppCommand(fedCommand, 'en', { signal: controller.signal, transport: async () => { throw new Error('must not fetch'); } }), /CANCELLED/);
  assert.equal(api.session.publicMemory.cache.size, 0);
  assert.equal(api.session.publicMemory.cooldowns.size, 0);
});

test('public executor shares UI cache and returns real source text with valid click-only navigation', async () => {
  const api = runtime(); let reads = 0;
  const transport = async () => { reads++; return new Response(rss, { headers: { 'Content-Type': 'application/rss+xml' } }); };
  const first = await api.executeAppCommand(fedCommand, 'en', { signal: new AbortController().signal, transport });
  assert.match(first.text, /Federal Reserve statement/); assert.doesNotMatch(first.text, /Help me analyze|never my instructions/); assert.match(first.text, /2026-11-01 00:00:00 UTC/);
  assert.match(first.text, /federalreserve.gov/); assert.equal(first.actions[0].module, 'market-data');
  assert.doesNotThrow(() => core.validateAppNavigationAction(first.actions[0]));
  assert.ok(api.appResultContext(first).length <= 10000);
  await api.executeAppCommand(fedCommand, 'en', { signal: new AbortController().signal, transport });
  assert.equal(reads, 1); assert.equal(api.session.publicMemory.cache.size, 1);
  const local = await api.executeAppCommand({ name: 'insurance_search', arguments: { query: '宠物' } }, 'zh', { signal: new AbortController().signal, transport });
  assert.match(local.text, /宠物/); assert.equal(reads, 1);
});

test('public executor reports rate-limit failure, enforces shared cooldown, and cancels transfer', async () => {
  const api = runtime(); let reads = 0;
  const transport = async () => { reads++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); };
  const failed = await api.executeAppCommand(fedCommand, 'en', { signal: new AbortController().signal, transport });
  assert.equal(failed.data.success, false); assert.match(failed.text, /rate limited/);
  const cooled = await api.executeAppCommand(fedCommand, 'en', { signal: new AbortController().signal, transport });
  assert.match(cooled.text, /cooling down/); assert.equal(reads, 1);
  const isolated = runtime(); const controller = new AbortController(); let upstreamSignal;
  const pending = isolated.executeAppCommand(fedCommand, 'en', { signal: controller.signal, transport: async (_url, options) => {
    upstreamSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  } });
  controller.abort();
  await assert.rejects(pending, /CANCELLED/); assert.equal(upstreamSignal.aborted, true);
  assert.equal(isolated.session.publicMemory.cache.size, 0);
});

test('bounded bilingual GDELT results retain original sample totals and themes while omitting only whole records', async () => {
  const command = { name: 'market_query', arguments: { kind: 'news', topic: 'technology' } };
  const articles = Array.from({ length: 20 }, (_, index) => ({
    title: `Technology item ${index} ${'"\\'.repeat(100)}`,
    url: `https://news.example.com/article-${index}/${'p'.repeat(1400)}`,
    seendate: '20261101T000000Z',
  }));
  for (const locale of ['zh', 'en']) {
    const api = runtime();
    const result = await api.executeAppCommand(command, locale, {
      signal: new AbortController().signal,
      transport: async () => new Response(JSON.stringify({ articles }), { headers: { 'Content-Type': 'application/json' } }),
    });
    const available = [...api.session.publicMemory.cache.values()][0].report;
    assert.equal(available.records.length, 20, 'the complete cached source must never be replaced by its cropped view');
    assert.deepEqual(available.hotspots, [{ topic: 'technology', count: 20 }]);
    const included = [...result.text.matchAll(locale === 'zh' ? /^资料 (\d+)：/gm : /^Source item (\d+):/gm)].length;
    assert.ok(included > 0 && included < 20);
    assert.ok(result.text.includes(locale === 'zh'
      ? `本次完整返回样本共 20 条；本草稿纳入 ${included} 条。`
      : `The complete returned sample contains 20 records; this draft includes ${included}.`));
    assert.ok(result.text.includes(locale === 'zh'
      ? '主题计数基于本次完整返回样本的 20 条资料'
      : 'Topic counts use the complete returned sample of 20 records'));
    assert.ok(result.text.includes(locale === 'zh' ? '科技 20 条' : 'Technology 20'));
    assert.ok(result.text.includes(locale === 'zh' ? `已完整省略 ${20 - included} 条资料` : `${20 - included} whole records were omitted`));
    for (const record of available.records.slice(0, included)) {
      assert.ok(result.text.includes(record.title)); assert.ok(result.text.includes(record.url));
    }
    for (const record of available.records.slice(included)) {
      assert.equal(result.text.includes(record.title), false); assert.equal(result.text.includes(record.url), false);
    }
    assert.ok(result.text.includes(available.source.url));
    assert.doesNotMatch(result.text, /完整返回 \d+ 条资料；为模型上下文|The source returned/);
    assert.ok(JSON.stringify({ text: result.text }).length <= api.APP_RESULT_LIMIT);
    assert.ok(Array.from(api.appResultContext(result)).length <= api.APP_RESULT_LIMIT);
  }
});

test('global company executor preserves source identities and bounded public evidence', async () => {
  const api = runtime(); const requested = [];
  const transport = async (url, init) => {
    requested.push(url); assert.equal(init.credentials, 'omit'); assert.equal(init.headers.Authorization, undefined);
    const data = url.includes('company_tickers_exchange') ? { fields: ['cik','name','ticker','exchange'], data: [[1046179,'Taiwan Semiconductor','TSM','NYSE']] }
      : url.includes('/sparql?') ? { results: { bindings: [] } } : { search: [] };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await api.executeAppCommand({ name: 'company_search', arguments: { query: 'TSM' } }, 'en', { signal: new AbortController().signal, transport });
  assert.match(result.text, /sec:0001046179/); assert.match(result.text, /NYSE:TSM/);
  assert.equal(result.actions[0].module, 'market-data'); assert.ok(api.appResultContext(result).length <= 8000);
  assert.equal(requested.length, 3); assert.ok(requested.every(url => !url.includes('q.kaicloudpay.com')));
});
