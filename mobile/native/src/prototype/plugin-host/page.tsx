import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { ArrowLeft, Plus, RefreshCw } from 'lucide-react-native';
import { Action, Choice, Input, Page, Row, Sheet, Tabs, Type, useDesign } from '../design';
import { decodeList, WorkbenchError } from '../api-workbench/core';
import { ChatAuthSheet } from '../ai-chat/auth-sheet';
import type { ChatController } from '../ai-chat/use-chat';
import { PluginsPage } from '../services/plugins';
import { pluginRequest } from './client';
import { decodeDiscovery, decodeInvocation, decodePluginConnection, decodePluginStatus, decodeResources, decodeTool, parseArguments, pluginError, publicHttps, record, type Discovery, type PluginConnection, type PluginInvocation, type PluginTool, type ResourceLink } from './core';
import { PluginResultView, ResourceViewer } from './result-view';

export function invocationLabel(status: string, text: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = { awaiting_confirmation: ['等待确认', 'Awaiting confirmation'], running: ['执行中', 'Running'], succeeded: ['已完成', 'Completed'], tool_error: ['工具返回错误', 'Tool error'], unknown: ['结果未知，请勿重复执行', 'Outcome unknown; do not repeat'], cancelled: ['已取消', 'Cancelled'], expired: ['确认已过期', 'Confirmation expired'], failed: ['执行失败', 'Failed'], input_required: ['需要额外输入，当前不支持', 'Further input required; unsupported'] };
  return labels[status] ? text(...labels[status]) : status;
}

export function InvocationView({ invocation, token, onChanged, onContinue, autoShowResult = false }: { invocation: PluginInvocation; token: string; onChanged: (value: PluginInvocation) => void; onContinue?: () => void; autoShowResult?: boolean }) {
  const { text, colors } = useDesign();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showResult, setShowResult] = useState(autoShowResult);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const act = async (action: '' | '/confirm' | '/cancel') => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
    try {
      const value = await pluginRequest(token, `/v1/plugins/invocations/${invocation.id}${action}`, decodeInvocation, { method: action ? 'POST' : 'GET', ...(action === '/confirm' ? { body: { confirmed: true } } : {}), signal: controller.signal });
      if (!controller.signal.aborted) { onChanged(value); if (value.result != null) setShowResult(true); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  };
  return <View style={{ gap: 12, paddingVertical: 14 }}>
    <Type weight="500">{invocation.connection_title}</Type>
    <Type selectable size={12} muted>{invocation.card_url}</Type>
    <Type selectable size={12} muted>{text('接收地址：', 'Recipient endpoint: ')}{invocation.endpoint_url}</Type>
    <Type weight="500">{invocation.tool_name}</Type>
    <Type size={12} muted>{invocationLabel(invocation.status, text)}</Type>
    {invocation.status === 'awaiting_confirmation' && <>
      <Type selectable size={13}>{JSON.stringify(invocation.arguments, null, 2)}</Type>
      <Type size={12} muted>{text('确认后将把这些参数发送给此插件。', 'Confirm to send these arguments to this plugin.')}</Type>
    </>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {invocation.status === 'awaiting_confirmation' && <><Action label={text('确认执行一次', 'Confirm once')} disabled={busy} onPress={() => { void act('/confirm'); }} /><Action kind="ghost" label={text('取消', 'Cancel')} disabled={busy} onPress={() => { void act('/cancel'); }} /></>}
      <Action kind="ghost" icon={RefreshCw} label={text('查询状态', 'Check status')} disabled={busy} onPress={() => { void act(''); }} />
      {onContinue && ['succeeded', 'tool_error'].includes(invocation.status) && <Action kind="secondary" label={text('让小Q继续回答', 'Continue with Q')} disabled={busy} onPress={onContinue} />}
      {invocation.result != null && <Action kind="ghost" label={showResult ? text('收起结果', 'Hide result') : text('查看结果', 'View result')} onPress={() => setShowResult(value => !value)} />}
      {invocation.result == null && ['succeeded', 'tool_error'].includes(invocation.status) && <Action kind="ghost" label={text('读取结果', 'Load result')} disabled={busy} onPress={() => { void act(''); }} />}
    </View>
    {busy && <ActivityIndicator color={colors.accent} />}
    {!!error && <Type selectable color={colors.danger} size={13}>{pluginError(error, text)}</Type>}
    {!!invocation.error_code && <Type color={colors.danger} size={13}>{pluginError(invocation.error_code, text)}</Type>}
    {showResult && invocation.result !== null && invocation.result !== undefined && <PluginResultView value={invocation.result} token={token} connectionId={invocation.connection_id} />}
  </View>;
}

function ToolForm({ tool, busy, onPrepare }: { tool: PluginTool; busy: boolean; onPrepare: (argumentsValue: Record<string, unknown>, key: string) => void }) {
  const { text, colors } = useDesign();
  const [values, setValues] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState('{}');
  const [error, setError] = useState<unknown>(null);
  const proposalKey = useRef<string | null>(null);
  const properties = record(tool.inputSchema.properties) ? Object.entries(tool.inputSchema.properties).slice(0, 30) : [];
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const prepare = () => {
    try {
      const args: Record<string, unknown> = advanced ? parseArguments(raw) : {};
      if (!advanced) for (const [name, schema] of properties) {
        if (!record(schema)) continue;
        const value = values[name] ?? '';
        if (!value.trim()) { if (required.includes(name)) throw new WorkbenchError('PLUGIN_ARGUMENTS_INVALID'); continue; }
        args[name] = ['integer', 'number', 'boolean', 'object', 'array'].includes(String(schema.type)) ? JSON.parse(value) : value;
      }
      proposalKey.current ??= randomUUID();
      setError(null); onPrepare(args, proposalKey.current);
    } catch { setError('PLUGIN_ARGUMENTS_INVALID'); }
  };
  return <View style={{ gap: 14 }}>
    <Type>{tool.description}</Type>
    {advanced ? <Input label={text('参数 JSON', 'Arguments JSON')} value={raw} onChangeText={value => { proposalKey.current = null; setRaw(value); }} multiline autoCapitalize="none" editable={!busy} />
      : properties.map(([name, schema]) => record(schema) ? <Input key={name} label={`${typeof schema.title === 'string' ? schema.title : name}${required.includes(name) ? ' *' : ''}`} placeholder={typeof schema.description === 'string' ? schema.description : schema.default === undefined ? text('可选', 'Optional') : String(schema.default)} value={values[name] ?? ''} onChangeText={value => { proposalKey.current = null; setValues(current => ({ ...current, [name]: value })); }} autoCapitalize="none" editable={!busy} /> : null)}
    <Action kind="ghost" label={advanced ? text('普通参数', 'Simple fields') : text('查看 / 编辑 JSON 参数', 'View / edit JSON arguments')} disabled={busy} onPress={() => { proposalKey.current = null; setAdvanced(!advanced); }} />
    {!!error && <Type color={colors.danger}>{pluginError(error, text)}</Type>}
    <Action label={text('预览调用', 'Preview invocation')} disabled={busy} onPress={prepare} />
  </View>;
}

function ConnectedPlugins({ token, onSelect, onOpenWorkbench }: { token: string; onSelect: (connection: PluginConnection) => void; onOpenWorkbench: () => void }) {
  const { text, colors } = useDesign();
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [selected, setSelected] = useState<PluginConnection | null>(null);
  const [tools, setTools] = useState<PluginTool[]>([]);
  const [tool, setTool] = useState<PluginTool | null>(null);
  const [invocations, setInvocations] = useState<PluginInvocation[]>([]);
  const [resources, setResources] = useState<ResourceLink[]>([]);
  const [prompts, setPrompts] = useState<unknown[]>([]);
  const [promptResult, setPromptResult] = useState<unknown>(null);
  const [entry, setEntry] = useState('');
  const [kind, setKind] = useState('card');
  const [adding, setAdding] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ReturnType<typeof decodePluginStatus> | null>(null);
  const [oauth, setOauth] = useState<{ id: string; url: string } | null>(null);
  const requests = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const lock = useRef(false);
  async function call<T>(path: string, decode: (value: unknown) => T, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) {
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const result = await pluginRequest(token, path, decode, { method, body, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) throw new WorkbenchError('CANCELLED');
      return result;
    } finally { requests.current.delete(controller); }
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await action(); } catch (failure) { if (mounted.current) setError(failure); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const load = async () => {
    const [available, items] = await Promise.all([call('/v1/plugins/status', decodePluginStatus), call('/v1/plugins/connections', decodeList(decodePluginConnection))]);
    setStatus(available); setConnections(items);
  };
  useEffect(() => {
    mounted.current = true;
    const pending = requests.current;
    // Initial synchronization with the signed-in owner's server data.
    void run(load);
    return () => { mounted.current = false; for (const request of pending) request.abort(); };
    // This component is keyed by the Q token, so a new identity gets fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const path = (suffix = '') => `/v1/plugins/connections/${selected?.id}${suffix}`;
  const open = async (connection: PluginConnection) => {
    setSelected(connection); setTools([]); setInvocations([]); setResources([]); setPrompts([]); setPromptResult(null); setOauth(null);
    const history = await call(`/v1/plugins/invocations?connection_id=${connection.id}`, decodeList(decodeInvocation)); setInvocations(history);
    if (connection.status === 'ready') setTools(await call(`/v1/plugins/connections/${connection.id}/tools`, decodeList(decodeTool)));
  };
  const updateConnection = (connection: PluginConnection) => { setSelected(connection); setConnections(items => items.map(item => item.id === connection.id ? connection : item)); };
  const updateInvocation = (item: PluginInvocation) => setInvocations(items => items.some(value => value.id === item.id) ? items.map(value => value.id === item.id ? item : value) : [item, ...items]);
  const authorize = async () => {
    const value = await call(path('/oauth/start'), value => {
      if (!record(value) || typeof value.attempt_id !== 'string' || !publicHttps(value.authorization_url)) throw new WorkbenchError('INVALID_RESPONSE');
      return { id: value.attempt_id, url: publicHttps(value.authorization_url)! };
    }, 'POST'); setOauth(value);
  };
  return <Page title={selected ? selected.title || selected.name : text('我的插件', 'My plugins')} description={selected?.description}
    action={selected ? <Action kind="ghost" icon={ArrowLeft} label={text('返回', 'Back')} disabled={busy} onPress={() => { setSelected(null); setTool(null); setError(null); }} /> : <Action icon={Plus} label={text('添加插件', 'Add plugin')} disabled={busy} onPress={() => { setAdding(true); setDiscovery(null); }} />}>
    {busy && <ActivityIndicator accessibilityLabel={text('正在加载', 'Loading')} color={colors.accent} />}
    {!!error && <Type selectable color={colors.danger}>{pluginError(error, text)}</Type>}
    {!selected ? <>
      {connections.map(connection => <Row key={connection.id} title={connection.title || connection.name} subtitle={connection.endpoint_url} onPress={busy ? undefined : () => { void run(() => open(connection)); }} />)}
      {!connections.length && !busy && <Type muted>{text('添加服务方提供的插件链接，查看工具后即可使用。', 'Add a plugin link from its publisher to inspect and use its tools.')}</Type>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action kind="ghost" icon={RefreshCw} label={text('刷新连接', 'Refresh connections')} disabled={busy} onPress={() => { void run(load); }} /><Action kind="ghost" label={text('制作接入材料', 'Create integration materials')} onPress={onOpenWorkbench} /></View>
      {status && !status.available && <Type muted>{text('服务端尚未启用插件连接。', 'Plugin connections are not enabled on the server.')}</Type>}
    </> : <>
      <Type selectable size={12} muted>{selected.card_url}</Type><Type selectable size={12} muted>{selected.endpoint_url}</Type>
      <Type size={12} muted>{text('连接状态：', 'Connection: ')}{selected.status} · {text('授权：', 'Authorization: ')}{selected.auth_status}</Type>
      {selected.last_error_code && <Type color={colors.danger}>{pluginError(selected.last_error_code, text)}</Type>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action label={text('在聊天中使用', 'Use in chat')} disabled={busy || selected.status !== 'ready'} onPress={() => onSelect(selected)} />
        <Action kind="secondary" label={text('检查更新', 'Check updates')} disabled={busy} onPress={() => { void run(async () => { const value = await call(path('/refresh'), decodePluginConnection, 'POST'); updateConnection(value); await open(value); }); }} />
        <Action kind="ghost" label={text('授权插件', 'Authorize plugin')} disabled={busy || !status?.oauth_configured} onPress={() => { void run(authorize); }} />
      </View>
      {oauth && <View style={{ gap: 10 }}><Type selectable size={12}>{new URL(oauth.url).origin}</Type><Action label={text('在浏览器中授权', 'Authorize in browser')} onPress={() => { void Linking.openURL(oauth.url).catch(failure => setError(failure)); }} /><Action kind="ghost" label={text('我已授权，检查结果', 'Check authorization result')} disabled={busy} onPress={() => { void run(async () => { const result = await call(`/v1/plugins/oauth/attempts/${oauth.id}`, value => { if (!record(value) || typeof value.status !== 'string') throw new WorkbenchError('INVALID_RESPONSE'); return value; }); if (result.status !== 'succeeded') throw new WorkbenchError(typeof result.error_code === 'string' ? result.error_code : 'PLUGIN_AUTH_PENDING'); const connection = await call(path(), decodePluginConnection); updateConnection(connection); await open(connection); }); }} /></View>}
      {selected.pending_update && <View style={{ gap: 10 }}><Type weight="500">{text('请检查新的连接和工具定义', 'Review the updated connection and tools')}</Type><Type selectable size={12}>{JSON.stringify(selected.pending_update_details, null, 2)}</Type><Action label={text('确认此更新', 'Accept this update')} disabled={busy} onPress={() => { void run(async () => { const value = await call(path('/accept-update'), decodePluginConnection, 'POST', { revision: selected.revision }); updateConnection(value); await open(value); }); }} /></View>}
      <Type size={17} weight="500">{text('可用工具', 'Available tools')}</Type>
      {tools.map(item => <Row key={item.name} title={item.title || item.name} subtitle={item.description} onPress={busy ? undefined : () => setTool(item)} />)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action kind="ghost" label={text('重新读取工具', 'Reload tools')} disabled={busy} onPress={() => { void run(async () => { setTools(await call(path('/tools'), decodeList(decodeTool))); }); }} />
        <Action kind="ghost" label={text('浏览图片资源', 'Browse image resources')} disabled={busy} onPress={() => { void run(async () => { setResources((await call(path('/resources'), decodeResources)).filter(item => item.mimeType?.startsWith('image/'))); }); }} />
        <Action kind="ghost" label={text('查看提示模板', 'View prompts')} disabled={busy} onPress={() => { void run(async () => { setPrompts(await call(path('/prompts'), value => { if (!record(value) || !Array.isArray(value.prompts)) throw new WorkbenchError('INVALID_RESPONSE'); return value.prompts; })); }); }} />
      </View>
      {resources.length > 0 && <ResourceViewer key={selected.id} token={token} connectionId={selected.id} resources={resources} />}
      {prompts.map((item, index) => record(item) && typeof item.name === 'string' ? <Row key={index} title={typeof item.title === 'string' ? item.title : item.name} subtitle={typeof item.description === 'string' ? item.description : undefined} onPress={busy ? undefined : () => { void run(async () => { setPromptResult(await call(path('/prompts/get'), value => value, 'POST', { name: item.name, arguments: {} })); }); }} /> : null)}
      {promptResult !== null && <Type selectable size={13}>{JSON.stringify(promptResult, null, 2)}</Type>}
      <Type size={17} weight="500">{text('最近调用', 'Recent invocations')}</Type>
      <Type size={12} muted>{text('结果未知的调用不会自动重试。刷新页面后仍可查询。', 'Unknown invocations are never retried automatically. Their status survives a page refresh.')}</Type>
      {invocations.map(item => <InvocationView key={item.id} invocation={item} token={token} onChanged={updateInvocation} />)}
      <Action kind="ghost" label={text('断开此插件', 'Disconnect this plugin')} disabled={busy} onPress={() => { void run(async () => { await call(path(), () => undefined, 'DELETE'); setSelected(null); await load(); }); }} />
    </>}
    <Sheet visible={adding} title={text('添加插件', 'Add plugin')} onClose={() => { if (!busy) setAdding(false); }}>
      <Input label={text('插件地址', 'Plugin URL')} placeholder="https://example.com/server-card.json" value={entry} onChangeText={setEntry} autoCapitalize="none" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{[['card', 'Card'], ['catalog', 'Catalog'], ['page', text('网页', 'Web page')], ['domain', text('域名', 'Domain')]].map(([id, label]) => <Choice key={id} label={label} selected={kind === id} disabled={busy} onPress={() => setKind(id)} />)}</View>
      <Action label={text('查找服务', 'Find services')} disabled={busy || !entry.trim()} onPress={() => { void run(async () => { setDiscovery(await call('/v1/plugins/discover', decodeDiscovery, 'POST', { entry: entry.trim(), kind })); }); }} />
      {discovery?.candidates.map(candidate => <View key={candidate.candidate_id} style={{ gap: 10 }}><Type weight="500">{candidate.title || candidate.name}</Type><Type>{candidate.description}</Type><Type selectable size={12} muted>{candidate.card_url}{'\n'}{candidate.endpoint_url}</Type><Action label={text('添加这个服务', 'Add this service')} disabled={busy} onPress={() => { void run(async () => { const value = await call('/v1/plugins/connections', decodePluginConnection, 'POST', { discovery_id: discovery.discovery_id, candidate_id: candidate.candidate_id }); setAdding(false); await load(); await open(value); }); }} /></View>)}
      {!!error && <Type color={colors.danger}>{pluginError(error, text)}</Type>}
    </Sheet>
    <Sheet visible={!!tool} title={tool?.title || tool?.name || ''} onClose={() => { if (!busy) setTool(null); }}>
      {tool && selected && <ToolForm key={tool.name} tool={tool} busy={busy} onPrepare={(argumentsValue, key) => { void run(async () => { const invocation = await call('/v1/plugins/invocations', decodeInvocation, 'POST', { connection_id: selected.id, tool_name: tool.name, arguments: argumentsValue, idempotency_key: key }); updateInvocation(invocation); setTool(null); }); }} />}
      {!!error && <Type color={colors.danger}>{pluginError(error, text)}</Type>}
    </Sheet>
  </Page>;
}

export function PluginHostPage({ chat, onOpenWorkbench, onSelect }: { chat: ChatController; onOpenWorkbench: () => void; onSelect: (connection: PluginConnection) => void }) {
  const { text } = useDesign();
  const [tab, setTab] = useState('connected');
  return <View style={{ flex: 1 }}><View style={{ paddingHorizontal: 24, paddingBottom: 12 }}><Tabs items={[{ id: 'connected', label: text('我的连接', 'My connections') }, { id: 'catalog', label: text('目录参考', 'Catalog reference') }]} value={tab} onChange={setTab} /></View>
    {tab === 'catalog' ? <PluginsPage onOpenWorkbench={onOpenWorkbench} /> : chat.session ? <ConnectedPlugins key={chat.session.token} token={chat.session.token} onSelect={onSelect} onOpenWorkbench={onOpenWorkbench} />
      : <Page title={text('我的插件', 'My plugins')}><Type muted>{text('登录 Q 后添加插件，连接与授权保存在你的账户下。', 'Sign in to Q to save plugin connections and authorizations to your account.')}</Type><Action label={text('登录 / 注册', 'Sign in / register')} onPress={chat.openAuth} disabled={chat.authBusy} /></Page>}
    {chat.authOpen && <ChatAuthSheet controller={chat} />}
  </View>;
}
