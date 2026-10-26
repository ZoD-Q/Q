import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as messages from './messages.ts';
import * as stateModel from './state-model.ts';
import * as mascotState from './mascot-state.ts';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('../plugin-host/core.ts');
const workbench = await import('../api-workbench/core.ts');
test.after(() => resolver.deregister());

const noop = () => {};
const design = { ...Object.fromEntries(['Action', 'Choice', 'IconAction', 'Input', 'Page', 'Row', 'Sheet', 'Tabs', 'Type'].map(name => [name, name])), useDesign: () => ({ colors: {}, text: zh => zh, phone: false }) };
const react = { useEffect: noop, useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, noop] };
const jsx = (type, props) => ({ type, props });
const icons = Object.fromEntries(['ArrowUp', 'ArrowLeft', 'Check', 'ChevronDown', 'ChevronRight', 'Lightbulb', 'Paperclip', 'Plus', 'Search', 'SlidersHorizontal', 'SquarePen', 'Square', 'RotateCcw', 'RefreshCw'].map(name => [name, name]));

/** Inspect actual component action wiring; native layout is verified separately. */
function component(path, imports) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const common = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react-native': icons };
  runInNewContext(source, { module, exports: module.exports, process: { env: { EXPO_OS: 'ios' } }, require: name => {
    const provided = { ...common, ...imports };
    assert.ok(name in provided, `Unmocked component dependency: ${name}`);
    return provided[name];
  } });
  return module.exports;
}
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (tree && typeof tree === 'object') { result.push(tree); nodes(tree.props?.children, result); }
  return result;
}
const bank = { id: '22222222-2222-4222-8222-222222222222', title: 'HSBC demo', endpoint_url: 'urn:q:bank-demo:hsbc', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc' };

test('selected-bank chat keeps model availability and its working refresh action discoverable', () => {
  const slots = [];
  let cursor = 0;
  const statefulReact = { ...react, useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  } };
  const { ChatPage } = component('../chat.tsx', {
    react: statefulReact,
    'react-native': {
      ...Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'TextInput', 'View'].map(name => [name, name])),
      Keyboard: { addListener: () => ({ remove: noop }) },
      useWindowDimensions: () => ({ width: 1024, height: 768, fontScale: 1, scale: 1 }),
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    'react-native-reanimated': { useReducedMotion: () => false },
    './design': design, './motion': { Reveal: 'Reveal', selectionFeedback: noop },
    './ai-chat/state-model': stateModel, './ai-chat/auth-sheet': { ChatAuthSheet: 'ChatAuthSheet' },
    './ai-chat/mascot-state': mascotState, './ai-chat/q-companion': { QCompanion: 'QCompanion' },
    './ai-chat/messages': messages, './plugin-host/chat-proposal': { ChatProposal: 'ChatProposal' },
    './plugin-host/core': core, './banking/transfer-composer': { BankTransferComposer: 'BankTransferComposer' },
    './privacy': { openPrivacyPolicy: noop },
  });
  let checks = 0;
  const controller = { conversation: null, phase: 'idle', draft: '', setDraft: noop, model: 'deepseek-flash', setModel: noop, think: false, setThink: noop, plugin: bank, status: { configured: false }, statusPhase: 'unconfigured', statusBusy: false, statusError: '', reconnect: () => { checks++; } };
  const render = () => { cursor = 0; return nodes(ChatPage({ controller, onOpenPlugins: noop })); };
  const statusSheet = tree => tree.find(node => node.type === 'Sheet' && node.props.title === '对话状态');
  for (const statusPhase of ['unconfigured', 'error']) {
    controller.statusPhase = statusPhase;
    let tree = render();
    assert.equal(statusSheet(tree).props.visible, false);
    const notice = tree.find(node => node.type === 'Pressable' && node.props.testID === 'chat-notice');
    assert.ok(notice, `${statusPhase}: a discoverable notice opens status details`);
    assert.equal(notice.props.accessibilityRole, 'button');
    assert.match(notice.props.accessibilityLabel, /查看详情/);
    notice.props.onPress();
    tree = render();
    const sheet = statusSheet(tree);
    assert.equal(sheet.props.visible, true, `${statusPhase}: notice opens the status sheet`);
    const check = nodes(sheet).find(node => node.type === 'Action' && node.props.label === '重新检查连接');
    assert.ok(check, `${statusPhase}: refresh stays inside status details`);
    assert.equal(check.props.disabled, false);
    assert.equal(check.props.onPress, controller.reconnect);
    check.props.onPress();
    assert.ok(tree.some(node => node.type === 'Type' && typeof node.props.children === 'string' && node.props.children.includes('DeepSeek 理解你的请求')));
    sheet.props.onClose();
    assert.equal(statusSheet(render()).props.visible, false);
  }
  assert.equal(checks, 2);
  controller.statusPhase = 'ready'; controller.status = { configured: true };
  const ready = render();
  assert.equal(ready.some(node => node.props?.testID === 'chat-notice'), false);
  assert.equal(ready.some(node => node.props?.label === '重新检查连接'), false);
  let syncs = 0, reloads = 0;
  controller.historyError = 'VALIDATION_ERROR'; controller.retryHistory = () => { syncs++; }; controller.reloadCloud = () => { reloads++; };
  let failed = render();
  const historyNotice = failed.find(node => node.type === 'Pressable' && node.props.testID === 'chat-notice');
  assert.ok(historyNotice, 'a failed history sync remains discoverable outside the sheet');
  assert.match(historyNotice.props.accessibilityLabel, /记录尚未同步/);
  assert.equal(statusSheet(failed).props.visible, false);
  historyNotice.props.onPress();
  failed = render();
  const sheet = statusSheet(failed);
  assert.equal(sheet.props.visible, true, 'the history notice opens status details');
  const details = nodes(sheet);
  const notice = details.find(node => node.type === 'Type' && Array.isArray(node.props.children) && node.props.children.includes('VALIDATION_ERROR'));
  assert.ok(notice, 'history error retains its stable diagnostic code');
  assert.equal(notice.props.children[0], messages.historyErrorMessage('VALIDATION_ERROR', zh => zh));
  assert.doesNotMatch(notice.props.children[0], /重新登录|检查网络/);
  const sync = details.find(node => node.type === 'Action' && node.props.label === '重试同步');
  const reload = details.find(node => node.type === 'Action' && node.props.label === '重载云端版本（替换未保存内容）');
  assert.ok(sync, 'sync recovery stays available within status details');
  assert.ok(reload, 'cloud reload stays available within status details');
  sync.props.onPress(); reload.props.onPress();
  assert.equal(syncs, 1); assert.equal(reloads, 1);
});

test('completed bank errors can continue with the model but never repeat confirmation', () => {
  let continues = 0, requests = 0;
  const { InvocationView } = component('../plugin-host/page.tsx', {
    'react-native': { ActivityIndicator: 'ActivityIndicator', Linking: {}, View: 'View' },
    'expo-crypto': { randomUUID: () => 'unused' }, '../design': design,
    '../api-workbench/core': workbench, '../ai-chat/auth-sheet': { ChatAuthSheet: 'ChatAuthSheet' },
    '../services/plugins': { PluginsPage: 'PluginsPage' },
    './client': { pluginRequest: () => { requests++; throw Error('Unexpected plugin request'); } }, './core': core,
    './result-view': { PluginResultView: 'PluginResultView', ResourceViewer: 'ResourceViewer' },
    '../plugin-workbench/materials': {}, '../banking/proposal': { BankProposalView: 'BankProposalView' },
    '../banking/plugin-catalog': { BankPluginCatalog: 'BankPluginCatalog' },
  });
  for (const status of ['succeeded', 'tool_error', 'awaiting_confirmation', 'running', 'unknown', 'failed', 'cancelled', 'expired']) {
    const invocation = { ...bank, id: '55555555-5555-4555-8555-555555555555', connection_id: bank.id, connection_title: bank.title, card_url: bank.endpoint_url, tool_name: 'bank_transfer', arguments: { to_bank_id: 'bochk', recipient: 'demo_chen', amount_minor: 20000 }, status, result: { content: [] } };
    const tree = nodes(InvocationView({ invocation, token: 'fixture', onChanged: noop, onContinue: () => { continues++; } }));
    assert.ok(tree.some(node => node.type === 'BankProposalView'), 'bank transfer confirmation stays in its original component');
    const continuation = tree.find(node => node.type === 'Action' && node.props.label === '让小Q继续回答');
    assert.equal(!!continuation, ['succeeded', 'tool_error'].includes(status), status);
    continuation?.props.onPress();
  }
  assert.equal(continues, 2);
  assert.equal(requests, 0, 'continuation only calls the model callback, never the confirmation endpoint');
});
