import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as guideCore from './guide.ts';
import * as content from './guide-content.ts';

const document = guideCore.parseIntegrationGuide(content.integrationGuideMarkdown);
const linkedIndex = document.sections.findIndex(section => section.links.length > 0);
const linkedChapter = document.sections[linkedIndex];
const jsx = (type, props, key) => ({ type, props, key });
const source = ts.transpileModule(readFileSync(new URL('./guide-reader.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (!tree || typeof tree !== 'object') return result;
  result.push(tree); nodes(tree.props?.children, result); nodes(tree.props?.footer, result); return result;
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

/** Executes the actual TSX handlers; native layout and scroll delivery need device checks. */
function harness({ open = async () => {} } = {}) {
  const slots = [], opened = [];
  let cursor = 0, dirty = true, effects = [], tree, backCount = 0;
  const react = {
    useState(initial) {
      const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(callback, dependencies) {
      const i = cursor++;
      if (!slots[i] || dependencies.some((value, index) => value !== slots[i].dependencies[index])) {
        const cleanup = slots[i]?.cleanup; slots[i] = { dependencies };
        effects.push(() => { cleanup?.(); slots[i].cleanup = callback(); });
      }
    },
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', ScrollView: 'ScrollView', Keyboard: { dismiss() {}, isVisible: () => false },
      BackHandler: { addEventListener: () => ({ remove() {} }) }, Linking: { openURL: url => { opened.push(url); return open(url); } } },
    'lucide-react-native': { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', BookOpen: 'BookOpen', ExternalLink: 'ExternalLink' },
    '../design': { ...Object.fromEntries(['Action', 'Divider', 'Input', 'Page', 'Row', 'Sheet', 'Tag', 'Type'].map(name => [name, name])),
      useDesign: () => ({ colors: {}, text: (_, en) => en }) },
    './guide-content': content, './guide': guideCore,
  };
  const module = { exports: {} }; const onBack = () => { backCount++; };
  runInNewContext(source, { module, exports: module.exports, URL, process: { env: { EXPO_OS: 'web' } },
    require: name => { assert.ok(name in imports, name); return imports[name]; } });
  function render() {
    let count = 0;
    do {
      assert.ok(count++ < 12); dirty = false; cursor = 0;
      tree = module.exports.IntegrationGuidePage({ onBack });
      const pending = effects; effects = []; pending.forEach(effect => effect());
    } while (dirty);
    return nodes(tree);
  }
  const sheet = () => render().find(node => node.type === 'Sheet');
  function press(type, field, label) {
    const control = render().find(node => node.type === type && node.props[field] === label);
    assert.ok(control, label); assert.ok(!control.props.disabled, label); control.props.onPress(); render();
  }
  return { render, sheet, opened, get backCount() { return backCount; },
    chapter(section) { press('Row', 'title', section.title); },
    action(label) { press('Action', 'label', label); },
    preview() { press('Row', 'title', linkedChapter.links[0].title); },
    async flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } },
  };
}

test('late scroll from the old chapter cannot undo the new chapter reset or replace its link-return position', () => {
  const h = harness(); h.chapter(document.sections[linkedIndex - 1]);
  const old = h.sheet(); old.props.onContentScroll(1601.5);
  h.action('Next');
  assert.equal(h.sheet().props.initialScrollOffset, 0);
  assert.notEqual(h.sheet().props.contentKey, old.props.contentKey);
  old.props.onContentScroll(1601.5); // RNW may deliver the old 100ms scroll-end callback after unmount.
  assert.equal(h.sheet().props.initialScrollOffset, 0);
  const current = h.sheet(); current.props.onContentScroll(420.75);
  old.props.onContentScroll(1999);
  h.preview();
  assert.equal(h.sheet().props.initialScrollOffset, 0);
  current.props.onContentScroll(999); // The chapter has now been replaced by its link confirmation.
  const confirmation = h.sheet(); confirmation.props.onClose();
  assert.equal(h.sheet().props.initialScrollOffset, 420.75);
  confirmation.props.onContentScroll(888);
  assert.equal(h.sheet().props.initialScrollOffset, 420.75);
  assert.equal(h.render().filter(node => node.type === 'Sheet').length, 1);
  assert.equal(h.sheet().key, undefined, 'only content is keyed, never the modal-owning Sheet');
});

test('cancel or close restores the reading position and a late link completion cannot alter another chapter', async () => {
  for (const close of ['button', 'close']) {
    const pending = deferred(); const h = harness({ open: () => pending.promise });
    h.chapter(linkedChapter); h.sheet().props.onContentScroll(712.25); h.preview();
    h.action('Continue to website'); assert.equal(h.opened.length, 1);
    if (close === 'button') h.action('Back to reference'); else { h.sheet().props.onClose(); h.render(); }
    assert.equal(h.sheet().props.initialScrollOffset, 712.25);
    h.action('Next'); const next = h.sheet();
    assert.equal(next.props.initialScrollOffset, 0);
    pending.resolve(); await h.flush();
    assert.equal(h.sheet().props.contentKey, next.props.contentKey);
    assert.equal(h.sheet().props.initialScrollOffset, 0);
    assert.equal(h.backCount, 0);
  }
});

test('successful link opening restores its chapter and reopening a closed chapter starts at the top', async () => {
  const h = harness(); h.chapter(linkedChapter); const original = h.sheet(); original.props.onContentScroll(533.5);
  h.preview(); h.action('Continue to website'); await h.flush();
  assert.equal(h.sheet().props.title, linkedChapter.title);
  assert.equal(h.sheet().props.initialScrollOffset, 533.5);
  const returned = h.sheet(); returned.props.onClose(); h.render();
  returned.props.onContentScroll(1777);
  h.chapter(linkedChapter);
  assert.equal(h.sheet().props.initialScrollOffset, 0);
  assert.equal(h.opened.length, 1); assert.equal(h.backCount, 0);
});
