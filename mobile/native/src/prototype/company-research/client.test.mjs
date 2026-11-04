import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/company-research/client.ts') && specifier === './core') return next('./core.ts', context);
  return next(specifier, context);
} });
const { searchCompanies, researchCompany, COMPANY_FACTS_LIMIT } = await import('./client.ts');
const { BROWSER_SEC_GAP, buildCompanyResearchText } = await import('./core.ts');
test.after(() => resolver.deregister());
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const options = transport => ({ signal: new AbortController().signal, transport });
const accession = '0000000123-25-000001';
const submissions = { cik: 123, name: 'Example Inc.', tickers: ['EX'], exchanges: ['NYSE'], filings: { recent: { form: ['10-K'], accessionNumber: [accession], reportDate: ['2024-12-31'] } } };
const facts = { cik: 123, facts: { 'us-gaap': { Revenues: { units: { USD: [{ val: 120, start: '2024-01-01', end: '2024-12-31', filed: '2025-02-01', form: '10-K', accn: accession }] } } } } };
test('browser fetch transport keeps its receiver contract across identity and facts reads', async () => {
  const calls = [];
  async function browserFetch(url, init) {
    // Window.fetch rejects an unrelated object as its receiver.
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push(url);
    assert.equal(init.credentials, 'omit');
    return json(url.includes('/submissions/') ? submissions : facts);
  }
  const report = await researchCompany('sec:0000000123', options(browserFetch));
  assert.equal(calls.length, 2);
  assert.equal(report.company?.name, 'Example Inc.');
  assert.equal(report.facts[0]?.value, 120);
  assert.ok(report.sources.every(source => source.status === 'available'));
});
test('browser company search reads Wikidata and reports SEC as not requested rather than empty or failed', async () => {
  const calls = [];
  const report = await searchCompanies('Example Inc', { ...options(async (url, init) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, 'www.wikidata.org');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    if (url.includes('api.php')) return json({ search: [{ id: 'Q1' }] });
    return json({ entities: { Q1: { id: 'Q1', labels: { en: { value: 'Example Inc.' } }, claims: { P414: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } }, qualifiers: { P249: [{ datavalue: { value: 'EX' } }] } }] } } } });
  }), platform: 'web' });
  assert.equal(calls.length, 2);
  assert.equal(report.candidates[0]?.name, 'Example Inc.');
  assert.equal(report.sources.find(source => source.source === 'sec-directory')?.status, 'not_read');
  assert.ok(report.sources.filter(source => source.source.startsWith('wikidata')).every(source => source.status === 'available'));
  assert.ok(report.gaps.includes(BROWSER_SEC_GAP));
  assert.match(buildCompanyResearchText(report, 'en'), /SEC data was not requested/);
});
test('browser financial research never requests blocked SEC data or invents annual facts', async () => {
  let calls = 0;
  const report = await researchCompany('sec:0000000123', { ...options(async () => { calls++; throw new Error('must not request SEC in browser'); }), platform: 'web' });
  assert.equal(calls, 0);
  assert.equal(report.sources[0]?.status, 'not_read');
  assert.equal(report.company, null);
  assert.deepEqual(report.facts, []);
  assert.ok(report.gaps.includes(BROWSER_SEC_GAP));
});
test('browser Wikidata network failures remain failures alongside the explicit SEC restriction', async () => {
  const report = await searchCompanies('Example Inc', { ...options(async () => { throw new Error('PUBLIC_NETWORK_FAILURE'); }), platform: 'web' });
  assert.equal(report.sources.find(source => source.source === 'sec-directory')?.status, 'not_read');
  assert.equal(report.sources.find(source => source.source === 'wikidata-search')?.status, 'error');
  assert.equal(report.sources.find(source => source.source === 'wikidata-search')?.error, 'network');
});
test('source failure is distinct from an empty search, fixed anonymous requests never retry', async () => {
  const calls = [];
  const report = await searchCompanies('Example Inc', options(async (url, init) => {
    calls.push(url); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, undefined);
    if (url.includes('sec.gov')) return json({}, 403); return json({ search: [] });
  }));
  assert.equal(calls.length, 2); assert.equal(report.candidates.length, 0);
  assert.ok(report.sources.some(s => s.error === 'http_403')); assert.ok(report.sources.some(s => s.status === 'available'));
});
test('exact ticker query uses bounded SPARQL and requires validated entity listings', async () => {
  const report = await searchCompanies('7203', options(async url => {
    if (url.includes('sec.gov')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [] });
    if (url.includes('sparql')) { assert.match(decodeURIComponent(url), /pq:P249 "7203"/); assert.match(decodeURIComponent(url), /LIMIT 6/); return json({ results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q1' } }] } }); }
    if (url.includes('api.php')) return json({ search: [] });
    return json({ entities: { Q1: { id: 'Q1', labels: { en: { value: 'Not listed' } }, claims: {} } } });
  }));
  assert.equal(report.candidates.length, 0); assert.ok(report.sources.some(s => s.source === 'wikidata-ticker' && s.status === 'available'));
});
test('SEC research reads identity then facts, never a directory or arbitrary document', async () => {
  const calls = [];
  const report = await researchCompany('sec:0000000123', options(async url => { calls.push(url); return json(url.includes('/submissions/') ? submissions : facts); }));
  assert.equal(calls.length, 2); assert.equal(report.company.name, 'Example Inc.'); assert.equal(report.facts[0].value, 120);
  assert.ok(report.facts[0].sourceUrl.startsWith('https://www.sec.gov/Archives/')); assert.equal(report.calculations[0].value, null);
});
test('wrong submissions identity prevents facts call', async () => {
  let calls = 0; const report = await researchCompany('sec:0000000123', options(async () => { calls++; return json({ ...submissions, cik: 456 }); }));
  assert.equal(calls, 1); assert.equal(report.facts.length, 0); assert.equal(report.sources[0].error, 'identity_mismatch');
});
test('Wikidata without CIK returns an explicit coverage gap and no SEC request', async () => {
  let calls = 0; const report = await researchCompany('wikidata:Q1', options(async () => { calls++; return json({ entities: { Q1: { id: 'Q1', labels: { en: { value: 'Example' } }, claims: { P414: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } }, qualifiers: { P249: [{ datavalue: { value: 'EX' } }] } }] } } } }); }));
  assert.equal(calls, 1); assert.match(report.gaps.join(' '), /No unique SEC CIK/); assert.deepEqual(report.facts, []);
});
test('oversize, rate limit and redirect responses remain explicit failures', async () => {
  for (const [response, expected] of [[new Response('', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(COMPANY_FACTS_LIMIT + 1) } }), 'too_large'], [json({}, 429), 'rate_limited'], [new Response('', { status: 302 }), 'redirect']]) {
    const report = await researchCompany('sec:0000000123', options(async url => url.includes('/submissions/') ? json(submissions) : response));
    assert.equal(report.sources.at(-1).error, expected); assert.deepEqual(report.facts, []);
  }
});
test('already aborted and ignored transport cancellation reject without continuing', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(researchCompany('sec:0000000123', { signal: controller.signal, transport: () => { throw new Error('must not call'); } }), /cancelled/);
  const pending = new AbortController(); let calls = 0;
  const run = researchCompany('sec:0000000123', { signal: pending.signal, transport: async () => { calls++; return new Promise(() => {}); } });
  await new Promise(resolve => setImmediate(resolve));
  pending.abort(); await assert.rejects(run, /cancelled/); assert.equal(calls, 1);
});
test('429 cooldown applies across new user requests sharing a transport without retrying', async () => {
  let calls = 0;
  const transport = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '120' } }); };
  const first = await researchCompany('sec:0000000123', options(transport));
  const second = await researchCompany('sec:0000000124', options(transport));
  assert.equal(calls, 1); assert.equal(first.sources[0].error, 'rate_limited'); assert.equal(second.sources[0].error, 'rate_limited');
});
