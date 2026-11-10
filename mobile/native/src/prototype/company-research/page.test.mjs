import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { registerHooks } from 'node:module';
import * as core from './core.ts';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const filingCore=await import('./filings-core.ts');
const handoff=await import('./handoff.ts');
test.after(()=>resolver.deregister());
test.beforeEach(()=>handoff.clearCompanyResults());
const jsx = (type, props) => ({ type, props });
const source = ts.transpileModule(readFileSync(new URL('./page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (!tree || typeof tree !== 'object' || (tree.type === 'Sheet' && !tree.props.visible)) return result;
  result.push(tree); nodes(tree.props?.children, result); return result;
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const sample = { kind: 'company-search', query: 'Toyota', fetchedAt: '2026-11-02T00:00:00Z', candidates: [{ issuerId: 'wikidata:Q53268', name: 'Toyota', source: 'wikidata', sourceUrl: 'https://www.wikidata.org/wiki/Q53268', cik: null, listings: [{ exchange: 'Tokyo', ticker: '7203', status: 'unknown' }] }], sources: [], gaps: ['Partial directory'] };
function harness({ lookup = async () => sample, analyze = async () => true, platform = 'ios', filingList = async()=>filingCatalog, filingRead = async()=>filingDocument, research, initialProps = {}, locale = 'en' } = {}) {
  const slots = [], calls = [], drafts = [], researchCalls = [], openedUrls = []; let cursor = 0, effects = [], dirty = true, mounted = true, writesAfterUnmount = 0, background;
  let props = { active: true, onAnalyze: (...args) => { drafts.push(args); return analyze(...args); }, ...initialProps };
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { if (!mounted) writesAfterUnmount++; slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(callback, dependencies) { const i = cursor++; if (!slots[i] || dependencies.some((v, j) => v !== slots[i].dependencies[j])) { const old = slots[i]?.cleanup; slots[i] = { dependencies }; effects.push(() => { old?.(); slots[i].cleanup = callback(); }); } },
  };
  react.useLayoutEffect = react.useEffect;
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Pressable: 'Pressable', Linking: { openURL: async url => openedUrls.push(url) }, AppState: { currentState: 'active', addEventListener: (_, cb) => { background = cb; return { remove() {} }; } } },
    'expo/fetch': { fetch: async () => {} }, '../design': { Input: 'Input', Sheet: 'Sheet', Type: 'Type', useDesign: () => ({ colors: {}, locale, text: (zh, en) => locale === 'zh' ? zh : en }) },
    './client': { searchCompanies: (...args) => { calls.push(args); return lookup(...args); }, researchCompany: async (...args) => { researchCalls.push(args); return research ?? ({ ...sample, kind: 'company-research', issuerId: 'wikidata:Q53268', company: sample.candidates[0], facts: [], calculations: [] }); } },
    './filings-client': { listCompanyFilings: (...args)=>{calls.push(['filing-list',...args]);return filingList(...args);}, readCompanyFiling:(...args)=>{calls.push(['filing-read',...args]);return filingRead(...args);}, filingErrorText:error=>error.code??'Filing unavailable' },
    './filings-core': filingCore,
    './handoff': handoff,
    './core': { ...core, companyGapText: gap => gap, buildCompanyResearchText: () => '> External public data' },
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, URL, AbortController, process: { env: { EXPO_OS: platform } }, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  function render(patch = {}) { props = { ...props, ...patch }; let tree, count = 0; do { assert.ok(count++ < 12); dirty = false; cursor = 0; tree = module.exports.CompanyResearchPanel(props); const pending = effects; effects = []; pending.forEach(effect => effect()); } while (dirty); return nodes(tree); }
  function press(label) { const button = render().find(node => typeof node.type === 'function' && node.type.name === 'Button' && node.props.label === label); assert.ok(button, label); assert.ok(!button.props.disabled); button.props.onPress(); render(); }
  function enter(value) { render().find(node => node.type === 'Input').props.onChangeText(value); render(); }
  return { render, press, enter, calls, drafts, researchCalls, openedUrls, background: () => background('background'), unmount() { mounted = false; slots.forEach(slot => slot.cleanup?.()); }, get writesAfterUnmount() { return writesAfterUnmount; } };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
test('Web company UI keeps Wikidata search and presents SEC as an unrequested capability limit', async () => {
  const h = harness({ platform: 'web', lookup: async () => ({ ...sample, sources: [{ source: 'sec-directory', status: 'not_read', url: core.SEC_DIRECTORY }] }) });
  assert.ok(h.render().some(node => String(node.props.children).includes('SEC annual financial data cannot be read directly in the browser')));
  h.enter('Toyota'); h.press('Search companies'); await flush();
  assert.equal(h.calls.length, 1);
  assert.ok(!h.render().some(node => String(node.props.children).includes('Not requested · browser restriction')));
  h.press('Sources and coverage');
  assert.ok(h.render().some(node => String(node.props.children).includes('Not requested · browser restriction')));
  assert.ok(!h.render().some(node => node.props.label === 'Read this company’s public financial data'));
  assert.ok(h.render().some(node => node.props.label === 'View issuer source'));
  h.press('View official SEC disclosures');
  assert.ok(h.render().some(node => node.props.children === core.SEC_PUBLIC_SEARCH));
});
test('opening makes no request; explicit search exposes candidates and leaves send under user control', async () => {
  const h = harness(); h.render(); assert.equal(h.calls.length, 0);
  h.enter('Toyota'); h.press('Search companies'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'Toyota');
  assert.ok(h.render().some(node => node.props.children === 'Toyota'));
  h.press('Use in chat'); assert.equal(h.drafts.length, 0); h.press('New chat with Q'); await flush();
  assert.equal(h.drafts.length, 1); assert.match(h.drafts[0][0], /> External public data/);
});
test('cancel and background abort requests and discard late responses', async () => {
  for (const mode of ['cancel', 'background', 'inactive', 'unmount']) {
    const pending = deferred(); const h = harness({ lookup: () => pending.promise }); h.render(); h.enter('Toyota'); h.press('Search companies');
    if (mode === 'cancel') h.press('Cancel query'); else if (mode === 'background') h.background(); else if (mode === 'inactive') h.render({ active: false }); else h.unmount();
    assert.equal(h.calls[0][1].signal.aborted, true); pending.resolve(sample); await flush();
    if (mode !== 'unmount') assert.ok(!h.render().some(node => node.props.children === 'Toyota'));
    assert.equal(h.writesAfterUnmount, 0);
  }
});
test('a failed handoff preserves the result and shows failure; closing aborts a pending handoff', async () => {
  const pending = deferred(); const h = harness({ analyze: () => pending.promise }); h.render(); h.enter('Toyota'); h.press('Search companies'); await flush(); h.press('Use in chat'); h.press('New chat with Q');
  h.render().find(node => node.type === 'Sheet' && node.props.visible).props.onClose();
  assert.equal(h.drafts[0][2].aborted, true); pending.resolve(true); await flush();
  assert.ok(h.render().some(node => node.props.children === 'Toyota'));
});

test('research focuses the selected report and back restores candidates without another search', async () => {
  const h = harness(); h.render(); h.enter('Toyota'); h.press('Search companies'); await flush();
  h.press('Read this company’s public financial data'); await flush();
  assert.ok(!h.render().some(node => node.props.label === 'Read this company’s public financial data'));
  assert.ok(h.render().some(node => node.props.label === 'Back to candidates'));
  h.press('Back to candidates');
  assert.ok(h.render().some(node => node.props.label === 'Read this company’s public financial data'));
  assert.equal(h.calls.length, 1);
});

const filingSummary={accession:'0000320193-26-000001',form:'10-K',filed_at:'2026-11-01',report_date:'2026-09-30',document_name:'report.htm',document_url:'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/report.htm',format:'html'};
const filingCatalog={version:1,issuer_id:'sec:0000320193',cik:'0000320193',company_name:'Apple',fetched_at:'2026-11-08T00:00:00Z',filings:[filingSummary],total:1,truncated:false};
const filingDocument={version:1,issuer_id:filingCatalog.issuer_id,cik:filingCatalog.cik,company_name:filingCatalog.company_name,fetched_at:filingCatalog.fetched_at,filing:filingSummary,status:'ready',sha256:'a'.repeat(64),content_type:'text/html',sections:[{id:'sec1',title:'Business',start_paragraph:0},{id:'sec2',title:'Risks',start_paragraph:80}],paragraphs:[{id:'p000000',text:'A paragraph about operations.',kind:'text',section_id:'sec1',source_url:filingSummary.document_url+'#business'}],offset:0,next_offset:80,total_paragraphs:81,truncated:false,limitations:[]};
const research={kind:'company-research',issuerId:'sec:0000320193',fetchedAt:'2026-11-08T00:00:00Z',company:{...sample.candidates[0],cik:'0000320193',name:'Apple'},facts:[],calculations:[],sources:[],gaps:[]};
async function openFilings(h){h.render();h.enter('Apple');h.press('Search companies');await flush();h.press('Read this company’s public financial data');await flush();h.press('Original disclosures');h.press('Load disclosure list');await flush();}
test('filing reader requests explicitly, preserves hash for section jumps and builds cited draft only on handoff',async()=>{
 const h=harness({research});await openFilings(h);assert.equal(h.calls.filter(c=>c[0]==='filing-read').length,0);
 h.press('View disclosure · 10-K · 2026-11-01');await flush();
 h.press('Choose a filing section');h.press('Risks');await flush();
 const jump=h.calls.filter(c=>c[0]==='filing-read').at(-1);assert.equal(jump[3].offset,80);assert.equal(jump[3].expectedSha256,'a'.repeat(64));
 h.press('Discuss paragraph 1');assert.equal(h.drafts.length,0);h.press('New chat with Q');await flush();
 assert.match(h.drafts[0][0],/p000000/);assert.match(h.drafts[0][0],/0000320193-26-000001/);assert.match(h.drafts[0][0],/aaaaaaaa/);
});
test('document changes discard the old evidence and require explicit fresh reading',async()=>{
 let count=0;const h=harness({research,filingRead:async()=>{if(count++)throw new core.CompanyResearchError('RESEARCH_DOCUMENT_CHANGED');return filingDocument;}});await openFilings(h);h.press('View disclosure · 10-K · 2026-11-01');await flush();h.press('Read next paragraphs');await flush();
 assert.ok(!h.render().some(n=>n.props.children==='A paragraph about operations.'));assert.ok(h.render().some(n=>n.props.children==='RESEARCH_DOCUMENT_CHANGED'));assert.equal(h.render().some(n=>n.props.label==='Use these paragraphs in chat'),false);
 assert.equal(handoff.readCompanyFilingResult({issuerId:filingCatalog.issuer_id,accession:filingSummary.accession}),null);
});
test('PDF not-read response offers original link without a research handoff',async()=>{
 const h=harness({research,filingRead:async()=>({...filingDocument,status:'not_read',filing:{...filingSummary,format:'pdf'},sha256:null,paragraphs:[],sections:[],next_offset:null,total_paragraphs:0})});await openFilings(h);h.press('View disclosure · 10-K · 2026-11-01');await flush();assert.ok(h.render().some(n=>String(n.props.children).includes('format has not been parsed')));assert.equal(h.render().some(n=>n.props.label==='Use these paragraphs in chat'),false);
});
test('leaving or backgrounding cancels filing reads and prevents late publication',async()=>{
 for(const mode of ['background','inactive','unmount']){const pending=deferred();const h=harness({research,filingRead:()=>pending.promise});await openFilings(h);h.press('View disclosure · 10-K · 2026-11-01');const req=h.calls.find(c=>c[0]==='filing-read');if(mode==='background')h.background();else if(mode==='inactive')h.render({active:false});else h.unmount();assert.equal(req[3].signal.aborted,true);pending.resolve(filingDocument);await flush();if(mode!=='unmount')assert.ok(!h.render().some(n=>n.props.children==='A paragraph about operations.'));assert.equal(h.writesAfterUnmount,0);}
});

test('an unverified Wikidata CIK cannot be promoted into verified filing research',async()=>{
 const h=harness({research:{...research,issuerId:'wikidata:Q53268',sources:[{source:'sec-submissions',status:'error',url:'https://data.sec.gov/submissions/CIK0000320193.json'}]}});h.render();h.enter('Toyota');h.press('Search companies');await flush();h.press('Read this company’s public financial data');await flush();h.press('Original disclosures');assert.equal(h.render().some(n=>n.props.label==='Load disclosure list'),false);assert.ok(h.render().some(n=>String(n.props.children).includes('no verified SEC identity')));assert.equal(h.calls.some(c=>c[0]==='filing-list'),false);
});

const visibleText = tree => tree.filter(node => node.type === 'Type').flatMap(node => [node.props.children].flat(Infinity)).filter(value => typeof value === 'string' || typeof value === 'number').join(' ');
test('a company search handoff immediately reuses its results and keeps identifiers behind sources and coverage', () => {
  const cached = { ...sample, candidates: [{ ...sample.candidates[0], listings: [{ exchange: 'Q217475', ticker: '7203', status: 'unknown', sourceUrl: sample.candidates[0].sourceUrl }] }], sources: [{ source: 'wikidata-entity', status: 'available', url: sample.candidates[0].sourceUrl }] };
  for (const locale of ['zh', 'en']) {
    handoff.rememberCompanyResult(cached);
    const h = harness({ locale, initialProps: { initialCompanyQuery: 'Toyota' } });
    const all = h.render();
    assert.equal(all.find(node => node.type === 'Input').props.value, 'Toyota');
    assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
    assert.ok(visibleText(all).includes('Toyota'));
    assert.ok(visibleText(all).includes('7203'));
    assert.doesNotMatch(visibleText(all), /wikidata:Q53268|Q217475|Partial directory|Not requested|Read successfully/);
    const label = locale === 'zh' ? '来源与范围' : 'Sources and coverage';
    const control = all.find(node => node.props.label === label);
    const native = control.type(control.props);
    assert.ok(native.props.style({ pressed: false }).minHeight >= 48);
    h.press(label);
    assert.match(visibleText(h.render()), /wikidata:Q53268/);
    assert.match(visibleText(h.render()), /Q217475/);
    assert.equal(h.calls.length, 0);
    h.press(locale === 'zh' ? '收起来源与范围' : 'Hide sources and coverage');
    assert.doesNotMatch(visibleText(h.render()), /wikidata:Q53268|Q217475/);
  }
});

test('a research handoff keeps real values, currency and reporting periods without displaying XBRL fields', () => {
  const cached = { ...research, company: { ...research.company, issuerId: research.issuerId }, facts: [{ metric: 'revenue', value: 123_000, unit: 'USD', start: '2025-01-01', end: '2025-12-31', filed: '2026-02-01', taxonomy: 'us-gaap', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', form: '10-K', accession: '0000320193-26-000001', sourceUrl: filingSummary.document_url }] };
  handoff.rememberCompanyResult(cached);
  const h = harness({ initialProps: { initialCompanyQuery: 'Apple', initialCompanyIssuerId: cached.issuerId } });
  const all = h.render();
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  assert.match(visibleText(all), /Apple.*Revenue.*123,000.*USD.*2025-01-01.*2025-12-31/);
  assert.doesNotMatch(visibleText(all), /sec:0000320193|us-gaap|RevenueFromContract|0000320193-26-000001/);
  h.press('Sources and coverage');
  assert.match(visibleText(h.render()), /sec:0000320193|us-gaap:RevenueFromContract/);
  h.press('View value source');
  assert.equal(h.openedUrls.length, 0, 'a source preview does not open the external page');
  assert.ok(h.render().some(node => node.type === 'Sheet' && node.props.title === 'Open public source'));
  h.press('Open source page');
  assert.deepEqual(h.openedUrls, [filingSummary.document_url]);
});

test('expired company handoff only prefills conditions and requires an explicit read of the selected issuer', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  handoff.rememberCompanyResult(research);
  now += 5 * 60_000;
  const h = harness({ research, initialProps: { initialCompanyQuery: 'Apple', initialCompanyIssuerId: research.issuerId } });
  const all = h.render();
  assert.equal(all.find(node => node.type === 'Input').props.value, 'Apple');
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  assert.match(visibleText(all), /previous material needs to be read again/);
  assert.doesNotMatch(visibleText(all), /sec:0000320193/);
  h.press('Read the selected company’s financial data'); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 1);
  assert.equal(h.researchCalls[0][0], research.issuerId);
  assert.ok(handoff.readCompanyResult({ issuerId: research.issuerId }));
});

test('editing a prefilled company clears the previous issuer and never replays its query', async () => {
  const h = harness({ initialProps: { initialCompanyQuery: 'Apple', initialCompanyIssuerId: research.issuerId } });
  h.render(); h.enter('Toyota');
  assert.equal(h.render().some(node => node.props.label === 'Read the selected company’s financial data'), false);
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  h.press('Search companies'); await flush();
  assert.equal(h.calls[0][0], 'Toyota'); assert.equal(h.researchCalls.length, 0);
});

test('an untrusted source link cannot be opened from a reused company report', () => {
  handoff.rememberCompanyResult({ ...sample, candidates: [{ ...sample.candidates[0], sourceUrl: 'https://untrusted.example/issuer' }] });
  const h = harness({ platform: 'web', initialProps: { initialCompanyQuery: 'Toyota' } });
  h.render(); h.press('View issuer source');
  assert.equal(h.render().some(node => node.type === 'Sheet' && node.props.title === 'Open public source'), false);
  assert.equal(h.openedUrls.length, 0);
});

test('a cached filing opens the selected document immediately and keeps the unread financial overview separate', async () => {
  handoff.rememberCompanyFilingResult(filingDocument);
  const h = harness({ research, initialProps: { initialCompanyIssuerId: filingCatalog.issuer_id, initialCompanyView: 'filings', initialCompanyAccession: filingSummary.accession } });
  const all = h.render();
  assert.match(visibleText(all), /Apple.*A paragraph about operations\./);
  assert.ok(all.find(node => node.props.label === 'Original disclosures').props.selected);
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  assert.doesNotMatch(visibleText(all), /sec:0000320193|SHA-256|p000000|a{64}|0000320193-26-000001/);
  h.press('Financial overview');
  assert.match(visibleText(h.render()), /financial overview has not been read/);
  assert.equal(h.researchCalls.length, 0);
  h.press('Read financial overview'); await flush();
  assert.equal(h.researchCalls.length, 1);
  assert.equal(h.researchCalls[0][0], filingCatalog.issuer_id);
  h.press('Original disclosures');
  assert.match(visibleText(h.render()), /A paragraph about operations\./);
  assert.equal(h.calls.length, 0, 'switching back to the preserved filing does not read it again');
});

test('a cached filing catalog opens its disclosures instead of the financial overview', () => {
  handoff.rememberCompanyFilingResult(filingCatalog);
  const h = harness({ initialProps: { initialCompanyIssuerId: filingCatalog.issuer_id, initialCompanyView: 'filings' } });
  const all = h.render();
  assert.ok(all.find(node => node.props.label === 'Original disclosures').props.selected);
  assert.ok(all.some(node => node.props.label === 'View disclosure · 10-K · 2026-11-01'));
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  assert.doesNotMatch(visibleText(all), /A paragraph about operations\./);
});

test('an expired filing retains its target and waits for a specific document read', async t => {
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  handoff.rememberCompanyFilingResult(filingDocument);
  now += 5 * 60_000;
  const h = harness({ initialProps: { initialCompanyQuery: 'Apple', initialCompanyIssuerId: filingCatalog.issuer_id, initialCompanyView: 'filings', initialCompanyAccession: filingSummary.accession } });
  const all = h.render();
  assert.ok(all.find(node => node.props.label === 'Original disclosures').props.selected);
  assert.match(visibleText(all), /selected disclosure is preserved/);
  assert.doesNotMatch(visibleText(all), /A paragraph about operations\./);
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  h.press('Read selected disclosure'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'filing-read');
  assert.equal(h.calls[0][1], filingCatalog.issuer_id); assert.equal(h.calls[0][2], filingSummary.accession);
  assert.equal(h.calls[0][3].offset, 0); assert.equal(h.researchCalls.length, 0);
  assert.match(visibleText(h.render()), /A paragraph about operations\./);
});

test('an expired filing catalog remains on disclosures and only reads after an explicit click', async () => {
  const h = harness({ initialProps: { initialCompanyQuery: 'Apple', initialCompanyIssuerId: filingCatalog.issuer_id, initialCompanyView: 'filings' } });
  const all = h.render();
  assert.ok(all.find(node => node.props.label === 'Original disclosures').props.selected);
  assert.match(visibleText(all), /disclosure list has not been read/);
  assert.equal(h.calls.length, 0); assert.equal(h.researchCalls.length, 0);
  h.press('Load disclosure list'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'filing-list');
  assert.equal(h.researchCalls.length, 0);
});

test('an explicit new search leaves an old filing target and shows the new company candidates', async () => {
  const h = harness({ initialProps: { initialCompanyQuery: 'Toyota', initialCompanyIssuerId: filingCatalog.issuer_id, initialCompanyView: 'filings' } });
  h.render(); h.press('Search companies'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'Toyota');
  assert.ok(h.render().some(node => node.props.label === 'Read this company’s public financial data'));
  assert.equal(h.render().some(node => node.props.label === 'Load disclosure list'), false);
  assert.equal(h.researchCalls.length, 0);
});
