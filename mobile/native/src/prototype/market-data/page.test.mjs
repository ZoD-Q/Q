import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from './core.ts';

const noop = () => {};
const jsx = (type, props) => ({ type, props });
const source = ts.transpileModule(readFileSync(new URL('./page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const query = { kind: 'news', topic: 'fed' };
const fetchedAt = '2026-11-01T03:30:00.000Z';
const report = () => core.parseFedReport('<rss><channel><item><title>Federal Reserve policy fixture</title><description>Public research sample.</description><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm</link><pubDate>Wed, 28 Oct 2026 18:00:00 GMT</pubDate></item></channel></rss>', query, fetchedAt);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (tree.type === 'Sheet' && !tree.props.visible) return result;
  result.push(tree);
  nodes(tree.props?.children, result);
  return result;
}
const buttonName = node => typeof node.type === 'function' && node.type.name === 'Button' ? node.props.label : null;

/** Runs actual TSX actions and React state/effect transitions, not native layout or transport. */
function harness({ locale = 'zh', analyze = async () => true, result = report(), market = {}, props = {} } = {}) {
  const slots = [], analyses = [], historyLoads = [], openedUrls = [];
  let cursor = 0, tree, effects = [], dirty = true, mounted = true, writesAfterUnmount = 0;
  let currentProps = { active: true, signedIn: true, conversations: [{ id: 'history-fixture', title: 'Existing research' }],
    onAnalyze: (...args) => { analyses.push(args); return analyze(...args); }, onLoadHistory: more => historyLoads.push(more), ...props };
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        if (!mounted) writesAfterUnmount++;
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
        dirty = true;
      }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffectEvent(callback) {
      const index = cursor++;
      slots[index] ??= { event: (...args) => slots[index].callback(...args) };
      slots[index].callback = callback;
      return slots[index].event;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, position) => value !== slots[index].dependencies[position])) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { dependencies };
        effects.push(() => { cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const design = { ...Object.fromEntries(['Page', 'Row', 'Sheet', 'Type'].map(name => [name, name])),
    useDesign: () => ({ colors: {}, locale, text: (zh, en) => locale === 'zh' ? zh : en }) };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Pressable: 'Pressable', Linking: { openURL: async url => openedUrls.push(url) } },
    'lucide-react-native': { ExternalLink: 'ExternalLink', MessageSquare: 'MessageSquare' },
    '../design': design, './core': core,
    './use-market-data': { useMarketData(selected) {
      return { report: core.marketQueryKey(selected) === 'news:fed' ? result : null, phase: 'ready', stale: false, fromCache: false,
        coolingDown: false, nextAllowedAt: null, run: noop, cancel: noop, ...market };
    } },
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, URL, AbortController, __DEV__: false,
    require: name => { assert.ok(name in imports, `Unexpected component dependency: ${name}`); return imports[name]; } });
  function render(patch) {
    if (patch) currentProps = { ...currentProps, ...patch };
    let iterations = 0;
    do {
      assert.ok(iterations++ < 12, 'component must settle');
      dirty = false; cursor = 0;
      tree = module.exports.MarketDataPage(currentProps);
      const pending = effects; effects = []; pending.forEach(effect => effect());
    } while (dirty);
    return nodes(tree);
  }
  const button = (label, all = render()) => {
    const found = all.find(node => buttonName(node) === label);
    assert.ok(found, `Missing button: ${label}`);
    return found;
  };
  const press = label => {
    const control = button(label);
    const native = control.type(control.props);
    assert.equal(native.type, 'Pressable');
    assert.equal(native.props.disabled, false, `${label} must be enabled`);
    native.props.onPress(); render();
  };
  const sheet = () => render().find(node => node.type === 'Sheet' && node.props.title === (locale === 'zh' ? '选择对话' : 'Choose a chat'));
  render(); press(locale === 'zh' ? '新闻热点' : 'News themes');
  return { render, button, press, sheet, analyses, historyLoads, openedUrls, get writesAfterUnmount() { return writesAfterUnmount; },
    async flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); if (mounted && dirty) render(); } },
    unmount() { mounted = false; slots.forEach(slot => slot.cleanup?.()); },
  };
}

test('the result header pairs Use in chat with its source before all records, with native-sized buttons', () => {
  for (const locale of ['zh', 'en']) {
    const h = harness({ locale });
    const all = h.render(), sourceLabel = locale === 'zh' ? '本次资料来源' : 'Source of this result';
    const useLabel = locale === 'zh' ? '用于对话' : 'Use in chat';
    const group = all.find(node => node.type?.name === 'Group' && nodes(node).some(child => buttonName(child) === sourceLabel));
    assert.ok(group);
    const paired = nodes(group).find(node => buttonName(node) === useLabel);
    assert.ok(paired, 'the action is next to the result source, not only below the record list');
    assert.ok(all.indexOf(paired) < all.findIndex(node => node.type?.name === 'ResultRecords'));
    const native = paired.type(paired.props);
    assert.equal(native.props.accessibilityRole, 'button');
    assert.equal(native.props.accessibilityLabel, useLabel);
    assert.ok(native.props.style({ pressed: false }).minHeight >= 48);
    h.press(useLabel);
    assert.ok(h.sheet());
    assert.equal(h.analyses.length, 0, 'opening a destination picker does not prepare or send anything');
    assert.equal(h.openedUrls.length, 0);
  }
});

test('choosing a new or historical AI chat passes a complete bounded real research draft and destination', async () => {
  for (const locale of ['zh', 'en']) for (const historical of [false, true]) {
    const h = harness({ locale });
    h.press(locale === 'zh' ? '用于对话' : 'Use in chat');
    h.press(historical ? 'Existing research' : locale === 'zh' ? '新建小Q对话' : 'New chat with Q');
    await h.flush();
    assert.equal(h.analyses.length, 1);
    const [draft, destination, signal] = h.analyses[0];
    assert.equal(destination, historical ? 'history-fixture' : undefined);
    assert.equal(draft, core.buildResearchDraft(report(), locale));
    assert.ok(draft.length <= 10000);
    assert.ok(draft.includes(report().source.url));
    assert.ok(draft.includes(report().records[0].url));
    assert.ok(draft.includes('2026-11-01 03:30:00 UTC'));
    assert.equal(signal.aborted, false);
    assert.equal(h.sheet(), undefined);
  }
});

test('a rapid double tap creates one handoff and disables every destination until it settles', async () => {
  const pending = deferred(), h = harness({ analyze: () => pending.promise });
  h.press('用于对话');
  const staleHandler = h.button('新建小Q对话').props.onPress;
  staleHandler(); staleHandler();
  assert.equal(h.analyses.length, 1);
  assert.equal(h.button('正在准备草稿…').props.disabled, true);
  assert.equal(h.button('Existing research').props.disabled, true);
  pending.resolve(true); await h.flush();
  assert.equal(h.sheet(), undefined);
});

test('closing the destination sheet aborts the request and a late success cannot close a newly opened picker', async () => {
  const pending = deferred(), h = harness({ analyze: () => pending.promise });
  h.press('用于对话'); h.press('Existing research');
  const signal = h.analyses[0][2];
  h.sheet().props.onClose();
  assert.equal(signal.aborted, true);
  assert.equal(h.sheet(), undefined);
  h.press('用于对话');
  pending.resolve(true); await h.flush();
  assert.ok(h.sheet(), 'a cancelled completion cannot affect a later picker');
  assert.equal(h.analyses.length, 1);
});

test('backgrounding and unmounting cancel pending handoffs without late state writes', async () => {
  for (const unmount of [false, true]) {
    const pending = deferred(), h = harness({ analyze: () => pending.promise });
    h.press('用于对话'); h.press('新建小Q对话');
    const signal = h.analyses[0][2];
    if (unmount) h.unmount(); else h.render({ active: false });
    assert.equal(signal.aborted, true);
    pending.resolve(true); await h.flush();
    assert.equal(h.writesAfterUnmount, 0);
    if (!unmount) { assert.equal(h.sheet(), undefined); h.render({ active: true }); assert.equal(h.sheet(), undefined); }
  }
});

test('rejected and unsuccessful preparations keep the picker open with recoverable error feedback', async () => {
  for (const analyze of [async () => false, async () => { throw new Error('fixture'); }]) {
    const h = harness({ analyze });
    h.press('用于对话'); h.press('Existing research'); await h.flush();
    assert.ok(h.sheet());
    assert.ok(nodes(h.sheet()).some(node => typeof node.props?.children === 'string' && node.props.children.startsWith('未能带入资料')));
    assert.equal(h.button('新建小Q对话').props.disabled, false);
    h.sheet().props.onClose(); h.press('用于对话');
    assert.equal(nodes(h.sheet()).some(node => typeof node.props?.children === 'string' && node.props.children.startsWith('未能带入资料')), false);
  }
});

test('empty results, loading and inactive pages cannot start a handoff even through stale action references', () => {
  for (const state of [{ result: { ...report(), records: [] } }, { market: { phase: 'loading' } }, { props: { active: false } }]) {
    const h = harness(state), controls = h.render().filter(node => buttonName(node) === '用于对话');
    assert.ok(controls.length > 0);
    controls.forEach(control => { assert.equal(control.props.disabled, true); control.props.onPress(); });
    assert.equal(h.sheet(), undefined); assert.equal(h.analyses.length, 0);
  }
  const h = harness({ result: null });
  assert.equal(h.render().some(node => buttonName(node) === '用于对话'), false);
});

test('history errors, loading and pagination remain actionable without sending research data', () => {
  const h = harness({ props: { historyError: true, hasMoreHistory: true } });
  h.press('用于对话'); h.press('重新读取'); h.press('加载更多对话');
  assert.deepEqual(h.historyLoads, [false, true]);
  assert.equal(h.analyses.length, 0);
  h.render({ historyBusy: true });
  for (const label of ['新建小Q对话', 'Existing research', '重新读取', '加载更多对话']) assert.equal(h.button(label).props.disabled, true);
});

test('older or failed-refresh results retain their original source and timestamps with a stale notice', async () => {
  for (const market of [{ stale: true }, { phase: 'error', error: new core.MarketDataError('network') }, { phase: 'cancelled' }]) {
    const h = harness({ market });
    h.press('用于对话'); h.press('新建小Q对话'); await h.flush();
    const [draft] = h.analyses[0];
    assert.equal(draft, core.buildResearchDraft({ ...report(), freshness: 'stale' }, 'zh'));
    assert.ok(draft.includes('2026-11-01 03:30:00 UTC'));
  }
});
