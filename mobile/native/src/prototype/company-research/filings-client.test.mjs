import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (/\/filings-(core|client)\.ts$/.test(context.parentURL ?? '') && specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { listCompanyFilings, readCompanyFiling, FILING_RESPONSE_LIMIT } = await import('./filings-client.ts');
test.after(() => hooks.deregister());
const issuer = 'sec:0000320193', accession = '0000320193-26-000026';
const url = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm';
const base = { version: 1, issuer_id: issuer, cik: '0000320193', company_name: 'Apple Inc.', fetched_at: '2026-11-08T00:00:00Z' };
const filing = { accession, form: '10-K', filed_at: '2026-11-03', report_date: '2026-09-26', document_name: 'aapl-20260926.htm', document_url: url, format: 'html' };
const catalog = { ...base, filings: [filing], total: 1, truncated: false };
const doc = { ...base, filing, status: 'ready', sha256: 'a'.repeat(64), content_type: 'text/html', sections: [{ id: 's0000', title: 'Document text', start_paragraph: 0 }], paragraphs: [{ id: 'p000001', text: 'Source paragraph.', kind: 'text', section_id: 's0000', source_url: url }], offset: 1, next_offset: null, total_paragraphs: 2, truncated: false, limitations: [] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const options = transport => ({ transport, signal: new AbortController().signal });

test('filing requests use fixed Q public paths and never forward identity credentials', async () => {
  let calls = 0;
  async function transport(requestUrl, init) {
    assert.equal(this, undefined);calls++;
    assert.equal(init.credentials, 'omit');assert.equal(init.redirect, 'error');assert.equal(init.headers.Authorization, undefined);
    const request = new URL(requestUrl);assert.equal(request.origin, 'https://q.kaicloudpay.com');
    assert.equal(request.pathname, '/v1/research/filings');assert.equal(request.searchParams.get('issuer_id'), issuer);
    return json(catalog);
  }
  assert.equal((await listCompanyFilings(issuer, options(transport))).filings.length, 1);assert.equal(calls, 1);
  await assert.rejects(listCompanyFilings('https://evil.test', options(transport)), /invalid_issuer/);assert.equal(calls, 1);
});
test('additional pages require a source hash and reject silent source-version changes', async () => {
  let calls = 0;
  const transport = async requestUrl => { calls++;assert.equal(new URL(requestUrl).searchParams.get('expected_sha256'), 'a'.repeat(64));return json(doc); };
  await assert.rejects(readCompanyFiling(issuer, accession, { ...options(transport), offset: 1 }), /invalid_issuer/);assert.equal(calls, 0);
  assert.equal((await readCompanyFiling(issuer, accession, { ...options(transport), offset: 1, expectedSha256: 'a'.repeat(64) })).offset, 1);
  await assert.rejects(readCompanyFiling(issuer, accession, { ...options(async () => json({ ...doc, sha256: 'b'.repeat(64) })), offset: 1, expectedSha256: 'a'.repeat(64) }), /RESEARCH_DOCUMENT_CHANGED/);
});
test('old servers, missing filings and source failures remain distinct', async () => {
  for (const [response, code] of [
    [new Response('Not found', { status: 404 }), 'filing_service_unavailable'],
    [json({ error: { code: 'RESEARCH_FILING_NOT_FOUND' } }, 404), 'RESEARCH_FILING_NOT_FOUND'],
    [json({ error: { code: 'RESEARCH_SOURCE_UNAVAILABLE' } }, 502), 'RESEARCH_SOURCE_UNAVAILABLE'],
    [new Response('', { status: 501 }), 'filing_service_unavailable'],
    [new Response('', { status: 302 }), 'redirect'],
    [new Response('', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(FILING_RESPONSE_LIMIT + 1) } }), 'too_large'],
  ]) await assert.rejects(listCompanyFilings(issuer, options(async () => response)), error => error.code === code);
});
test('429 applies a shared cooldown without automatically repeating requests', async () => {
  let calls = 0;
  const transport = async () => { calls++;return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); };
  for (let i = 0; i < 2; i++) await assert.rejects(listCompanyFilings(issuer, options(transport)), /RESEARCH_SOURCE_RATE_LIMITED/);
  assert.equal(calls, 1);
});
test('cancellation stops a stalled source and excludes subsequent work', async () => {
  const controller = new AbortController();let upstream;
  const pending = listCompanyFilings(issuer, { signal: controller.signal, transport: async (_, init) => { upstream = init.signal;return new Promise(() => {}); } });
  controller.abort();await assert.rejects(pending, /cancelled/);assert.equal(upstream.aborted, true);
});
