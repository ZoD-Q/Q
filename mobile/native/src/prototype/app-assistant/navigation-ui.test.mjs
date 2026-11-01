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
const app = await import('./core.ts');
const insurance = await import('../insurance/catalog.ts');
const market = await import('../market-data/core.ts');
const messages = await import('../ai-chat/messages.ts');
const stateModel = await import('../ai-chat/state-model.ts');
const mascot = await import('../ai-chat/mascot-state.ts');
const plugins = await import('../plugin-host/core.ts');
test.after(() => resolver.deregister());

const noop = () => {};
const jsx = (type, props) => ({ type, props });
function nodes(tree, result = []) {
  if (Array.isArray(tree)) { tree.forEach(child => nodes(child, result)); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (['Sheet', 'Modal'].includes(tree.type) && !tree.props.visible) return result;
  result.push(tree); nodes(tree.props?.children, result); return result;
}

/** Real TSX and event handlers; native layout is checked separately. */
function component(path, exportName, imports, options = {}) {
  const slots = [], notices = [], openedUrls = [];
  let cursor = 0, dirty = false, effects = [], tree, props = options.props ?? {};
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; dirty = true; }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useReducer(reducer, initial) { const [value, setValue] = react.useState(initial); return [value, action => setValue(current => reducer(current, action))]; },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || !dependencies || dependencies.some((value, position) => value !== slots[index].dependencies?.[position])) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { dependencies };
        effects.push(() => { cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const text = (zh, en) => options.locale === 'en' ? en : zh;
  const notify = value => notices.push(value);
  const design = { ...Object.fromEntries(['Action', 'Choice', 'Divider', 'IconAction', 'Input', 'Page', 'Row', 'Sheet', 'Tabs', 'Tag', 'Type'].map(name => [name, name])),
    useDesign: () => ({ colors: {}, text, notify, locale: options.locale ?? 'zh', phone: true, notice: '' }) };
  const native = { ...Object.fromEntries(['KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'TextInput', 'View'].map(name => [name, name])),
    Keyboard: { addListener: () => ({ remove: noop }) }, AppState: { currentState: 'active', addEventListener: () => ({ remove: noop }) },
    BackHandler: { addEventListener: () => ({ remove: noop }) }, Linking: { openURL: async url => openedUrls.push(url) },
    useWindowDimensions: () => ({ width: 393, height: 852, fontScale: 1, scale: 3 }) };
  const common = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    'react-native-reanimated': { useReducedMotion: () => false },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    'lucide-react-native': new Proxy({}, { get: (_, name) => String(name) }),
    './design': design, '../design': design,
  };
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, URL, AbortController, setTimeout, clearTimeout, process: { env: { EXPO_OS: 'ios' } },
    require: name => { const available = { ...common, ...imports }; assert.ok(name in available, `Unmocked component dependency: ${name}`); return available[name]; } });
  const render = patch => {
    props = { ...props, ...patch };
    let iterations = 0;
    do {
      assert.ok(++iterations < 12, 'component must settle'); dirty = false; cursor = 0;
      tree = module.exports[exportName](props);
      const pending = effects; effects = []; pending.forEach(effect => effect());
    } while (dirty);
    return nodes(tree);
  };
  return { render, notices, openedUrls, get tree() { return tree; } };
}

function chatHarness(overrides = {}, options = {}) {
  const calls = [];
  const controller = { conversation: null, phase: 'idle', busy: false, draft: 'Unsent text must survive', setDraft: value => calls.push(['draft', value]),
    model: 'deepseek-flash', setModel: noop, think: false, setThink: noop, status: { configured: true, app_tools_version: 1 }, statusPhase: 'ready',
    newConversation: () => calls.push(['new']), send: () => calls.push(['send']), retry: () => calls.push(['retry']),
    resumeAppResult: id => calls.push(['resume', id]), ...overrides };
  const h = component('../chat.tsx', 'ChatPage', {
    './motion': { Reveal: 'Reveal', selectionFeedback: noop }, './app-assistant/core': app,
    './ai-chat/state-model': stateModel, './ai-chat/auth-sheet': { ChatAuthSheet: 'ChatAuthSheet' },
    './ai-chat/mascot-state': mascot, './ai-chat/q-companion': { QCompanion: 'QCompanion' },
    './ai-chat/messages': messages, './plugin-host/chat-proposal': { ChatProposal: 'ChatProposal' },
    './plugin-host/core': plugins, './banking/transfer-composer': { BankTransferComposer: 'BankTransferComposer' },
    './privacy': { openPrivacyPolicy: noop }, './finance-agent/panel': { FinanceTaskSheet: 'FinanceTaskSheet' },
    './finance-agent/result-card': { FinanceResultCard: 'FinanceResultCard' }, './finance-ads': { FinanceAdSettings: 'FinanceAdSettings' },
  }, { ...options, props: { controller, onOpenPlugins: noop, onOpenFinancialService: noop, onOpenMarketData: noop,
    onOpenAppAction: action => calls.push(['open', action]) } });
  return { ...h, controller, calls };
}

test('features sheet offers validated native navigation only after a click without clearing or sending the draft', () => {
  for (const locale of ['zh', 'en']) {
    const h = chatHarness({}, { locale });
    const first = h.render();
    assert.deepEqual(h.calls, []);
    first.find(node => node.type === 'Action' && node.props.label === (locale === 'en' ? 'What can Q do?' : '小Q能帮什么')).props.onPress();
    const sheet = h.render().find(node => node.type === 'Sheet' && node.props.title === (locale === 'en' ? 'Features in Q' : '小Q里的功能'));
    assert.ok(sheet); assert.deepEqual(h.calls, []);
    const actions = nodes(sheet).filter(node => node.type === 'Action');
    assert.equal(actions.length, app.APP_MODULES.length);
    actions.find(node => node.props.label === app.createAppNavigationAction('insurance', locale).label).props.onPress();
    assert.deepEqual(h.calls, [['open', app.createAppNavigationAction('insurance', locale)]]);
    assert.equal(h.controller.draft, 'Unsent text must survive');
    assert.equal(h.render().some(node => node.type === 'Sheet' && node.props.title === sheet.props.title), false);
  }
});

test('saved result actions and explanation retry invoke their own callbacks without repeating generic send', () => {
  const action = app.createAppNavigationAction('insurance', 'zh', { insuranceIds: ['medical', 'critical'] });
  const h = chatHarness({ conversation: { id: 'chat-fixture', title: 'Coverage', messages: [{ id: 'u', role: 'user', content: 'Compare', status: 'complete' }, { id: 'a', role: 'assistant', content: 'Saved public result', status: 'error', errorCode: 'AI_TIMEOUT' }] },
    appActions: { a: [action] }, canResumeAppResult: id => id === 'a' });
  const tree = h.render(); assert.deepEqual(h.calls, []);
  tree.find(node => node.type === 'Action' && node.props.label === action.label).props.onPress();
  tree.find(node => node.type === 'Action' && node.props.label === '继续解释已取得资料').props.onPress();
  assert.deepEqual(h.calls, [['open', action], ['resume', 'a']]);
  h.controller.busy = true;
  assert.ok(h.render().filter(node => node.type === 'Action' && [action.label, '继续解释已取得资料'].includes(node.props.label)).every(node => node.props.disabled));
});

test('insurance entry applies actual query/group filters and only opens comparisons with at least two selected types', () => {
  const imports = { './catalog': insurance, '../finance-ads': { FinanceAdPlacement: 'FinanceAdPlacement', FinanceAdSettings: 'FinanceAdSettings' } };
  const expected = insurance.findInsurance('医疗', 'health');
  const h = component('../insurance/page.tsx', 'InsuranceDashboard', imports, { props: { initialEntry: { query: '医疗', group: 'health' } } });
  const tree = h.render();
  assert.equal(tree.find(node => node.type === 'Input').props.value, '医疗');
  assert.ok(tree.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === '健康医疗').props.accessibilityState.selected);
  const titles = tree.filter(node => node.type === 'Row').map(node => node.props.title);
  assert.deepEqual(titles, expected.map(item => item.title[0]));
  assert.equal(h.openedUrls.length, 0);
  const two = insurance.insuranceTypes.slice(0, 2).map(item => item.id);
  for (const count of [1, 2]) {
    const selected = component('../insurance/page.tsx', 'InsuranceDashboard', imports, { props: { initialEntry: { insuranceIds: two.slice(0, count) } } });
    const comparison = selected.render().find(node => node.type === 'Sheet' && node.props.title === '保障方向对比');
    assert.equal(Boolean(comparison), count === 2);
    const detail = selected.render().find(node => node.type === 'Sheet' && node.props.title === insurance.insuranceTypes[0].title[0]);
    assert.equal(Boolean(detail), count === 1, 'one selected entry opens its actual coverage details');
    if (comparison) for (const item of insurance.insuranceTypes.slice(0, 2)) assert.ok(nodes(comparison).some(node => node.type === 'Type' && node.props.children === item.title[0]));
    assert.equal(selected.openedUrls.length, 0);
  }
});

test('market initial query selects the requested source without fetching until its explicit query action', () => {
  const selected = [], requests = [];
  const query = { kind: 'filings', company: 'NVDA' };
  const h = component('../market-data/page.tsx', 'MarketDataPage', {
    './core': market, './use-market-data': { useMarketData(value) { selected.push(value); return { report: null, phase: 'idle', run: () => requests.push(value), cancel: noop }; } },
  }, { props: { active: true, initialQuery: query, onAnalyze: async () => true } });
  const tree = h.render();
  assert.deepEqual(selected, [query]); assert.deepEqual(requests, []);
  assert.ok(tree.find(node => node.props.label === 'NVDA · 英伟达').props.selected);
  const queryButton = tree.find(node => node.props.label === '查询公开资料');
  queryButton.props.onPress();
  assert.deepEqual(requests, [query]);
});

function shellHarness() {
  let revision = 4, previousVisible = true;
  const pushes = [], called = [];
  const controller = { items: [], session: { user: { id: 'owner-a', display_name: 'Fixture' } }, draft: 'Keep draft', privacyEpoch: 0, busy: false, historyBusy: false,
    newConversation: () => called.push('new'), setDraft: () => called.push('draft'), openConversation: () => called.push('open') };
  const h = component('../app-shell.tsx', 'PrototypeApp', {
    './motion': { Reveal: 'Reveal', selectionFeedback: noop }, 'expo-router': { router: { push: path => pushes.push(path) } },
    'expo-router/react-navigation': { useIsFocused: () => true }, './chat': { ChatPage: 'ChatPage', HistoryPage: 'HistoryPage' },
    './account-pages': { ProfilePage: 'ProfilePage' }, './services': { ServicePage: 'ServicePage' },
    './video/video-create': { VideoCreate: 'VideoCreate' }, './video/creator-feed': { CreatorFeed: 'CreatorFeed' },
    './ai-chat/use-chat': { useChat(visible) { if (visible !== previousVisible) { controller.privacyEpoch++; previousVisible = visible; } return controller; } },
    './plugin-workbench/workbench': { PluginWorkbenchPage: 'PluginWorkbenchPage' }, './plugin-host/page': { PluginHostPage: 'PluginHostPage' },
    './plugin-host/core': plugins, './account/account-state': { useQAccount: () => ({ session: controller.session }) },
    './social': { useSocial: () => ({ unreadCount: 0 }) }, './market-data/page': { MarketDataPage: 'MarketDataPage' },
    './app-assistant/core': app, '../services/session-store': { getSessionRevision: () => revision },
  });
  return { ...h, controller, called, pushes, bumpRevision() { revision++; } };
}

test('shell preserves validated task conditions across visibility changes and drops them across identity revisions', () => {
  const h = shellHarness();
  const action = app.createAppNavigationAction('insurance', 'zh', { query: '医疗', group: 'health' });
  h.render().find(node => node.type === 'ChatPage').props.onOpenAppAction(action);
  const service = h.render().find(node => node.type === 'ServicePage');
  assert.equal(h.controller.privacyEpoch, 1, 'simulates the real visibility invalidation');
  assert.deepEqual(service.props.insuranceEntry, action);
  assert.deepEqual(h.called, []); assert.equal(h.controller.draft, 'Keep draft');
  h.bumpRevision();
  assert.equal(h.render().find(node => node.type === 'ServicePage').props.insuranceEntry, undefined);
  const owner = shellHarness();
  owner.render().find(node => node.type === 'ChatPage').props.onOpenAppAction(action);
  owner.controller.session = { user: { id: 'owner-b', display_name: 'Other fixture' } };
  assert.equal(owner.render().find(node => node.type === 'ServicePage').props.insuranceEntry, undefined);
});

test('shell routes validated market and social actions, rejecting malformed navigation without a draft mutation', () => {
  const marketShell = shellHarness(), query = { kind: 'news', topic: 'crypto' };
  marketShell.render().find(node => node.type === 'ChatPage').props.onOpenAppAction(app.createAppNavigationAction('market-data', 'zh', { marketQuery: query }));
  assert.deepEqual(marketShell.render().find(node => node.type === 'MarketDataPage').props.initialQuery, query);
  assert.deepEqual(marketShell.called, []);
  const social = shellHarness();
  const navigate = social.render().find(node => node.type === 'ChatPage').props.onOpenAppAction;
  navigate(app.createAppNavigationAction('social', 'zh'));
  assert.deepEqual(social.pushes, ['/social']); assert.deepEqual(social.called, []);
  navigate({ module: 'social', label: '打开社交消息', marketQuery: query });
  assert.equal(social.notices.length, 1); assert.deepEqual(social.pushes, ['/social']);
  social.controller.busy = true;
  social.render().find(node => node.type === 'ChatPage').props.onOpenAppAction(app.createAppNavigationAction('social', 'zh'));
  assert.deepEqual(social.pushes, ['/social']);
});
