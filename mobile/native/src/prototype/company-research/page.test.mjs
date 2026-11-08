import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { registerHooks } from 'node:module';
import * as core from './core.ts';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const filingCore=await import('./filings-core.ts');
test.after(()=>resolver.deregister());
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
function harness({ lookup = async () => sample, analyze = async () => true, platform = 'ios', filingList = async()=>filingCatalog, filingRead = async()=>filingDocument, research } = {}) {
  const slots = [], calls = [], drafts = []; let cursor = 0, effects = [], dirty = true, mounted = true, writesAfterUnmount = 0, background;
  let props = { active: true, onAnalyze: (...args) => { drafts.push(args); return analyze(...args); } };
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { if (!mounted) writesAfterUnmount++; slots[i].value = value; dirty = true; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(callback, dependencies) { const i = cursor++; if (!slots[i] || dependencies.some((v, j) => v !== slots[i].dependencies[j])) { const old = slots[i]?.cleanup; slots[i] = { dependencies }; effects.push(() => { old?.(); slots[i].cleanup = callback(); }); } },
  };
  react.useLayoutEffect = react.useEffect;
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Pressable: 'Pressable', Linking: { openURL: async () => {} }, AppState: { currentState: 'active', addEventListener: (_, cb) => { background = cb; return { remove() {} }; } } },
    'expo/fetch': { fetch: async () => {} }, '../design': { Input: 'Input', Sheet: 'Sheet', Type: 'Type', useDesign: () => ({ colors: {}, locale: 'en', text: (_, en) => en }) },
    './client': { searchCompanies: (...args) => { calls.push(args); return lookup(...args); }, researchCompany: async () => research ?? ({ ...sample, kind: 'company-research', issuerId: 'wikidata:Q53268', company: sample.candidates[0], facts: [], calculations: [] }) },
    './filings-client': { listCompanyFilings: (...args)=>{calls.push(['filing-list',...args]);return filingList(...args);}, readCompanyFiling:(...args)=>{calls.push(['filing-read',...args]);return filingRead(...args);}, filingErrorText:error=>error.code??'Filing unavailable' },
    './filings-core': filingCore,
    './core': { ...core, companyGapText: gap => gap, buildCompanyResearchText: () => '> External public data' },
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, URL, AbortController, process: { env: { EXPO_OS: platform } }, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  function render(patch = {}) { props = { ...props, ...patch }; let tree, count = 0; do { assert.ok(count++ < 12); dirty = false; cursor = 0; tree = module.exports.CompanyResearchPanel(props); const pending = effects; effects = []; pending.forEach(effect => effect()); } while (dirty); return nodes(tree); }
  function press(label) { const button = render().find(node => typeof node.type === 'function' && node.type.name === 'Button' && node.props.label === label); assert.ok(button, label); assert.ok(!button.props.disabled); button.props.onPress(); render(); }
  function enter(value) { render().find(node => node.type === 'Input').props.onChangeText(value); render(); }
  return { render, press, enter, calls, drafts, background: () => background('background'), unmount() { mounted = false; slots.forEach(slot => slot.cleanup?.()); }, get writesAfterUnmount() { return writesAfterUnmount; } };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
test('Web company UI keeps Wikidata search and presents SEC as an unrequested capability limit', async () => {
  const h = harness({ platform: 'web', lookup: async () => ({ ...sample, sources: [{ source: 'sec-directory', status: 'not_read', url: core.SEC_DIRECTORY }] }) });
  assert.ok(h.render().some(node => String(node.props.children).includes('SEC directories and financial data do not allow direct browser reads')));
  h.enter('Toyota'); h.press('Search companies'); await flush();
  assert.equal(h.calls.length, 1);
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
const filingDocument={...filingCatalog,filing:filingSummary,status:'ready',sha256:'a'.repeat(64),content_type:'text/html',sections:[{id:'sec1',title:'Business',start_paragraph:0},{id:'sec2',title:'Risks',start_paragraph:80}],paragraphs:[{id:'p000000',text:'A paragraph about operations.',kind:'text',section_id:'sec1',source_url:filingSummary.document_url+'#business'}],offset:0,next_offset:80,total_paragraphs:81,truncated:false,limitations:[]};
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
