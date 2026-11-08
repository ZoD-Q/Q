import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/filings-core.ts') && specifier === './core') return next('./core.ts', context);
  return next(specifier, context);
} });
const { decodeFilingCatalog, decodeFilingDocument, filingDocumentUrl, buildFilingEvidenceText, FILING_RESULT_LIMIT } = await import('./filings-core.ts');
test.after(() => hooks.deregister());
const issuer = 'sec:0000320193', accession = '0001140361-26-015711';
const summary = { accession, form: '8-K', filed_at: '2026-04-20', report_date: '2026-04-17', document_name: 'ef20071035_8k.htm', document_url: filingDocumentUrl('0000320193', accession, 'ef20071035_8k.htm'), format: 'html' };
const base = { version: 1, issuer_id: issuer, cik: '0000320193', company_name: 'Apple Inc.', fetched_at: '2026-11-08T10:00:00Z' };
function document() { return { ...base, filing: { ...summary }, status: 'ready', sha256: 'a'.repeat(64), content_type: 'text/html', sections: [{ id: 's0000', title: 'Document text', start_paragraph: 0 }], paragraphs: [{ id: 'p000000', text: 'Verified source paragraph.', kind: 'text', section_id: 's0000', source_url: summary.document_url + '#source-anchor' }], offset: 0, next_offset: null, total_paragraphs: 1, truncated: false, limitations: [] }; }

test('SEC catalog identity binds every primary document including agent-filed accessions', () => {
  const result = decodeFilingCatalog({ ...base, filings: [summary], total: 1, truncated: false }, issuer);
  assert.match(result.filings[0].document_url, /data\/320193\/000114036126015711/);
  assert.throws(() => decodeFilingCatalog({ ...base, cik: '0000000001', filings: [summary], total: 1, truncated: false }, issuer));
  for (const document_name of ['../a.htm', 'x%2fy.htm', 'https://other.test/a.htm', 'x.htm?secret=a']) assert.throws(() => filingDocumentUrl('0000320193', accession, document_name));
  assert.throws(() => decodeFilingCatalog({ ...base, filings: [{ ...summary, document_url: 'https://other.test/a.htm' }], total: 1, truncated: false }, issuer));
});
test('document decoder binds pagination, sections, immutable source links and expected owner', () => {
  assert.equal(decodeFilingDocument(document(), issuer, accession).paragraphs.length, 1);
  for (const change of [
    d => { d.paragraphs[0].source_url = summary.document_url + '/evil'; },
    d => { d.paragraphs[0].id = 'p000001'; },
    d => { d.paragraphs[0].section_id = 's1234'; },
    d => { d.next_offset = 4; },
    d => { d.sha256 = 'fake'; },
    d => { d.filing.accession = '0000000001-26-000001'; },
    d => { d.issuer_id = 'sec:0000000001'; },
    d => { d.status = ['ready']; },
    d => { d.paragraphs[0].kind = ['table']; },
  ]) { const d = document(); change(d); assert.throws(() => decodeFilingDocument(d, issuer, accession)); }
});
test('PDF is represented as unread, never fabricated empty successful evidence', () => {
  const d = document();d.status = 'not_read';d.filing.document_name = 'report.pdf';d.filing.document_url = filingDocumentUrl(base.cik, accession, 'report.pdf');d.filing.format = 'pdf';
  d.paragraphs = [];d.sections = [];d.total_paragraphs = 0;d.content_type = null;d.sha256 = null;d.limitations = ['PDF text has not been read.'];
  assert.equal(decodeFilingDocument(d, issuer, accession).status, 'not_read');
  assert.match(buildFilingEvidenceText(d, 'zh'), /正文尚未读取/);
  d.status = 'ready';assert.throws(() => decodeFilingDocument(d, issuer, accession));
});
test('model excerpts preserve full paragraphs and citations inside the escaped JSON budget', () => {
  const d = document();d.paragraphs = Array.from({ length: 10 }, (_, i) => ({ ...d.paragraphs[0], id: `p${String(i).padStart(6, '0')}`, text: `Whole paragraph ${i} ${'"\\'.repeat(800)} END_${i}.` }));d.total_paragraphs = 10;
  d.limitations = ['Long source blocks were split into bounded extracted paragraphs.', 'Only this primary document was read; exhibits were not followed.'];
  for (const locale of ['zh', 'en']) {
    const text = buildFilingEvidenceText(d, locale);
    assert.ok(JSON.stringify({ text }).length <= FILING_RESULT_LIMIT);
    assert.ok(text.includes(d.paragraphs[0].text));
    assert.ok(text.includes(d.paragraphs[0].source_url));
    assert.ok(text.includes(d.limitations[0]));
    assert.ok(!text.includes(d.paragraphs[9].text));
    assert.match(text, locale === 'zh' ? /并未向模型提供完整财报/ : /did not receive the complete filing/);
    for (let i = 0; i < 10; i++) assert.equal(text.includes(`Whole paragraph ${i}`), text.includes(`END_${i}.`));
  }
});
test('long reading limitations retain complete warnings and disclose omitted ones within budget', () => {
  const d = document();d.limitations = Array.from({length:12}, (_,i) => `Limit ${i}: ${'"\\'.repeat(240)}`);
  for(const locale of ['zh','en']) {
    const text=buildFilingEvidenceText(d,locale);
    assert.ok(text.includes(d.limitations[0]));
    assert.ok(!text.includes(d.limitations[11]));
    assert.match(text,locale==='zh'?/读取限制未纳入上下文/:/reading limitations were omitted/);
    assert.ok(JSON.stringify({text}).length<=FILING_RESULT_LIMIT);
  }
});
