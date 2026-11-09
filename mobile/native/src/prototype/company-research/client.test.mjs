import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/company-research/client.ts') && specifier === './core') return next('./core.ts', context);
  return next(specifier, context);
} });
const { searchCompanies, researchCompany, COMPANY_FACTS_LIMIT, COMPANY_ASSISTANT_SEARCH_TIMEOUT_MS, COMPANY_SEARCH_TIMEOUT_MS } = await import('./client.ts');
const { BROWSER_SEC_GAP, COMPANY_SEARCH_TIMEOUT_GAP, buildCompanyResearchText } = await import('./core.ts');
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

test('assistant lookup proceeds on a unique exact SEC candidate without waiting for unrelated global sources', async () => {
  const directory = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[123, 'Example Inc.', 'EX', 'NYSE'], [124, 'Example Services Corp', 'SERV', 'NYSE']] };
  for (const query of ['EX', 'Example', 'NYSE:EX']) {
    const calls = [];
    const transport = async url => {
      calls.push(url);
      assert.match(url, /www.sec.gov\/files\//, 'Wikidata must not be started after the exact match');
      return json(directory);
    };
    const report = await searchCompanies(query, { ...options(transport), purpose: 'assistant' });
    assert.equal(calls.length, 1); assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].issuerId, 'sec:0000000123');
    assert.equal(report.candidates[0].listings[0].status, 'unknown', 'directory matching must not assert current listing');
    assert.match(report.gaps.join(' '), /other public directories were not queried/);
  }
});

test('default global search and ambiguous or partial assistant matches still read the public candidate sources', async () => {
  for (const scenario of [
    { query: 'EX', purpose: undefined, rows: [[123, 'Example Inc.', 'EX', 'NYSE']] },
    { query: 'EX', purpose: 'assistant', rows: [[123, 'Example Inc.', 'EX', 'NYSE'], [124, 'Other Issuer', 'EX', 'Other']] },
    { query: 'Example Alias', purpose: 'assistant', rows: [[123, 'Example Inc.', 'EX', 'NYSE']] },
  ]) {
    const calls = [];
    const transport = async url => {
      calls.push(url);
      if (url.includes('sec.gov')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: scenario.rows });
      if (url.includes('/sparql')) return json({ results: { bindings: [] } });
      return json({ search: [] });
    };
    const report = await searchCompanies(scenario.query, { ...options(transport), purpose: scenario.purpose });
    assert.equal(calls.filter(url => url.includes('sec.gov')).length, 1, 'the directory is not reread after a partial result');
    assert.ok(calls.some(url => url.includes('www.wikidata.org/w/api.php')));
    assert.equal(report.candidates.length, scenario.rows.length);
    assert.doesNotMatch(report.gaps.join(' '), /other public directories were not queried/);
  }
});

test('assistant shortcut obeys cancellation and never bypasses the browser SEC restriction', async () => {
  const cancelled = new AbortController(); let reads = 0;
  await assert.rejects(searchCompanies('EX', { signal: cancelled.signal, purpose: 'assistant', transport: async () => {
    reads++; cancelled.abort(); return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[123, 'Example Inc.', 'EX', 'NYSE']] });
  } }), /cancelled/);
  assert.equal(reads, 1);
  const calls = [];
  const report = await searchCompanies('Example company', { ...options(async url => { calls.push(url); assert.equal(new URL(url).hostname, 'www.wikidata.org'); return json({ search: [] }); }), platform: 'web', purpose: 'assistant' });
  assert.equal(calls.length, 1); assert.equal(report.sources.find(source => source.source === 'sec-directory').status, 'not_read');
  assert.equal(report.candidates.length, 0);
});

const emptyDirectory = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [] };
const entitySearch = { search: Array.from({ length: 6 }, (_, index) => ({ id: `Q${index + 1}` })) };
const listedEntity = id => ({ entities: { [id]: { id, labels: { en: { value: `Company ${id}` } }, claims: { P414: [{ mainsnak: { datavalue: { value: { id: 'Q13677' } } }, qualifiers: { P249: [{ datavalue: { value: 'EX' } }] } }] } } } });
const settleTimers = () => new Promise(resolve => setImmediate(resolve));

test('assistant search shares a twenty-second deadline and returns successful partial data without starting later entity batches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 8) });
  const started = Date.now(), calls = [];
  const transport = async (url, init) => {
    calls.push({ url, signal: init.signal });
    if (url.includes('sec.gov')) return new Promise(() => {});
    if (url.includes('/w/api.php')) return json(entitySearch);
    if (url.includes('/sparql')) return json({ results: { bindings: [] } });
    if (url.endsWith('/Q1.json')) return json(listedEntity('Q1'));
    return new Promise(() => {});
  };
  let settled = false;
  const pending = searchCompanies('Alphabet', { ...options(transport), purpose: 'assistant' }).then(report => { settled = true; return report; });
  await settleTimers();
  for (let i = 0; !settled && i < 21; i++) { t.mock.timers.tick(1000); await settleTimers(); }
  assert.equal(settled, true);
  const report = await pending;
  assert.ok(Date.now() - started <= COMPANY_ASSISTANT_SEARCH_TIMEOUT_MS);
  assert.deepEqual(report.candidates.map(candidate => candidate.issuerId), ['wikidata:Q1']);
  assert.deepEqual(calls.filter(call => call.url.includes('EntityData')).map(call => call.url.split('/').at(-1)), ['Q1.json', 'Q2.json']);
  assert.ok(report.sources.some(source => source.source === 'wikidata-entity' && source.error === 'timeout'));
  assert.ok(report.gaps.includes(COMPANY_SEARCH_TIMEOUT_GAP));
  assert.ok(calls.every(call => call.signal.aborted), 'completed and timed-out transports release their controllers');
});

test('host queue delay consumes the same remaining search budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 8) });
  const calls = [];
  const transport = async url => {
    calls.push(url);
    if (url.includes('sec.gov')) return new Promise(resolve => setTimeout(() => resolve(json(emptyDirectory)), 11950));
    if (url.includes('/w/api.php')) return new Promise(resolve => setTimeout(() => resolve(json(entitySearch)), 8000));
    if (url.includes('/sparql')) return json({ results: { bindings: [] } });
    return new Promise(() => {});
  };
  const pending = searchCompanies('Alphabet', { ...options(transport), purpose: 'assistant' });
  await settleTimers(); t.mock.timers.tick(11950); await settleTimers();
  t.mock.timers.tick(8000); await settleTimers();
  assert.deepEqual(calls.filter(url => url.includes('EntityData')).map(url => url.split('/').at(-1)), ['Q1.json']);
  t.mock.timers.tick(50); await settleTimers();
  const report = await pending;
  assert.equal(report.candidates.length, 0);
  assert.ok(report.gaps.includes(COMPANY_SEARCH_TIMEOUT_GAP));
  assert.equal(calls.filter(url => url.includes('EntityData')).length, 1, 'no request starts after waiting past the shared deadline');
});

test('ordinary global searches also stop within their total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 8) });
  const started = Date.now(), calls = [];
  const transport = async (url, init) => {
    calls.push({ url, at: Date.now(), signal: init.signal });
    if (url.includes('sec.gov')) return json(emptyDirectory);
    if (url.includes('/w/api.php')) return new Promise(resolve => setTimeout(() => resolve(json(entitySearch)), 11000));
    return new Promise(() => {});
  };
  let settled = false;
  const pending = searchCompanies('Global company', options(transport)).then(report => { settled = true; return report; });
  await settleTimers();
  for (let i = 0; !settled && i < 46; i++) { t.mock.timers.tick(1000); await settleTimers(); }
  assert.equal(settled, true);
  const report = await pending;
  assert.ok(Date.now() - started <= COMPANY_SEARCH_TIMEOUT_MS);
  assert.ok(report.gaps.includes(COMPANY_SEARCH_TIMEOUT_GAP));
  assert.ok(calls.every(call => call.at - started < COMPANY_SEARCH_TIMEOUT_MS && call.signal.aborted));
});

test('external cancellation rejects a partially successful search instead of presenting it as completed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 8) });
  const controller = new AbortController(), calls = [];
  const transport = async (url, init) => {
    calls.push({ url, signal: init.signal });
    if (url.includes('sec.gov')) return json(emptyDirectory);
    if (url.includes('/w/api.php')) return json(entitySearch);
    if (url.endsWith('/Q1.json')) return json(listedEntity('Q1'));
    return new Promise(() => {});
  };
  const pending = searchCompanies('Global company', { signal: controller.signal, transport, purpose: 'assistant' });
  await settleTimers(); t.mock.timers.tick(1000); await settleTimers();
  const rejection = assert.rejects(pending, /cancelled/);
  controller.abort(); await rejection;
  assert.ok(calls.every(call => call.signal.aborted));
  assert.equal(calls.some(call => call.url.endsWith('/Q3.json')), false);
});
