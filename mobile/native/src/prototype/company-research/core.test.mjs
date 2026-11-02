import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, parseEntity, parseSubmissions, parseFinancialFacts, calculateFacts, buildCompanyResearchText, validateIssuerId, validateCompanyQuery } from './core.ts';

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
