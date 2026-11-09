import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/filings-core.ts') && specifier === './core') return next('./core.ts', context);
  return next(specifier, context);
} });
const { decodeFilingCatalog, decodeFilingDocument, filingDocumentUrl, buildFilingEvidenceText, buildFilingCatalogSummary, buildFilingSummary, FILING_RESULT_LIMIT } = await import('./filings-core.ts');
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

test('an oversized first paragraph does not hide later complete paragraphs or their citations', () => {
  const d = document();
  const original = d.paragraphs[0];
  d.paragraphs = [
    { ...original, text: `OVERSIZED_START ${'A'.repeat(7_500)} OVERSIZED_END` },
    { ...original, id: 'p000001', text: 'Revenue rose in the latest fiscal year.', source_url: summary.document_url + '#revenue' },
    { ...original, id: 'p000002', text: 'Operating expenses also increased.', source_url: summary.document_url + '#expenses' },
  ];
  d.total_paragraphs = 3;
  const decoded = decodeFilingDocument(d, issuer, accession);
  for (const locale of ['zh', 'en']) {
    const text = buildFilingEvidenceText(decoded, locale);
    assert.ok(JSON.stringify({ text }).length <= FILING_RESULT_LIMIT);
    assert.doesNotMatch(text, /OVERSIZED_START|OVERSIZED_END|\[p000000\]/);
    for (const paragraph of decoded.paragraphs.slice(1)) {
      assert.ok(text.includes(`[${paragraph.id}]`));
      assert.ok(text.includes(paragraph.text));
      assert.ok(text.includes(paragraph.source_url));
    }
    assert.ok(text.indexOf('[p000001]') < text.indexOf('[p000002]'));
    assert.match(text, locale === 'zh' ? /纳入当前页 2\/3 段/ : /Included 2\/3 selected paragraphs/);
    assert.match(text, locale === 'zh' ? /完整省略 1 段/ : /1 whole paragraph was omitted/);
  }
});

test('an explicit paragraph selection never falls back to unselected text when it cannot fit', () => {
  const d = document();
  d.paragraphs = [
    { ...d.paragraphs[0], text: 'A'.repeat(7_600) },
    { ...d.paragraphs[0], id: 'p000001', text: 'UNSELECTED_SOURCE_PARAGRAPH' },
  ];
  d.total_paragraphs = 2;
  for (const locale of ['zh', 'en']) {
    const text = buildFilingEvidenceText(d, locale, ['p000000']);
    assert.ok(JSON.stringify({ text }).length <= FILING_RESULT_LIMIT);
    assert.doesNotMatch(text, /UNSELECTED_SOURCE_PARAGRAPH|A{100}/);
    assert.match(text, locale === 'zh' ? /纳入当前页 0\/1 段/ : /Included 0\/1 selected paragraphs/);
    assert.match(text, locale === 'zh' ? /没有正文段落.*不能.*总结正文/ : /contains no source paragraphs.*Do not summarize/);
  }
});

test('filing catalog summaries explain the available reports without technical identifiers', () => {
  const newer = { ...summary, accession: '0001140361-26-020000', form: '10-Q', filed_at: '2026-08-01', report_date: '2026-06-30', document_name: 'quarterly.htm', document_url: filingDocumentUrl(base.cik, '0001140361-26-020000', 'quarterly.htm') };
  const report = decodeFilingCatalog({ ...base, filings: [summary, newer], total: 4, truncated: true }, issuer);
  for (const locale of ['zh', 'en']) {
    const text = buildFilingCatalogSummary(report, locale);
    assert.ok(text.includes(base.company_name));
    assert.match(text, locale === 'zh' ? /2 份近期披露.*2 份未列出/ : /2 recent disclosures.*2 more.*not listed/);
    assert.match(text, locale === 'zh' ? /最近一份是季度报告.*2026年8月1日.*2026年6月30日/ : /most recently filed is Quarterly report.*August 1, 2026.*June 30, 2026/);
    assert.match(text, locale === 'zh' ? /尚未读取正文/ : /document text has not been read/);
    assert.doesNotMatch(text, /sec:|p\d{6}|SHA-256|https?:\/\/|0001140361|fetched_at|offset=/);
    assert.ok(text.length < 500);
  }
  const empty = { ...base, filings: [], total: 0, truncated: false };
  assert.match(buildFilingCatalogSummary(empty, 'zh'), /未找到.*尚未读取正文/);
  assert.match(buildFilingCatalogSummary(empty, 'en'), /No selectable.*No document text was read/);
});

test('document summaries distinguish retrieved text from the smaller analysis material', () => {
  const d = document();
  d.paragraphs = [
    { ...d.paragraphs[0], text: 'A'.repeat(7_600) },
    { ...d.paragraphs[0], id: 'p000001', text: 'Revenue increased during the fiscal year.' },
  ];
  d.next_offset = 2; d.total_paragraphs = 20;
  const decoded = decodeFilingDocument(d, issuer, accession);
  for (const locale of ['zh', 'en']) {
    const text = buildFilingSummary(decoded, locale);
    assert.ok(text.includes(base.company_name));
    assert.match(text, locale === 'zh' ? /临时披露.*2026年4月20日/ : /Current report.*April 20, 2026/);
    assert.match(text, locale === 'zh' ? /取得 2 段正文，其中 1 段已纳入分析资料/ : /2 source paragraphs were retrieved; 1 was included in the analysis material/);
    assert.match(text, locale === 'zh' ? /只取得部分正文/ : /Only part of the document was retrieved/);
    assert.doesNotMatch(text, /sec:|p\d{6}|s\d{4}|SHA-256|https?:\/\/|0001140361|offset=/);
    assert.doesNotMatch(text, /Revenue increased|A{100}/);
    assert.ok(text.length < 600);
  }
  const short = buildFilingSummary(document(), 'zh');
  assert.match(short, /取得 1 段正文，已纳入分析资料/);
  assert.match(short, /不代表已完成全文分析/);
  assert.match(buildFilingSummary({ ...document(), truncated: true }, 'en'), /extraction reached its limit.*remaining document text was not read/);
});

test('PDF, unsupported formats and absent analysis paragraphs have actionable plain-language summaries', () => {
  const pdf = document();
  pdf.status = 'not_read'; pdf.filing.document_name = 'report.pdf'; pdf.filing.document_url = filingDocumentUrl(base.cik, accession, 'report.pdf'); pdf.filing.format = 'pdf';
  pdf.paragraphs = []; pdf.sections = []; pdf.total_paragraphs = 0; pdf.content_type = null; pdf.sha256 = null; pdf.limitations = ['PDF text has not been read.'];
  const unread = decodeFilingDocument(pdf, issuer, accession);
  assert.match(buildFilingSummary(unread, 'zh'), /不支持读取 PDF 正文.*打开官方原文件/);
  assert.match(buildFilingSummary(unread, 'en'), /cannot currently read PDF text.*Open the official file/);
  const other = { ...unread, filing: { ...unread.filing, format: 'unsupported' } };
  assert.match(buildFilingSummary(other, 'zh'), /文件格式暂不支持读取正文/);
  assert.match(buildFilingSummary(other, 'en'), /Text cannot yet be read from this file format/);
  const empty = { ...document(), paragraphs: [] };
  assert.match(buildFilingSummary(empty, 'zh'), /未取得可阅读的正文.*重新选择披露文件/);
  assert.match(buildFilingSummary(empty, 'en'), /No readable document text.*Choose another disclosure/);
  const tooLong = document(); tooLong.paragraphs[0].text = 'A'.repeat(7_600);
  assert.match(buildFilingSummary(tooLong, 'zh'), /尚未有正文可用于分析.*选择较短的段落/);
  assert.match(buildFilingSummary(tooLong, 'en'), /none fit this analysis.*Select shorter paragraphs/);
});
