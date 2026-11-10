import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, parseEntity, parseSubmissions, parseFinancialFacts, calculateFacts, buildCompanyResearchText, buildCompanyResearchSummary, isExactCompanyCandidate, validateIssuerId, validateCompanyQuery, COMPANY_SEARCH_TIMEOUT_GAP } from './core.ts';

const snak = value => ({ datavalue: { value } });
const listingTime = (time, precision = 11) => ({ time, precision, timezone: 0, before: 0, after: 0, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' });
const entity = (extra = {}) => ({ entities: { Q1: { id: 'Q1', labels: { en: { value: 'Example Inc.' } }, claims: {
  P414: [{ rank: 'normal', mainsnak: snak({ id: 'Q13677' }), qualifiers: { P249: [snak('EX')] } }],
  P5531: [{ rank: 'normal', mainsnak: snak('123') }], ...extra,
} } } });
const accession = '0000000123-25-000001';
const recent = { cik: 123, name: 'Example Inc.', tickers: ['EX'], exchanges: ['NYSE'], filings: { recent: { form: ['10-K'], accessionNumber: [accession], reportDate: ['2024-12-31'] } } };
const fact = (value, start = '2024-01-01', end = '2024-12-31', extra = {}) => ({ val: value, start, end, filed: '2025-02-01', form: '10-K', accn: accession, fp: 'FY', ...extra });
const financials = (revenue, profit = []) => ({ cik: 123, facts: { 'us-gaap': { Revenues: { units: { USD: revenue } }, NetIncomeLoss: { units: { USD: profit } } } } });

test('identifiers and queries reject control characters, malformed IDs and URL input as IDs', () => {
  assert.ok(validateIssuerId('sec:0000000123')); assert.ok(validateIssuerId('wikidata:Q53268'));
  for (const id of ['sec:123', 'wikidata:Q0', 'https://internal', 'sec:0000000123/../']) assert.equal(validateIssuerId(id), false);
  assert.equal(validateCompanyQuery('EX\nmalicious'), false); assert.equal(validateCompanyQuery(' '), false);
  assert.equal(validateIssuerId('sec:0000000000'), false);
  assert.equal(validateCompanyQuery('😀'.repeat(120)), true); assert.equal(validateCompanyQuery('😀'.repeat(121)), false);
  assert.equal(validateCompanyQuery('\ud800'), false);
});
test('SEC full directory searches beyond samples, retains issuer/listing identity and exchange qualification', () => {
  const data = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[123, 'Example Inc.', 'EX', 'NYSE'], [124, 'Unrelated Co', 'EX', 'Other'], [123, 'Example Inc.', 'EX.B', 'NYSE']] };
  assert.equal(parseDirectory(data, 'EX').length, 2);
  assert.equal(parseDirectory(data, 'NYSE:EX')[0].issuerId, 'sec:0000000123');
  assert.equal(parseDirectory(data, 'Example')[0].listings.length, 2);
});
test('Wikidata parses qualifier tickers, deprecated and historical listings, rejects wrong entity', () => {
  const d = entity(); const claims = d.entities.Q1.claims;
  claims.P414.push({ rank: 'deprecated', mainsnak: snak({ id: 'Q2' }), qualifiers: { P249: [snak('BAD')] } });
  claims.P414.push({ rank: 'normal', mainsnak: snak({ id: 'Q3' }), qualifiers: { P249: [snak('OLD')], P582: [snak(listingTime('+2020-01-01T00:00:00Z'))] } });
  const result = parseEntity(d, 'Q1');
  assert.equal(result.candidate.cik, '0000000123'); assert.deepEqual(result.candidate.listings.map(x => [x.ticker, x.status]), [['EX', 'unknown'], ['OLD', 'historical']]);
  assert.throws(() => parseEntity(d, 'Q2'));
});
test('listing end dates require elapsed valid Gregorian intervals; future or malformed ends remain unknown', () => {
  for (const [value, expected] of [
    [listingTime('+2000-00-00T00:00:00Z', 9), 'historical'],
    [listingTime('+2000-02-00T00:00:00Z', 10), 'historical'],
    [listingTime('+2999-01-01T00:00:00Z'), 'unknown'],
    [listingTime('+2000-02-30T00:00:00Z'), 'unknown'],
    [listingTime('+2000-00-00T00:00:00Z', 11), 'unknown'],
    [{ time: '+2000-01-01T00:00:00Z' }, 'unknown'],
    [{ ...listingTime('+2000-01-01T00:00:00Z'), precision: 8 }, 'unknown'],
    [{ ...listingTime('+2000-01-01T00:00:00Z'), after: 1 }, 'unknown'],
    [{ ...listingTime('+2000-01-01T00:00:00Z'), calendarmodel: 'http://www.wikidata.org/entity/Q1985786' }, 'unknown'],
  ]) {
    const data = entity(); data.entities.Q1.claims.P414[0].qualifiers.P582 = [snak(value)];
    assert.equal(parseEntity(data, 'Q1').candidate.listings[0].status, expected);
  }
});
test('future listing starts are excluded only when their date and precision are validated', () => {
  for (const [value, count] of [
    [listingTime('+2999-00-00T00:00:00Z', 9), 0],
    [listingTime('+2999-02-00T00:00:00Z', 10), 0],
    [listingTime('+2999-01-01T00:00:00Z'), 0],
    [listingTime('+2999-02-30T00:00:00Z'), 1],
    [{ time: '+2999-01-01T00:00:00Z' }, 1],
    [{ ...listingTime('+2999-01-01T00:00:00Z'), precision: 8 }, 1],
  ]) {
    const data = entity(); data.entities.Q1.claims.P414[0].qualifiers.P580 = [snak(value)];
    assert.equal(parseEntity(data, 'Q1').candidate.listings.length, count);
  }
});
test('multiple CIK claims are ambiguous and an unrelated mapping cannot fetch financials', () => {
  const d = entity({ P5531: [{ mainsnak: snak('123') }, { mainsnak: snak('456') }] });
  assert.equal(parseEntity(d, 'Q1').candidate.cik, null);
  assert.throws(() => parseSubmissions({ ...recent, name: 'Another Corp', tickers: ['BAD'] }, '0000000123', parseEntity(entity(), 'Q1')), /identity_mismatch/);
  assert.throws(() => parseSubmissions({ ...recent, name: 'Another Corp', tickers: ['EX'], exchanges: ['Other'] }, '0000000123', parseEntity(entity(), 'Q1')), /identity_mismatch/);
  assert.throws(() => parseSubmissions({ ...recent, cik: 456 }, '0000000123'), /identity_mismatch/);
});
test('annual extraction rejects FY quarter, unverified accession and nonfinite facts; computes matched annual pairs', () => {
  const data = financials([fact(120), fact(100, '2023-01-01', '2023-12-31'), fact(999, '2024-10-01'), fact(998, undefined, undefined, { accn: '0000000123-25-000002' }), fact(Infinity)], [fact(12)]);
  const facts = parseFinancialFacts(data, '0000000123', recent);
  assert.deepEqual(facts.filter(f => f.metric === 'revenue').map(f => f.value), [120, 100]);
  const values = calculateFacts(facts); assert.ok(Math.abs(values[0].value - 20) < 0.00001); assert.equal(values[1].value, 10);
  assert.equal(facts[0].accession, accession); assert.equal(facts[0].taxonomy, 'us-gaap');
});
test('different currency, tag, filing, annual duration and nonpositive denominator do not create growth', () => {
  const facts = parseFinancialFacts(financials([fact(120), fact(100, '2023-01-01', '2023-12-31')]), '0000000123', recent);
  for (const patch of [{ unit: 'JPY' }, { tag: 'Revenue' }, { accession: '0000000123-24-000001' }, { start: '2023-02-01' }, { value: 0 }, { value: -5 }]) {
    assert.equal(calculateFacts([facts[0], { ...facts[1], ...patch }])[0].value, null);
  }
});
test('IFRS foreign annual filings work and instant values require annual report dates', () => {
  const sub = { ...recent, filings: { recent: { ...recent.filings.recent, form: ['20-F'] } } };
  const data = { cik: 123, facts: { 'ifrs-full': { Revenue: { units: { JPY: [fact(150, undefined, undefined, { form: '20-F' })] } }, Assets: { units: { JPY: [{ ...fact(300), start: undefined, form: '20-F' }, { ...fact(999), start: undefined, end: '2024-09-30', form: '20-F' }] } } } } };
  const facts = parseFinancialFacts(data, '0000000123', sub);
  assert.deepEqual(facts.map(f => f.value), [150, 300]); assert.equal(facts[0].taxonomy, 'ifrs-full');
});
test('research text preserves coverage and provenance and remains within escaped JSON budget', () => {
  const report = { kind: 'company-search', query: 'Example', fetchedAt: '2026-11-02', sources: [], gaps: ['Financial coverage unavailable'], candidates: Array.from({ length: 100 }, () => ({ issuerId: 'sec:0000000123', name: 'Name'.repeat(50), listings: [], sourceUrl: 'https://www.sec.gov/' })) };
  for (const locale of ['zh', 'en']) { const text = buildCompanyResearchText(report, locale); assert.ok(JSON.stringify({ text }).length <= 7500); assert.match(text, /coverage unavailable/); assert.match(text, /sec:0000000123/); }
});


test('exact ticker matches precede partial company names before the candidate cap', () => {
  const data = { fields: ['cik','name','ticker','exchange'], data: [...Array.from({ length: 15 }, (_, i) => [i + 1, `Sportsman TSM company ${i}`, `X${i}`, 'NYSE']), [1046179, 'Taiwan Semiconductor', 'TSM', 'NYSE']] };
  const result = parseDirectory(data, 'TSM');
  assert.equal(result.length, 12);
  assert.equal(result[0].issuerId, 'sec:0001046179');
});

test('composite company names and name/ticker queries find bounded candidates without merging issuer identities', () => {
  const data = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [
    [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'], [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
    [123, 'Bank of America Corp', 'BAC', 'NYSE'], [124, 'Different Bank Corp', 'DB', 'NYSE'], [125, 'America Holdings', 'AH', 'NYSE'],
    [126, 'Different Alphabet Co', 'GOOGL', 'Other'],
  ] };
  const alternative = parseDirectory(data, 'Alphabet Google');
  assert.deepEqual(alternative.map(item => item.issuerId), ['sec:0001652044', 'sec:0000000126']);
  assert.equal(alternative[0].listings.length, 2);
  assert.deepEqual(parseDirectory(data, 'Alphabet GOOGL').map(item => item.issuerId), ['sec:0001652044', 'sec:0000000126']);
  assert.deepEqual(parseDirectory(data, 'Bank America').map(item => item.issuerId), ['sec:0000000123']);
  assert.deepEqual(parseDirectory(data, 'Bank of America').map(item => item.issuerId), ['sec:0000000123']);
  assert.deepEqual(parseDirectory(data, 'Missing:GOOGL'), []);
  assert.equal(parseDirectory(data, 'Nasdaq:GOOGL')[0].issuerId, 'sec:0001652044');
  assert.equal(parseDirectory(data, 'GOOGL').length, 2);
  assert.equal(isExactCompanyCandidate(alternative[0], 'Alphabet'), true);
  assert.equal(isExactCompanyCandidate(alternative[0], 'Alphabet Google'), false);
  assert.equal(isExactCompanyCandidate(alternative[0], 'Other:GOOGL'), false);
});

test('the candidate cap cannot make multiple exact names look like a single exact match', () => {
  const data = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [
    ...Array.from({ length: 20 }, (_, index) => [100 + index, `Example A${index} Services`, `OTH${index}`, 'NYSE']),
    [123, 'Example Inc.', 'EX', 'NYSE'], [124, 'Example Co', 'EX2', 'Other'],
  ] };
  const candidates = parseDirectory(data, 'Example');
  assert.equal(candidates.length, 12);
  assert.equal(candidates.filter(candidate => isExactCompanyCandidate(candidate, 'Example')).length, 2);
  assert.deepEqual(new Set(candidates.slice(0, 2).map(candidate => candidate.issuerId)), new Set(['sec:0000000123', 'sec:0000000124']));
});

const summaryCompany = { issuerId: 'sec:0000000123', name: 'Example Inc.', source: 'sec', sourceUrl: 'https://www.sec.gov/files/company_tickers_exchange.json', cik: '0000000123', listings: [{ exchange: 'NYSE', ticker: 'EX', status: 'unknown', sourceUrl: 'https://www.sec.gov/' }] };
const searchReport = candidates => ({ kind: 'company-search', query: 'Example', fetchedAt: '2026-11-08T00:00:00Z', sources: [{ source: 'sec-directory', status: 'available', url: 'https://www.sec.gov/' }], gaps: [], candidates });
const researchReport = facts => ({ kind: 'company-research', issuerId: summaryCompany.issuerId, company: summaryCompany, fetchedAt: '2026-11-08T00:00:00Z', sources: [{ source: 'sec-facts', status: 'available', url: 'https://data.sec.gov/' }], gaps: [], facts, calculations: calculateFacts(facts) });

test('search summaries distinguish candidates from financial analysis and keep source IDs out of chat', () => {
  for (const locale of ['zh', 'en']) {
    const one = buildCompanyResearchSummary(searchReport([summaryCompany]), locale);
    assert.match(one, /Example Inc\./); assert.match(one, /NYSE/); assert.match(one, /EX/);
    assert.match(one, locale === 'zh' ? /尚未读取财报/ : /not been read/);
    const uncertain = { ...summaryCompany, issuerId: 'wikidata:Q1', source: 'wikidata', listings: [{ exchange: 'Q13677', ticker: 'EX', status: 'unknown', sourceUrl: 'https://www.wikidata.org/wiki/Q1' }] };
    const multiple = buildCompanyResearchSummary(searchReport([summaryCompany, uncertain]), locale);
    assert.match(multiple, locale === 'zh' ? /请先确认/ : /Confirm/);
    for (const text of [one, multiple]) assert.doesNotMatch(text, /https?:|sec:|wikidata:|Q13677|unknown|available|查询参数/);
    assert.equal((multiple.match(/Example Inc\./g) ?? []).length, 2, 'distinct candidates must remain distinct');
  }
  const failed = searchReport([]); failed.sources.push({ source: 'wikidata-search', status: 'error', error: 'http_403', url: 'https://www.wikidata.org/' });
  assert.match(buildCompanyResearchSummary(failed, 'zh'), /部分公开来源暂时不可用/);
  assert.doesNotMatch(buildCompanyResearchSummary(failed, 'zh'), /http_403|403/);
  assert.doesNotMatch(buildCompanyResearchSummary(searchReport([]), 'en'), /sources are unavailable/);
  const historical = { ...summaryCompany, listings: summaryCompany.listings.map(listing => ({ ...listing, status: 'historical' })) };
  assert.match(buildCompanyResearchSummary(searchReport([historical]), 'zh'), /历史上市记录/);
});

test('financial summaries use retrieved periods, units and calculations instead of raw evidence metadata', () => {
  const extracted = parseFinancialFacts(financials([fact(120000000), fact(100000000, '2023-01-01', '2023-12-31')], [fact(12000000)]), '0000000123', recent);
  const report = researchReport(extracted);
  const zh = buildCompanyResearchSummary(report, 'zh');
  assert.match(zh, /2024-01-01 — 2024-12-31，USD/);
  assert.match(zh, /营业收入 1\.2 亿/); assert.match(zh, /净利润 1,200 万/);
  assert.match(zh, /营收同比 20%/); assert.match(zh, /净利率 10%/);
  assert.match(zh, /部分指标尚未取得/); assert.match(zh, /不包含年报全文/);
  const en = buildCompanyResearchSummary(report, 'en');
  assert.match(en, /Revenue 120 million/); assert.match(en, /Net income 12 million/);
  for (const summary of [zh, en]) {
    assert.doesNotMatch(summary, /https?:|sec:|us-gaap|Revenues|NetIncomeLoss|0000000123|unverified/);
    assert.ok(summary.length < 700);
  }
  assert.match(buildCompanyResearchText(report, 'en'), /us-gaap:Revenues/);
  assert.match(buildCompanyResearchText(report, 'en'), /https:\/\/www.sec.gov\//);
});

test('financial summaries do not mix incompatible periods, currencies or filings or turn missing figures into zero', () => {
  const [revenue] = parseFinancialFacts(financials([fact(120)]), '0000000123', recent);
  for (const patch of [{ unit: 'JPY' }, { start: '2023-01-01', end: '2023-12-31' }, { accession: '0000000123-24-000001' }, { taxonomy: 'ifrs-full' }]) {
    const report = researchReport([revenue, { ...revenue, metric: 'net_income', value: 999, ...patch }]);
    const text = buildCompanyResearchSummary(report, 'en');
    assert.match(text, /Revenue 120/); assert.doesNotMatch(text, /999|Net income|Net margin|0%/);
    assert.match(text, /Some figures/);
  }
  const noCoverage = researchReport([]); noCoverage.gaps = ['No unique SEC CIK mapping; this issuer’s financial reports are not connected.'];
  assert.match(buildCompanyResearchSummary(noCoverage, 'zh'), /尚未接入/);
  const failed = researchReport([]); failed.sources = [{ source: 'sec-facts', status: 'error', error: 'timeout', url: 'https://data.sec.gov/' }];
  assert.match(buildCompanyResearchSummary(failed, 'zh'), /暂时不可用/);
  assert.doesNotMatch(buildCompanyResearchSummary(failed, 'zh'), /timeout|https:/);
  const browser = { ...failed, company: null, sources: [{ source: 'sec-submissions', status: 'not_read', url: 'https://data.sec.gov/' }] };
  assert.match(buildCompanyResearchSummary(browser, 'zh'), /网页无法直接读取/);
  assert.doesNotMatch(buildCompanyResearchSummary(browser, 'zh'), /暂时不可用/);
  const mismatch = { ...failed, company: null, sources: [{ source: 'sec-submissions', status: 'error', error: 'identity_mismatch', url: 'https://data.sec.gov/' }] };
  assert.match(buildCompanyResearchSummary(mismatch, 'en'), /records did not match/);
  assert.doesNotMatch(buildCompanyResearchSummary(mismatch, 'en'), /temporarily unavailable|identity_mismatch/);
});

test('company evidence puts real records first and keeps complete citations without copying transport diagnostics', () => {
  const facts = parseFinancialFacts(financials([fact(120), fact(100, '2023-01-01', '2023-12-31')], [fact(12)]), '0000000123', recent);
  const report = researchReport(facts);
  report.gaps.push('Financial overview uses standard whole-entity XBRL facts, not the full annual-report narrative or custom tags.');
  report.sources.push(...Array.from({ length: 6 }, (_, i) => ({ source: 'wikidata-entity', status: 'error', error: 'http_403', url: `https://www.wikidata.org/wiki/Special:EntityData/Q${i + 1}.json?transport=${'x'.repeat(1000)}` })));
  const original = structuredClone(report);
  const text = buildCompanyResearchText(report, 'en');
  assert.ok(text.indexOf('revenue:') < text.indexOf('Scope:'));
  assert.match(text, /2024-01-01 → 2024-12-31/); assert.match(text, /120 USD/);
  assert.match(text, /us-gaap:Revenues/); assert.match(text, new RegExp(`accession ${accession}`));
  assert.match(text, /source restricted access/); assert.match(text, /not independently verified/);
  assert.doesNotMatch(text, /http_403|Special:EntityData|transport=/);
  const url = facts[0].sourceUrl;
  assert.equal(text.split(url).length - 1, 1, 'identical source citations are not repeated for every metric');
  assert.deepEqual(report, original, 'the complete original diagnostics remain available to the detailed page');
  assert.ok(JSON.stringify({ text }).length <= 7500);
});

test('bounded evidence and search summaries explicitly retain timeout and incomplete-listing semantics', () => {
  const candidate = { ...summaryCompany, issuerId: 'wikidata:Q1', source: 'wikidata', listings: [{ exchange: 'Q13677', ticker: 'EX', status: 'unknown', sourceUrl: 'https://www.wikidata.org/wiki/Q1' }] };
  const report = searchReport([candidate]); report.gaps.push(COMPANY_SEARCH_TIMEOUT_GAP);
  report.sources.push({ source: 'wikidata-entity', status: 'error', error: 'timeout', url: 'https://www.wikidata.org/wiki/Special:EntityData/Q2.json' });
  const text = buildCompanyResearchText(report, 'en');
  assert.ok(text.indexOf('wikidata:Q1') < text.indexOf('Scope:'));
  assert.match(text, /current listing status are not independently verified/);
  assert.match(text, /exchange name unverified:EX/); assert.match(text, /search time limit/);
  assert.doesNotMatch(text, /Q13677|\(unknown\)|wikidata-entity:/);
  assert.match(buildCompanyResearchSummary(report, 'zh'), /已取得的部分结果/);
  const noResult = searchReport([]); noResult.gaps.push(COMPANY_SEARCH_TIMEOUT_GAP);
  assert.match(buildCompanyResearchSummary(noResult, 'en'), /search timed out/);
  const largeNotes = { ...report, gaps: [COMPANY_SEARCH_TIMEOUT_GAP, 'Unusually long scope note '.repeat(1000)] };
  const bounded = buildCompanyResearchText(largeNotes, 'en');
  assert.ok(JSON.stringify({ text: bounded }).length <= 7500);
  assert.match(bounded, /wikidata:Q1/); assert.match(bounded, /scope details are not included/);
});
