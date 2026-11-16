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
const core = await import('./core.ts'), workbench = await import('../api-workbench/core.ts'), materials = await import('../plugin-workbench/materials.ts');
resolver.deregister();
const source = ts.transpileModule(readFileSync(new URL('./page.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const id = '11111111-1111-4111-8111-111111111111', invocationId = '22222222-2222-4222-8222-222222222222';
const connection = { id, revision: 1, title: 'Ticket service', name: 'tickets', description: 'Reservations', version: '1', card_url: 'https://tickets.test/card.json', endpoint_url: 'https://tickets.test/mcp', connection_kind: 'remote_mcp', builtin_service_id: null, owner_name: null, status: 'ready', auth_status: 'anonymous', pending_update: false, last_error_code: null, created_at: '2026-10-26', updated_at: '2026-10-26' };
const invocation = { id: invocationId, connection_id: id, connection_revision: 1, connection_title: connection.title, card_url: connection.card_url, endpoint_url: connection.endpoint_url, tool_name: 'reserve_ticket', arguments: { quantity: 2 }, status: 'unknown', result: null, error_code: null, created_at: '2026-10-26', updated_at: '2026-10-26', expires_at: '2026-10-27' };
const noop = () => {};
/** Exercise the real connected page selected from the exported host, without a test-only export. */
function harness(selectedConnection = connection, {initialConnectionId} = {}) {
  let slots = [], cursor = 0, dirty = true, effects = [], tree;
  const calls = [], opened = [], selectedChats = [], financialOpened = [];
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; dirty = true; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useReducer(reducer, initial) { const [value, set] = react.useState(initial); return [value, action => set(value => reducer(value, action))]; },
    useEffect(callback, dependencies) { const index = cursor++; if (!slots[index] || dependencies.some((value, i) => value !== slots[index].dependencies[i])) { slots[index] = { dependencies }; effects.push(callback); } },
  };
  react.useLayoutEffect = react.useEffect;
  const jsx = (type, props) => ({ type, props });
  const design = { ...Object.fromEntries(['Action', 'Choice', 'Input', 'Page', 'Row', 'Sheet', 'Tabs', 'Type'].map(name => [name, name])), useDesign: () => ({ text: zh => zh, colors: {} }) };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { ActivityIndicator: 'Spinner', View: 'View', Linking: { openURL: async url => { opened.push(url); } } },
    'expo-crypto': { randomUUID: () => invocationId }, 'lucide-react-native': { ArrowLeft: 'Left', Plus: 'Plus', RefreshCw: 'Refresh' },
    '../design': design, '../api-workbench/core': workbench, '../ai-chat/auth-sheet': { ChatAuthSheet: 'ChatAuthSheet' }, '../services/plugins': { PluginsPage: 'PluginsPage' }, './core': core,
    './result-view': { PluginResultView: 'PluginResultView', ResourceViewer: 'ResourceViewer' }, '../plugin-workbench/materials': materials, '../banking/proposal': { BankProposalView: 'BankProposalView' }, '../banking/plugin-catalog': { BankPluginCatalog: 'BankPluginCatalog' }, '../financial-plugins/page': { FinancialPluginCatalog: 'FinancialPluginCatalog' },
    './client': { pluginRequest: async (token, path, decode, options) => {
      calls.push({ path, ...options });
      let value;
      if (path === '/v1/plugins/status') value = { available: true, oauth_configured: true, protocol_version: '2026-07-28' };
      else if (path === '/v1/plugins/connections') value = { items: [selectedConnection] };
      else if (path.startsWith('/v1/plugins/invocations?')) value = { items: [invocation] };
      else if (path.endsWith('/tools')) value = { items: [{ name: 'reserve_ticket', title: 'Reserve tickets', description: 'Book a ticket', inputSchema: { type: 'object' } }] };
      else if (path.endsWith('/accept-update')) value = {...selectedConnection, pending_update:false, pending_update_details:null, revision:2, status:'ready'};
      else if (path.endsWith('/oauth/start')) value = { attempt_id: invocationId, authorization_url: 'https://accounts.tickets.test/authorize' };
      else throw Error(`Unexpected request ${path}`);
      return decode(value);
    } },
  };
  const module = { exports: {} }; runInNewContext(source, { module, exports: module.exports, process: { env: { EXPO_OS: 'ios' } }, AbortController, Error, URL, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  const walk = (value, result = []) => {
    if (Array.isArray(value)) value.forEach(item => walk(item, result));
    else if (value && typeof value === 'object') {
      if (value.type === 'Sheet' && !value.props.visible) return result;
      result.push(value);
      if (typeof value.type === 'function' && value.type.name === 'SourceSummary') walk(value.type(value.props), result);
      walk(value.props?.children, result);
    }
    return result;
  };
  const host = module.exports.PluginHostPage({ chat: { authOpen: false, session: { token: 'token' } }, onSelect: value => selectedChats.push(value), onOpenWorkbench: noop, recommendationTarget: initialConnectionId ? {connection_id:initialConnectionId} : null });
  const connected = walk(host).find(node => typeof node.type === 'function' && node.type.name === 'ConnectedPlugins'); assert.ok(connected);
  connected.props.onOpenFinancial = id => financialOpened.push(id);
  slots = []; cursor = 0; effects = [];
  const render = () => { if (dirty) { dirty = false; cursor = 0; tree = connected.type(connected.props); effects.splice(0).forEach(callback => callback()); } return tree; };
  render();
  return {
    calls, opened, selectedChats, financialOpened, hostTabs: walk(host).find(node => node.type === 'Tabs').props.items, nodes: () => walk(render()), text: () => walk(render()).filter(node => node.type === 'Type').map(node => Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children).join(' '),
    async flush() { for (let n = 0; n < 40; n++) { await Promise.resolve(); render(); } },
    select() { const row = walk(render()).find(node => node.type === 'Row' && node.props.title === selectedConnection.title); assert.ok(row); row.props.onPress(); },
    press(label) { const action = walk(render()).find(node => node.type === 'Action' && node.props.label === label); assert.ok(action, label); assert.equal(!!action.props.disabled, false, label); action.props.onPress(); },
  };
}

test('a selected connected plugin stays simple and lazily loads diagnostics only after Advanced settings', async () => {
  const view = harness(); await view.flush(); view.select(); await view.flush();
  assert.equal(view.nodes().find(node => node.type === 'Page').props.description, undefined);
  assert.doesNotMatch(view.text(), /Reservations/);
  assert.equal(view.calls.length, 2); assert.equal(view.calls.some(call => /\/tools|\/invocations/.test(call.path)), false);
  assert.doesNotMatch(view.text(), /reserve_ticket|\/mcp|card\.json|quantity|所有者未声明/);
  assert.match(view.text(), /https:\/\/tickets\.test/);
  assert.equal(view.nodes().some(node => node.props?.label === '在聊天中使用'), true);
  assert.equal(view.nodes().some(node => node.props?.label === '断开此插件'), true);
  view.press('高级设置'); await view.flush();
  assert.equal(view.calls.filter(call => call.path.endsWith('/tools')).length, 1);
  assert.equal(view.calls.filter(call => call.path.startsWith('/v1/plugins/invocations?')).length, 1);
  assert.match(view.text(), /https:\/\/tickets\.test\/mcp/);
  assert.match(view.text(), /Reservations/);
  assert.equal(view.nodes().some(node => node.type === 'Row' && node.props.title === 'Reserve tickets'), true);
  assert.equal(view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'InvocationView').length, 1);
  const before = view.calls.length;
  view.press('收起高级设置'); await view.flush();
  assert.equal(view.calls.length, before); assert.equal(view.calls.some(call => call.method === 'POST'), false);
  assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'InvocationView'), false);
  assert.doesNotMatch(view.text(), /\/mcp|quantity/);
});

test('required authorization, pending OAuth and sensitive update acceptance stay visible outside Advanced settings', async () => {
  const view = harness({ ...connection, status: 'auth_required', auth_status: 'required', pending_update: true, pending_update_details: { candidate: { title: 'Updated tickets', card_url: 'https://new.tickets.test/card', endpoint_url: 'https://new.tickets.test/mcp' }, tools: { added: ['reserve_ticket'] } } });
  await view.flush(); view.select(); await view.flush();
  assert.equal(view.nodes().some(node => node.props?.label === '授权插件'), true);
  assert.equal(view.nodes().some(node => node.props?.label === '确认此更新'), true);
  assert.match(view.text(), /https:\/\/new\.tickets\.test/); assert.doesNotMatch(view.text(), /reserve_ticket|\/mcp/);
  view.press('授权插件'); await view.flush();
  assert.equal(view.nodes().some(node => node.props?.label === '在浏览器中授权'), true);
  assert.equal(view.nodes().some(node => node.props?.label === '我已授权，检查结果'), true);
  assert.equal(view.nodes().some(node => node.props?.label === '确认此更新'), true);
  view.press('在浏览器中授权'); await view.flush(); assert.deepEqual(view.opened, ['https://accounts.tickets.test/authorize']);
  assert.equal(view.calls.some(call => /\/tools|\/invocations/.test(call.path)), false);
});

test('bank source describes a demo account without transport or server implementation language', async () => {
  const view = harness({ ...connection, owner_name: 'Bank internal provider', description: 'Repeated simulated account explanation', card_url: 'urn:q:bank-demo:hsbc', endpoint_url: 'urn:q:bank-demo:hsbc', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc' });
  await view.flush(); view.select(); await view.flush();
  assert.match(view.text(), /模拟账户/); assert.doesNotMatch(view.text(), /服务端|urn:|MCP|所有者未声明|Bank internal provider|Repeated simulated/);
  assert.equal(view.nodes().find(node => node.type === 'Page').props.description, undefined);
});


test('remote provider identity is concise in the list and detail while full declaration stays in Advanced settings', async () => {
  const view = harness({ ...connection, owner_name: 'Tickets Ltd' }); await view.flush();
  const row = view.nodes().find(node => node.type === 'Row' && node.props.title === connection.title);
  assert.match(row.props.subtitle, /提供方：Tickets Ltd/); assert.doesNotMatch(row.props.subtitle, /自声明|认证/);
  view.select(); await view.flush();
  assert.match(view.text(), /提供方：Tickets Ltd/); assert.match(view.text(), /https:\/\/tickets\.test/);
  assert.doesNotMatch(view.text(), /发布者自声明|Reservations/);
  view.press('高级设置'); await view.flush();
  assert.match(view.text(), /所有者：Tickets Ltd（发布者自声明）/); assert.match(view.text(), /Reservations/);
});


test('financial plugins are adjacent to banks and key-managed connections do not offer OAuth', async () => {
 const view=harness({...connection,financial_provider_id:'ifind',status:'auth_required',auth_status:'required'}); await view.flush();
 const ids=view.hostTabs.map(item=>item.id);assert.equal(ids.indexOf('finance'),ids.indexOf('banks')+1);
 view.select();await view.flush();assert.equal(view.nodes().some(node=>node.props?.label==='授权插件'),false);assert.ok(view.nodes().some(node=>node.props?.label==='管理金融插件'));
});


test('managed financial profiles label host-maintained documentation without publisher Card claims', async () => {
 const view=harness({...connection,financial_provider_id:'ifind',owner_name:null,card_url:'https://mcp.51ifind.com/',endpoint_url:'https://api-mcp.51ifind.com:8643/mcp'});await view.flush();view.select();await view.flush();
 assert.match(view.text(),/官方说明来源/);assert.doesNotMatch(view.text(),/说明文件来源|发布者自声明/);
 view.press('高级设置');await view.flush();assert.match(view.text(),/服务资料|小Q预配置/);assert.doesNotMatch(view.text(),/所有者未声明|发布者自声明|所有者是发布者/);
});


test('a direct financial update target loads the current owned connection and requires explicit acceptance',async()=>{
 const view=harness({...connection,financial_provider_id:'ifind',pending_update:true,status:'ready'}, {initialConnectionId:id});await view.flush();assert.ok(view.nodes().some(n=>n.props?.label==='确认此更新'));assert.equal(view.nodes().find(n=>n.props?.label==='在聊天中使用').props.disabled,true);assert.equal(view.calls.some(c=>c.method==='POST'),false);view.press('确认此更新');await view.flush();assert.equal(view.calls.filter(c=>c.path.endsWith('/accept-update')).length,1);assert.equal(view.calls.find(c=>c.path.endsWith('/accept-update')).body.revision,1);assert.equal(view.selectedChats.length,0);
});
test('a direct FRED update target exposes no ordinary chat, tool or history path',async()=>{
 const view=harness({...connection,research_provider_id:'fred',pending_update:true}, {initialConnectionId:id});await view.flush();assert.ok(view.nodes().some(n=>n.props?.label==='确认此更新'));assert.equal(view.nodes().some(n=>['在聊天中使用','高级设置','授权插件'].includes(n.props?.label)),false);assert.equal(view.calls.some(c=>/tools|invocations/.test(c.path)),false);view.press('确认此更新');await view.flush();assert.deepEqual(view.financialOpened,['fred']);assert.equal(view.selectedChats.length,0);assert.equal(view.calls.some(c=>/tools|invocations/.test(c.path)),false);
});
test('missing direct connection targets show the owned list rather than another account detail',async()=>{
 const view=harness(connection,{initialConnectionId:invocationId});await view.flush();assert.equal(view.nodes().find(n=>n.type==='Page').props.title,'我的插件');assert.equal(view.nodes().some(n=>n.props?.label==='确认此更新'),false);assert.equal(view.calls.some(c=>/tools|invocations/.test(c.path)),false);
});


test('host update navigation targets the selected owned connection and ignores late callbacks from another account',()=>{
 const slots=[];let cursor=0,token='owner-a',active=true;
 const react={useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},useRef(initial){return slots[cursor++]??={current:initial};},useReducer(reducer,initial){const [value,set]=react.useState(initial);return[value,action=>set(value=>reducer(value,action))];}};
 react.useLayoutEffect=callback=>callback();
 const jsx=(type,props,key)=>({type,props,key});const imports={react,'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{View:'View',ActivityIndicator:'Spinner'},'expo-crypto':{randomUUID:()=>id},'lucide-react-native':{},'../design':{...Object.fromEntries(['View','Action','Row','Tabs','Page','Type'].map(x=>[x,x])),useDesign:()=>({text:zh=>zh,colors:{}})},'../api-workbench/core':workbench,'./core':core,'../plugin-workbench/materials':materials,'../financial-plugins/page':{FinancialPluginCatalog:'FinancialPluginCatalog'},'../ai-chat/auth-sheet':{ChatAuthSheet:'ChatAuthSheet'},'../services/plugins':{},'./client':{},'./result-view':{},'../banking/proposal':{},'../banking/plugin-catalog':{}};
 const module={exports:{}};runInNewContext(source,{module,exports:module.exports,process:{env:{EXPO_OS:'ios'}},URL,require:name=>{assert.ok(name in imports,name);return imports[name];}});
 const nodes=(node,out=[])=>{if(Array.isArray(node))node.forEach(n=>nodes(n,out));else if(node&&typeof node==='object'){out.push(node);nodes(node.props?.children,out);}return out;};
 const render=()=>{cursor=0;return nodes(module.exports.PluginHostPage({chat:{authOpen:false,session:{token}},active,onSelect:noop,onOpenWorkbench:noop,recommendationTarget:{provider_id:'ifind'}}));};
 const initial=render().find(n=>n.type==='FinancialPluginCatalog'),oldCallback=initial.props.onReviewConnection;oldCallback(id);
 let list=render(),connected=list.find(n=>typeof n.type==='function'&&n.type.name==='ConnectedPlugins');assert.equal(connected.props.initialConnectionId,id);assert.equal(connected.key,`owner-a:${id}`);
 connected.props.onOpenFinancial('fred');assert.equal(render().find(n=>n.type==='FinancialPluginCatalog').props.initialProviderId,'fred');
 token='owner-b';list=render();assert.equal(list.find(n=>n.type==='FinancialPluginCatalog').props.initialProviderId,'ifind');oldCallback(id);assert.ok(render().some(n=>n.type==='FinancialPluginCatalog'));
 render().find(n=>n.type==='FinancialPluginCatalog').props.onReviewConnection(invocationId);connected=render().find(n=>typeof n.type==='function'&&n.type.name==='ConnectedPlugins');assert.equal(connected.props.initialConnectionId,invocationId);assert.equal(connected.key,`owner-b:${invocationId}`);
 active=false;render();connected.props.onOpenFinancial('fred');assert.ok(render().some(n=>typeof n.type==='function'&&n.type.name==='ConnectedPlugins'));
});
