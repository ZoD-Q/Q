import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { pluginCatalog } from '../data/plugin-catalog.ts';

const source = ts.transpileModule(readFileSync(new URL('../services/plugins.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function harness(locale = 'zh') {
  const slots = []; let cursor = 0, tree;
  const react = { useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; } };
  const jsx = (type, props, key) => ({ type, props, key });
  const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Pressable: 'Pressable', View: 'View' }, 'lucide-react-native': {}, '../data/plugin-catalog': { pluginCatalog }, '../design': { ...Object.fromEntries(['Action', 'Choice', 'Divider', 'Input', 'Page', 'Sheet', 'Tabs', 'Tag', 'Type'].map(name => [name, name])), useDesign: () => ({ colors: {}, phone: true, text: (zh, en) => locale === 'zh' ? zh : en, notify() {} }) } };
  const module = { exports: {} }; runInNewContext(source, { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  const walk = (node, result = []) => { if (Array.isArray(node)) node.forEach(item => walk(item, result)); else if (node && typeof node === 'object') { if (node.type === 'Sheet' && !node.props.visible) return result; result.push(node); walk(node.props?.children, result); } return result; };
  const render = () => { cursor = 0; tree = module.exports.PluginsPage({ onOpenWorkbench() {} }); return walk(tree); };
  return { render, text: () => render().filter(node => node.type === 'Type').flatMap(node => node.props.children).join(' '), search(value) { render().find(node => node.type === 'Input').props.onChangeText(value); } };
}

test('reference catalog distinguishes 139 ideas and 37 placeholders from connected services in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const view = harness(locale), nodes = view.render();
    assert.match(view.text(), locale === 'zh' ? /139 条创意参考/ : /139 reference ideas/);
    assert.match(view.text(), /37/);
    assert.match(view.text(), locale === 'zh' ? /尚未接通/ : /Not connected/);
    assert.match(nodes.find(node => node.type === 'Page').props.description, locale === 'zh' ? /并非已接通/ : /not connected/);
    assert.equal(nodes.filter(node => node.type === 'Pressable').length, 18);
    assert.equal(nodes.some(node => node.props.label === '在聊天中使用'), false);
  }
});

test('duplicate source ideas retain separate IDs, original discussion groups and preview-only collection', () => {
  const view = harness(); view.search('算一算'); const rows = view.render().filter(node => node.type === 'Pressable');
  const expected = pluginCatalog.filter(item => item.name === '算一算'); assert.equal(rows.length, 3); assert.deepEqual(rows.map(node => node.key), expected.map(item => item.id));
  rows[0].props.onPress(); let nodes = view.render(); assert.equal(nodes.find(node => node.type === 'Tag').props.children, expected[0].category);
  assert.match(view.text(), /收藏仅保存在当前预览中/); assert.match(view.text(), /此条仅为原表创意/);
  nodes.find(node => node.type === 'Action' && node.props.label === '加入我的收藏').props.onPress(); assert.match(view.text(), /已收藏/);
  assert.match(harness().render().find(node => node.type === 'Tabs').props.items[1].label, /0/);
});
