import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('./core.ts'), presentation = await import('./presentation.ts'); resolver.deregister();
const source = ts.transpileModule(readFileSync(new URL('./result-view.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props) => ({ type, props });
const opened = [];
const imports = { react: { memo: fn => fn, useEffect: () => {}, useMemo: fn => fn(), useState: value => [value, () => {}] }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ActivityIndicator: 'Spinner', Image: 'Image', Linking: { openURL: async url => { opened.push(url); } }, PanResponder: { create: () => ({ panHandlers: {} }) }, View: 'View' }, 'lucide-react-native': { ChevronLeft: 'Left', ChevronRight: 'Right' }, '../design': { Action: 'Action', Type: 'Type', useDesign: () => ({ text: zh => zh, colors: {}, phone: true }) }, './core': core, './presentation': presentation, './client': { pluginRequest: () => { throw Error('Rendering must not execute a business tool'); } } };
const module = { exports: {} }; runInNewContext(source, { module, exports: module.exports, require: name => imports[name] });
const all = (tree, result = []) => { if (Array.isArray(tree)) tree.forEach(value => all(value, result)); else if (tree && typeof tree === 'object') { result.push(tree); all(tree.props?.children, result); } return result; };
const value = { content: [{ type: 'text', text: '{"balance_minor":123}' }, { type: 'text', text: 'A readable result' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'resource_link', name: 'Photo', uri: 'private://photo', mimeType: 'image/jpeg', description: 'Artist / CC BY / https://source.test/photo' }, { type: 'resource_link', name: 'Report', uri: 'private://report', mimeType: 'application/pdf' }], structuredContent: { raw: true } };
test('compact plugin results retain readable content and native media without technical payloads', () => {
  const nodes = all(module.exports.PluginResultView({ value, token: 'token', connectionId: 'id', compact: true }));
  const text = nodes.filter(node => node.type === 'Type').map(node => node.props.children).join(' ');
  assert.match(text, /A readable result/); assert.doesNotMatch(text, /balance_minor|private:\/\/|raw/);
  assert.equal(nodes.filter(node => typeof node.type === 'function' && node.type.name === 'InlineImage').length, 1);
  const resource = nodes.find(node => typeof node.type === 'function' && node.type.name === 'ResourceViewer');
  assert.equal(resource.props.resources[0].description, value.content[3].description);
  assert.equal(resource.props.compact, true);
  assert.equal(nodes.some(node => node.type === 'Action' && /数据/.test(node.props.label)), false);
});
test('media-only mode suppresses repeated tool text, status and structured data while retaining images and attribution', () => {
  const nodes = all(module.exports.PluginResultView({ value: { ...value, isError: true }, token: 'token', connectionId: 'id', compact: true, mediaOnly: true }));
  assert.equal(nodes.filter(node => node.type === 'Type').length, 0);
  assert.equal(nodes.filter(node => typeof node.type === 'function').length, 2);
  assert.equal(module.exports.PluginResultView({ value: { content: [{ type: 'text', text: 'Already answered' }] }, token: 'token', connectionId: 'id', mediaOnly: true }), null);
});


test('compact public document links remain actionable without printing the URL or executing unsafe resources', async () => {
  opened.length = 0;
  const value = { content: [
    { type: 'resource_link', name: '下载报告', uri: 'https://files.test/report.pdf', mimeType: 'application/pdf' },
    { type: 'resource_link', name: '私有资源', uri: 'private://report', mimeType: 'application/pdf' },
    { type: 'resource_link', name: 'HTML视图', uri: 'https://files.test/view.html', mimeType: 'text/html' },
    { type: 'resource_link', name: '脚本', uri: 'javascript:alert(1)', mimeType: 'text/plain' },
  ] };
  const nodes = all(module.exports.PluginResultView({ value, token: 'token', connectionId: 'id', compact: true }));
  const actions = nodes.filter(node => node.type === 'Action'); assert.equal(actions.length, 1);
  assert.equal(actions[0].props.label, '下载报告'); actions[0].props.onPress(); await Promise.resolve();
  assert.deepEqual(opened, ['https://files.test/report.pdf']);
  const visible = nodes.filter(node => node.type === 'Type').map(node => node.props.children).join(' ');
  assert.doesNotMatch(visible, /https:|private:|javascript:/);
});
