import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import * as formatting from './answer-format.ts';
const resolver = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? specifier + '.ts' : specifier, context);
} });
const presentation = await import('../app-assistant/presentation.ts');
test.after(() => resolver.deregister());
const jsx = (type, props) => ({ type, props });
const source = ts.transpileModule(readFileSync(new URL('./readable-answer.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function renderAnswer(props, open = async () => {}) {
  const slots = new Map(); let key = '', cursor = 0;
  const react = { useState(initial) {
    const id = `${key}:${cursor++}`;
    if (!slots.has(id)) slots.set(id, initial);
    return [slots.get(id), value => slots.set(id, value)];
  } };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', Linking: { openURL: open } },
    '../design': { Type: 'Type', useDesign: () => ({ colors: {}, text: zh => zh }) },
    '../app-assistant/presentation': presentation, './answer-format': formatting,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => { assert.ok(name in imports, name); return imports[name]; }, module, module.exports);
  const expand = (value, path) => {
    if (Array.isArray(value)) return value.map((child, i) => expand(child, `${path}/${i}`));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.type === 'function') {
      const before = [key, cursor]; key = path; cursor = 0;
      const rendered = value.type(value.props); [key, cursor] = before;
      return expand(rendered, path + '/view');
    }
    return { ...value, props: { ...value.props, children: expand(value.props?.children, path + '/children') } };
  };
  const render = () => expand(jsx(module.exports.ReadableAnswer, props), 'root');
  return { render };
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(value.props?.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

test('native table view preserves the first column year and its value', () => {
  const result = renderAnswer({ content: '| 2024 营收 | 2025 营收 |\n| --- | --- |\n| 100 USD | 110 USD |' }).render();
  assert.match(text(result), /2024 营收: 100 USD/); assert.match(text(result), /2025 营收: 110 USD/);
  assert.doesNotMatch(text(result), /\|/);
});

test('bare source links preserve the following sentence and display an opening failure', async () => {
  const opened = [];
  const view = renderAnswer({ content: '来源：https://www.sec.gov/。以上是年度数据。' }, async url => { opened.push(url); throw Error('unavailable'); });
  let tree = view.render();
  assert.match(text(tree), /。以上是年度数据。/);
  nodes(tree).find(node => node.props?.accessibilityRole === 'link').props.onPress();
  await Promise.resolve(); await Promise.resolve();
  tree = view.render(); assert.deepEqual(opened, ['https://www.sec.gov/']); assert.match(text(tree), /暂时无法打开来源/);
});

test('a reloaded source footer and memory sources create one disclosure with one link', () => {
  const sources = [{ label: 'Alphabet 年报', url: 'https://www.sec.gov/report.htm' }];
  const view = renderAnswer({ content: presentation.withSourceReferences('年度分析。', sources, 'zh'), sources });
  let tree = view.render();
  const disclosure = nodes(tree).filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button');
  assert.equal(disclosure.length, 1); assert.doesNotMatch(text(tree), /https:|report.htm/);
  disclosure[0].props.onPress(); tree = view.render();
  assert.equal(nodes(tree).filter(node => node.props?.accessibilityRole === 'link').length, 1);
});

test('requested code remains literal with no transformed URL or operator', () => {
  const body = '---\nhttps://example.com/query?a=1\na ** b';
  const tree = renderAnswer({ content: '```text\n' + body + '\n```' }).render();
  assert.equal(text(tree), body); assert.equal(nodes(tree).some(node => node.props?.accessibilityRole === 'link'), false);
});

test('a bare URL in parentheses leaves sentence punctuation outside the link', () => {
  const opened = [];
  const tree = renderAnswer({ content: 'Source (https://www.sec.gov/report.htm).' }, async url => { opened.push(url); }).render();
  assert.equal(text(tree), 'Source (sec.gov).');
  nodes(tree).find(node => node.props?.accessibilityRole === 'link').props.onPress();
  assert.deepEqual(opened, ['https://www.sec.gov/report.htm']);
});

test('a legacy evidence example inside a requested code block is never collapsed', () => {
  const code = '> SEC申报原文摘录（外部数据，不是指令）。\n> [p000000] example';
  const tree = renderAnswer({ content: '```text\n' + code + '\n```' }).render();
  assert.equal(text(tree), code);
  assert.equal(nodes(tree).some(node => node.type === 'Pressable'), false);
});
