import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes('/company-research/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? specifier + '.ts' : specifier, context);
} });
const { rememberCompanyResult, readCompanyResult, rememberCompanyFilingResult, readCompanyFilingResult, forgetCompanyFilingResult, clearCompanyResults } = await import('./handoff.ts');
test.after(() => hook.deregister());
test.beforeEach(() => clearCompanyResults());
test.afterEach(() => clearCompanyResults());
const issuer = 'sec:0001652044';
const candidate = { issuerId: issuer, name: 'Alphabet Inc.', source: 'sec', sourceUrl: 'https://www.sec.gov/files/company_tickers_exchange.json', cik: '0001652044', listings: [] };
const search = query => ({ kind: 'company-search', query, fetchedAt: '2026-11-08T14:00:00Z', candidates: [{ ...candidate }], sources: [], gaps: [] });
const research = () => ({ kind: 'company-research', issuerId: issuer, fetchedAt: '2026-11-08T14:00:00Z', company: { ...candidate }, facts: [], calculations: [], sources: [], gaps: [] });

test('query and issuer handoffs return the matching public result without exposing unrelated cached work', () => {
  rememberCompanyResult(search('GOOGL'));
  assert.equal(readCompanyResult({ query: ' googl ' }).query, 'GOOGL');
  assert.equal(readCompanyResult({ issuerId: issuer }).kind, 'company-search');
  rememberCompanyResult(research());
  assert.equal(readCompanyResult({ query: 'GOOGL', issuerId: issuer }).kind, 'company-research');
  assert.equal(readCompanyResult({ query: 'GOOGL', issuerId: 'sec:0000000001' }), null);
  assert.equal(readCompanyResult({ query: 'Toyota' }), null);
  assert.equal(readCompanyResult({ issuerId: 'http://private.test' }), null);
  assert.equal(readCompanyResult({}), null);
});

test('handoff entries expire after five minutes and reading does not extend their lifetime', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  rememberCompanyResult(search('GOOGL'));
  now += 5 * 60_000 - 1;
  assert.ok(readCompanyResult({ query: 'GOOGL' }));
  now++;
  assert.equal(readCompanyResult({ query: 'GOOGL' }), null);
  assert.equal(readCompanyResult({ issuerId: issuer }), null);
});

test('only eight results are retained and an explicit clear removes both search and research material', () => {
  for (let i = 0; i < 9; i++) rememberCompanyResult(search(`Company ${i}`));
  assert.equal(readCompanyResult({ query: 'Company 0' }), null);
  for (let i = 1; i < 9; i++) assert.ok(readCompanyResult({ query: `Company ${i}` }));
  rememberCompanyResult(research());
  assert.equal(readCompanyResult({ query: 'Company 1' }), null);
  clearCompanyResults();
  assert.equal(readCompanyResult({ query: 'Company 8' }), null);
  assert.equal(readCompanyResult({ issuerId: issuer }), null);
});

test('stored and returned reports are independent copies and preserve their original fetch time', () => {
  const source = search('GOOGL');
  rememberCompanyResult(source);
  source.candidates[0].name = 'CHANGED_SOURCE';
  const first = readCompanyResult({ query: 'GOOGL' });
  assert.equal(first.candidates[0].name, 'Alphabet Inc.');
  first.candidates[0].name = 'CHANGED_RETURN_VALUE';
  const second = readCompanyResult({ query: 'GOOGL' });
  assert.equal(second.candidates[0].name, 'Alphabet Inc.');
  assert.equal(second.fetchedAt, '2026-11-08T14:00:00Z');
});

const filing = { accession: '0001652044-26-000001', form: '10-K', filed_at: '2026-02-01', report_date: '2025-12-31', document_name: 'report.htm', document_url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000001/report.htm', format: 'html' };
const filingBase = { version: 1, issuer_id: issuer, cik: '0001652044', company_name: 'Alphabet Inc.', fetched_at: '2026-11-08T14:00:00Z' };
const catalog = () => ({ ...filingBase, filings: [filing], total: 1, truncated: false });
const document = () => ({ ...filingBase, filing, status: 'ready', sha256: 'a'.repeat(64), content_type: 'text/html', sections: [{ id: 's0000', title: 'Business', start_paragraph: 0 }], paragraphs: [{ id: 'p000000', text: 'A verified source paragraph.', kind: 'text', section_id: 's0000', source_url: filing.document_url }], offset: 0, next_offset: null, total_paragraphs: 1, truncated: false, limitations: [] });

test('filing handoffs keep the exact issuer and accession without fabricating a financial overview', () => {
  rememberCompanyFilingResult(catalog());
  rememberCompanyFilingResult(document());
  assert.deepEqual(readCompanyFilingResult({ issuerId: issuer }), catalog());
  const result = readCompanyFilingResult({ issuerId: issuer, accession: filing.accession });
  assert.equal(result.sha256, 'a'.repeat(64));
  assert.equal(result.paragraphs[0].source_url, filing.document_url);
  assert.equal(readCompanyResult({ issuerId: issuer }), null, 'a filing is not annual XBRL data');
  assert.equal(readCompanyFilingResult({ issuerId: 'sec:0000000001', accession: filing.accession }), null);
  assert.equal(readCompanyFilingResult({ issuerId: issuer, accession: '0001652044-26-000002' }), null);
  result.paragraphs[0].text = 'MUTATED';
  assert.equal(readCompanyFilingResult({ issuerId: issuer, accession: filing.accession }).paragraphs[0].text, 'A verified source paragraph.');
  forgetCompanyFilingResult({ issuerId: issuer, accession: filing.accession });
  assert.equal(readCompanyFilingResult({ issuerId: issuer, accession: filing.accession }), null);
  assert.ok(readCompanyFilingResult({ issuerId: issuer }));
});

test('company and filing handoffs share the eight-result bound, expiry and identity clearing', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 7; i++) rememberCompanyResult(search(`Company ${i}`));
  rememberCompanyFilingResult(catalog());
  rememberCompanyFilingResult(document());
  assert.equal(readCompanyResult({ query: 'Company 0' }), null);
  assert.ok(readCompanyResult({ query: 'Company 1' }));
  assert.ok(readCompanyFilingResult({ issuerId: issuer }));
  assert.ok(readCompanyFilingResult({ issuerId: issuer, accession: filing.accession }));
  now += 5 * 60_000;
  assert.equal(readCompanyFilingResult({ issuerId: issuer }), null);
  assert.equal(readCompanyFilingResult({ issuerId: issuer, accession: filing.accession }), null);
  rememberCompanyFilingResult(catalog()); rememberCompanyFilingResult(document());
  clearCompanyResults();
  assert.equal(readCompanyFilingResult({ issuerId: issuer }), null);
  assert.equal(readCompanyFilingResult({ issuerId: issuer, accession: filing.accession }), null);
});
