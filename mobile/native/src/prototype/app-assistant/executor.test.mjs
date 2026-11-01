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
test.after(() => resolver.deregister());
const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function runtime() {
  const session = {};
  new Function('require', 'exports', transpile('../market-data/use-market-data.ts'))(name => {
    if (name === './core') return marketCore;
    if (name === './client') return client;
    return {};
  }, session);
  const executor = {};
  new Function('require', 'exports', transpile('./executor.ts'))(name => {
    if (name === './core') return core;
    if (name === '../market-data/core') return marketCore;
    if (name === '../market-data/client') return client;
    if (name === '../market-data/use-market-data') return session;
    throw new Error(name);
  }, executor);
  return { ...executor, session };
}
const fedCommand = { name: 'market_query', arguments: { kind: 'news', topic: 'fed' } };
const rss = '<rss><channel><item><title>Federal Reserve statement</title><description>Public test statement</description><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261101a.htm</link><pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>';

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
