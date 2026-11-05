import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from './core.ts';
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
function harness({ lookup = async () => sample, analyze = async () => true, platform = 'ios' } = {}) {
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
    './client': { searchCompanies: (...args) => { calls.push(args); return lookup(...args); }, researchCompany: async () => ({ ...sample, kind: 'company-research', issuerId: 'wikidata:Q53268', company: sample.candidates[0], facts: [], calculations: [] }) },
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
