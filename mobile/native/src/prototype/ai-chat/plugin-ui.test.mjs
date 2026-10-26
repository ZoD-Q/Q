import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as messages from './messages.ts';
import * as stateModel from './state-model.ts';
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
const icons = Object.fromEntries(['ArrowUp', 'ArrowLeft', 'Check', 'ChevronDown', 'Lightbulb', 'Paperclip', 'Plus', 'Search', 'SlidersHorizontal', 'SquarePen', 'Square', 'RotateCcw', 'RefreshCw', 'X'].map(name => [name, name]));

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
  if (tree?.type === 'Sheet' && !tree.props.visible) return result;
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (tree && typeof tree === 'object') { result.push(tree); nodes(tree.props?.children, result); }
  return result;
}
const bank = { id: '22222222-2222-4222-8222-222222222222', title: 'HSBC demo', endpoint_url: 'urn:q:bank-demo:hsbc', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc' };

test('selected-bank chat keeps model availability and its working refresh action visible', () => {
  const { ChatPage } = component('../chat.tsx', {
    'react-native': Object.fromEntries(['KeyboardAvoidingView', 'Pressable', 'ScrollView', 'TextInput', 'View'].map(name => [name, name])),
    'react-native-reanimated': { useReducedMotion: () => false },
    'react-native-svg': { default: 'Svg', Path: 'Path', Circle: 'Circle' },
    './design': design, './motion': { Reveal: 'Reveal', selectionFeedback: noop },
    './ai-chat/state-model': stateModel, './ai-chat/auth-sheet': { ChatAuthSheet: 'ChatAuthSheet' },
    './ai-chat/messages': messages, './plugin-host/chat-proposal': { ChatProposal: 'ChatProposal' },
    './plugin-host/core': core, './banking/transfer-composer': { BankTransferComposer: 'BankTransferComposer' },
    './privacy': { openPrivacyPolicy: noop },
  });
  let checks = 0;
  const controller = { conversation: null, draft: '', setDraft: noop, model: 'deepseek-flash', setModel: noop, think: false, setThink: noop, plugin: bank, status: { configured: false }, statusPhase: 'unconfigured', statusBusy: false, statusError: '', reconnect: () => { checks++; } };
  for (const statusPhase of ['unconfigured', 'error']) {
    controller.statusPhase = statusPhase;
    const tree = nodes(ChatPage({ controller, onOpenPlugins: noop }));
    const check = tree.find(node => node.type === 'Action' && node.props.label === '重新检查');
    assert.ok(check, statusPhase); check.props.onPress();
    assert.equal(tree.some(node => node.type === 'Type' && typeof node.props.children === 'string' && /DeepSeek 理解你的请求|插件对话关闭深度思考/.test(node.props.children)), false);
    assert.equal(tree.some(node => node.type === 'Action' && ['查询余额', '填写转账'].includes(node.props.label)), false);
    assert.ok(tree.some(node => node.type === 'IconAction' && node.props.label === '移除插件'));
  }
  assert.equal(checks, 2);
  controller.statusPhase = 'ready'; controller.status = { configured: true };
  assert.equal(nodes(ChatPage({ controller, onOpenPlugins: noop })).some(node => node.props?.label === '重新检查'), false);
  let syncs = 0, reloads = 0;
  controller.historyError = 'VALIDATION_ERROR'; controller.retryHistory = () => { syncs++; }; controller.reloadCloud = () => { reloads++; };
  const failed = nodes(ChatPage({ controller, onOpenPlugins: noop }));
  const notice = failed.find(node => node.type === 'Type' && node.props.children === messages.historyErrorMessage('VALIDATION_ERROR', zh => zh));
  assert.ok(notice, 'history recovery stays readable without a machine code');
  assert.doesNotMatch(notice.props.children, /重新登录|检查网络|VALIDATION_ERROR/);
  failed.find(node => node.type === 'Action' && node.props.label === '重试同步').props.onPress();
  failed.find(node => node.type === 'Action' && node.props.label === '重载云端版本（替换本机未保存内容）').props.onPress();
  assert.equal(syncs, 1); assert.equal(reloads, 1);

  let resumes = 0;
  controller.historyError = ''; controller.session = { token: 'fixture', user: { handle: 'fixture' } }; controller.resumeTool = () => { resumes++; };
  controller.conversation = { id: 'c', title: 'Query', plugin: bank, messages: [{ id: 'u', role: 'user', content: '查询余额', status: 'complete' }, { id: 'tool', role: 'assistant', content: '', status: 'tool', toolProposalId: bank.id }] };
  controller.busy = true;
  const pendingCard = nodes(ChatPage({ controller, onOpenPlugins: noop })).find(node => node.type === 'ChatProposal');
  assert.equal(pendingCard.props.disabled, true); assert.equal(pendingCard.props.onContinue, undefined);
  controller.busy = false; controller.toolResumeTarget = { conversationId: 'c', messageId: 'tool', invocationId: bank.id };
  const recovering = nodes(ChatPage({ controller, onOpenPlugins: noop }));
  recovering.find(node => node.type === 'Action' && node.props.label === '继续回答').props.onPress(); assert.equal(resumes, 1);
  controller.conversation.messages.push({ id: 'reply', role: 'assistant', content: '模拟余额 HK$100,000。', status: 'complete', toolInvocationIds: [bank.id] });
  const answeredCard = nodes(ChatPage({ controller, onOpenPlugins: noop })).find(node => node.type === 'ChatProposal');
  assert.equal(answeredCard.props.mediaOnly, true); assert.equal(answeredCard.props.onContinue, undefined);

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
