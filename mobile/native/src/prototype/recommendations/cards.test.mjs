import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('./core.ts');
test.after(() => resolver.deregister());
const source = ts.transpileModule(readFileSync(new URL('./cards.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props) => ({ type, props });
function nodes(tree, output = []) {
  if (Array.isArray(tree)) tree.forEach(node => nodes(node, output));
  else if (tree && typeof tree === 'object') { output.push(tree); nodes(tree.props?.children, output); }
  return output;
}
const candidate = { id: 'provider:ifind', title: '同花顺 iFinD', description: '服务描述', reason: '可帮你查阅企业财务资料', kind: 'plugin', access: 'authorize', connection_id: null,
  connection_revision: null, module: null, provider_id: 'ifind', bank_id: null, capability_version: '1', price_note: '按供应商账号权益提供服务' };
function harness(locale = 'zh') {
  let haptics = 0;
  const colors = { surface: '#fff', line: '#eee', accent: '#08789B', accentBg: '#EAF6FA', onAccent: '#fff', soft: '#f4f7f9', ink: '#202B33', muted: '#65737E', danger: '#B74444' };
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' },
    'lucide-react-native': { ArrowUpRight: 'ArrowUpRight', ChevronRight: 'ChevronRight', Layers3: 'Layers3' },
    '../design': { Type: 'Type', useDesign: () => ({ colors, text: (zh, en) => locale === 'en' ? en : zh }) },
    '../motion': { selectionFeedback: () => haptics++ }, './core': core,
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: name => imports[name] });
  return { render: props => nodes(module.exports.RecommendationCards(props)), haptics: () => haptics, colors };
}

test('cards keep native accessible actions, one primary action and full readable labels', () => {
  for (const locale of ['zh', 'en']) {
    const h = harness(locale), selected = [];
    const record = { candidates: [candidate, { ...candidate, id: 'second', access: 'ready' }] };
    const tree = h.render({ record, onSelect: value => selected.push(value) });
    const buttons = tree.filter(node => node.type === 'Pressable');
    assert.equal(buttons.length, 2);
    assert.match(buttons[0].props.accessibilityLabel, locale === 'en' ? /Authorize/ : /完成授权/);
    assert.equal(buttons[0].props.accessibilityRole, 'button');
    assert.ok(buttons.every(button => button.props.style({ pressed: false }).minHeight >= 48));
    assert.equal(buttons[0].props.style({ pressed: false }).backgroundColor, h.colors.accent);
    assert.equal(buttons[1].props.style({ pressed: false }).backgroundColor, h.colors.soft);
    assert.equal(tree.some(node => node.type === 'Type' && node.props.numberOfLines), false, 'Dynamic Type may wrap all descriptions and labels');
    assert.equal(selected.length, 0, 'rendering cannot select a service');
    buttons[0].props.onPress(); assert.deepEqual(selected, [candidate]); assert.equal(h.haptics(), 1);
  }
});

test('busy and unavailable states remain visible but cannot be selected; merged actions disappear', () => {
  const h = harness();
  for (const options of [{ busyId: candidate.id }, { disabled: true }, { record: { candidates: [{ ...candidate, access: 'unavailable' }] } }]) {
    const tree = h.render({ record: { candidates: [candidate] }, onSelect() {}, ...options });
    const button = tree.find(node => node.type === 'Pressable');
    assert.equal(button.props.disabled, true); assert.equal(button.props.accessibilityState.disabled, true);
  }
  const busy = h.render({ record: { candidates: [candidate] }, busyId: candidate.id, onSelect() {} });
  assert.ok(busy.some(node => node.type === 'ActivityIndicator'));
  assert.equal(h.render({ record: { candidates: [{ ...candidate, kind: 'module', module: 'market-data' }] }, actions: [{ module: 'market-data' }], onSelect() {} }).length, 0);
});
