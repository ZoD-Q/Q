import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { ArrowLeft, Plus, RefreshCw } from 'lucide-react-native';
import { Action, Choice, Input, Page, Row, Sheet, Tabs, Type, useDesign } from '../design';
import { decodeList, WorkbenchError } from '../api-workbench/core';
import { ChatAuthSheet } from '../ai-chat/auth-sheet';
import type { ChatController } from '../ai-chat/use-chat';
import { PluginsPage } from '../services/plugins';
import { pluginRequest } from './client';
import { bankIdForPlugin, bankTransferArguments, decodeDiscovery, decodeInvocation, decodePluginConnection, decodePluginStatus, decodeResources, decodeTool, parseArguments, pluginError, pluginOrigin, connectionStatusLabel, authorizationLabel, initialPluginEntryState, pluginAuthModalReducer, canPresentPluginConnectionPage, publicHttps, record, type Discovery, type PluginConnection, type PluginInvocation, type PluginTool, type ResourceLink, type PluginEntryIntentOutcome } from './core';
import { PluginResultView, ResourceViewer } from './result-view';
import { normalizeOwnerName, type EntryKind, type PluginEntryIntent } from '../plugin-workbench/materials';
import { BankProposalView } from '../banking/proposal';
import { BankPluginCatalog } from '../banking/plugin-catalog';

type LinkIntent = { initialIntent?: PluginEntryIntent | null; onIntentHandled?: (intent: PluginEntryIntent, outcome: PluginEntryIntentOutcome) => void };
const ownerLabel = (name: string | null | undefined, text: (zh: string, en: string) => string) => name
  ? text(`所有者：${name}（发布者自声明）`, `Owner: ${name} (publisher-declared)`)
  : text('所有者未声明', 'Owner not declared');

const providerLabel = (name: string, text: (zh: string, en: string) => string) => text(`提供方：${name}`, `Provider: ${name}`);

function SourceSummary({ cardUrl, endpointUrl, bank = false }: { cardUrl: string; endpointUrl: string; bank?: boolean }) {
  const { text } = useDesign();
  if (bank) return <Type size={12} muted>{text('模拟账户', 'Demo account')}</Type>;
  const cardOrigin = pluginOrigin(cardUrl), endpointOrigin = pluginOrigin(endpointUrl);
  return <View style={{ gap: 4 }}>
    <Type selectable size={12} muted>{text('服务来源：', 'Service source: ')}{endpointOrigin ?? text('暂不可识别', 'Unavailable')}</Type>
    {cardOrigin !== endpointOrigin && <Type selectable size={12} muted>{text('说明文件来源：', 'Card source: ')}{cardOrigin ?? text('暂不可识别', 'Unavailable')}</Type>}
  </View>;
}

function TechnicalDetails({ cardUrl, endpointUrl, children }: { cardUrl?: string; endpointUrl?: string; children?: ReactNode }) {
  const { text } = useDesign();
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 8 }}>
    <Action kind="ghost" label={open ? text('收起技术详情', 'Hide technical details') : text('技术详情', 'Technical details')} onPress={() => setOpen(value => !value)} style={{ alignSelf: 'flex-start' }} />
    {open && <View style={{ gap: 8 }}>
      {cardUrl && <Type selectable size={12} muted>{text('说明文件：', 'Server Card: ')}{cardUrl}</Type>}
      {endpointUrl && <Type selectable size={12} muted>{text('MCP 接收地址：', 'MCP endpoint: ')}{endpointUrl}</Type>}
      {children}
    </View>}
  </View>;
}

export function invocationLabel(status: string, text: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = { awaiting_confirmation: ['等待确认', 'Awaiting confirmation'], running: ['执行中', 'Running'], succeeded: ['已完成', 'Completed'], tool_error: ['工具返回错误', 'Tool error'], unknown: ['结果未知，请勿重复执行', 'Outcome unknown; do not repeat'], cancelled: ['已取消', 'Cancelled'], expired: ['确认已过期', 'Confirmation expired'], failed: ['执行失败', 'Failed'], input_required: ['需要额外输入，当前不支持', 'Further input required; unsupported'] };
  return labels[status] ? text(...labels[status]) : status;
}

export function InvocationView({ invocation, token, onChanged, onContinue, autoShowResult = false }: { invocation: PluginInvocation; token: string; onChanged: (value: PluginInvocation) => void; onContinue?: () => void; autoShowResult?: boolean }) {
  const { text, colors } = useDesign();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showResult, setShowResult] = useState(autoShowResult);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const request = useRef<AbortController | null>(null);
  const bank = bankIdForPlugin(invocation);
  const bankTransfer = !!bank && invocation.tool_name === 'bank_transfer';
  useEffect(() => () => request.current?.abort(), []);
  const act = async (action: '' | '/confirm' | '/cancel') => {
    if (request.current) return;
    if (action === '/confirm' && (needsRefresh || invocation.status !== 'awaiting_confirmation' || (bankTransfer && !bankTransferArguments(invocation)))) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
    try {
      const value = await pluginRequest(token, `/v1/plugins/invocations/${invocation.id}${action}`, decodeInvocation, { method: action ? 'POST' : 'GET', ...(action === '/confirm' ? { body: { confirmed: true } } : {}), signal: controller.signal });
      if (value.id !== invocation.id || value.connection_id !== invocation.connection_id) throw new WorkbenchError('INVALID_RESPONSE');
      if (!controller.signal.aborted) { onChanged(value); setNeedsRefresh(false); if (value.result != null) setShowResult(true); }
    } catch (failure) { if (!controller.signal.aborted) { setError(failure); if (action === '/confirm') setNeedsRefresh(true); } }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  };
  return <View style={{ gap: 12, paddingVertical: 14 }}>
    <Type weight="500">{invocation.connection_title}</Type>
    {!bank && <Type size={12} muted>{ownerLabel(invocation.owner_name, text)}</Type>}
    <SourceSummary cardUrl={invocation.card_url} endpointUrl={invocation.endpoint_url} bank={!!bank} />
    {!bankTransfer && <><Type weight="500">{invocation.tool_name}</Type><Type size={12} muted>{invocationLabel(invocation.status, text)}</Type></>}
    {bankTransfer && <BankProposalView invocation={invocation} busy={busy} needsRefresh={needsRefresh} onConfirm={() => { void act('/confirm'); }} onCancel={() => { void act('/cancel'); }} onRefresh={() => { void act(''); }} />}
    {!bankTransfer && invocation.status === 'awaiting_confirmation' && <>
      <Type selectable size={12} muted>{text('实际接收地址：', 'Actual recipient endpoint: ')}{invocation.endpoint_url}</Type>
      <Type selectable size={13}>{JSON.stringify(invocation.arguments, null, 2)}</Type>
      <Type size={12} muted>{text('确认后将把这些参数发送给此插件。', 'Confirm to send these arguments to this plugin.')}</Type>
    </>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {!bankTransfer && invocation.status === 'awaiting_confirmation' && <><Action label={text('确认执行一次', 'Confirm once')} disabled={busy || needsRefresh} onPress={() => { void act('/confirm'); }} /><Action kind="ghost" label={text('取消', 'Cancel')} disabled={busy} onPress={() => { void act('/cancel'); }} /></>}
      {!bankTransfer && <Action kind="ghost" icon={RefreshCw} label={text('查询状态', 'Check status')} disabled={busy} onPress={() => { void act(''); }} />}
      {onContinue && ['succeeded', 'tool_error'].includes(invocation.status) && <Action kind="secondary" label={text('让小Q继续回答', 'Continue with Q')} disabled={busy} onPress={onContinue} />}
      {!bankTransfer && invocation.result != null && <Action kind="ghost" label={showResult ? text('收起结果', 'Hide result') : text('查看结果', 'View result')} onPress={() => setShowResult(value => !value)} />}
      {invocation.result == null && ['succeeded', 'tool_error'].includes(invocation.status) && <Action kind="ghost" label={text('读取结果', 'Load result')} disabled={busy} onPress={() => { void act(''); }} />}
    </View>
    {busy && <ActivityIndicator color={colors.accent} />}
    {!!error && <Type selectable color={colors.danger} size={13}>{pluginError(error, text)}</Type>}
    {!!invocation.error_code && <Type color={colors.danger} size={13}>{pluginError(invocation.error_code, text)}</Type>}
    {!bank && <TechnicalDetails cardUrl={invocation.card_url} endpointUrl={invocation.endpoint_url} />}
    {!bankTransfer && showResult && invocation.result !== null && invocation.result !== undefined && <PluginResultView value={invocation.result} token={token} connectionId={invocation.connection_id} />}
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

function ConnectedPlugins({ token, onSelect, onOpenWorkbench, initialIntent, onIntentHandled }: { token: string; onSelect: (connection: PluginConnection) => void; onOpenWorkbench: () => void } & LinkIntent) {
  const { text, colors } = useDesign();
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [selected, setSelected] = useState<PluginConnection | null>(null);
  const [tools, setTools] = useState<PluginTool[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [tool, setTool] = useState<PluginTool | null>(null);
  const [activeInvocation, setActiveInvocation] = useState<PluginInvocation | null>(null);
  const [invocations, setInvocations] = useState<PluginInvocation[]>([]);
  const [resources, setResources] = useState<ResourceLink[]>([]);
  const [prompts, setPrompts] = useState<unknown[]>([]);
  const [promptResult, setPromptResult] = useState<unknown>(null);
  const [entry, setEntry] = useState(() => initialPluginEntryState(initialIntent).entry);
  const [kind, setKind] = useState<EntryKind>(() => initialPluginEntryState(initialIntent).kind);
  const [advancedEntry, setAdvancedEntry] = useState(() => initialPluginEntryState(initialIntent).advanced);
  const [adding, setAdding] = useState(() => initialPluginEntryState(initialIntent).adding);
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
    setAdvanced(false); setSelected(connection); setTools([]); setTool(null); setActiveInvocation(null); setInvocations([]); setResources([]); setPrompts([]); setPromptResult(null); setOauth(null);
  };
  const openAdvanced = async () => {
    if (!selected) return;
    setAdvanced(true);
    const history = await call(`/v1/plugins/invocations?connection_id=${selected.id}`, decodeList(decodeInvocation)); setInvocations(history);
    if (selected.status === 'ready') setTools(await call(`/v1/plugins/connections/${selected.id}/tools`, decodeList(decodeTool)));
  };
  const updateConnection = (connection: PluginConnection) => { setSelected(connection); setConnections(items => items.map(item => item.id === connection.id ? connection : item)); };
  const updateInvocation = (item: PluginInvocation) => {
    setInvocations(items => items.some(value => value.id === item.id) ? items.map(value => value.id === item.id ? item : value) : [item, ...items]);
    setActiveInvocation(current => current?.id === item.id ? item : current);
  };
  const closeToolSheet = () => {
    if (busy) return;
    setTool(null); setActiveInvocation(null); setError(null);
  };
  const authorize = async () => {
    const value = await call(path('/oauth/start'), value => {
      if (!record(value) || typeof value.attempt_id !== 'string' || !publicHttps(value.authorization_url)) throw new WorkbenchError('INVALID_RESPONSE');
      return { id: value.attempt_id, url: publicHttps(value.authorization_url)! };
    }, 'POST'); setOauth(value);
  };
  const pendingCandidate = record(selected?.pending_update_details) && record(selected.pending_update_details.candidate) ? selected.pending_update_details.candidate : null;
  return <Page title={selected ? selected.title || selected.name : text('我的插件', 'My plugins')}
    action={selected ? <Action kind="ghost" icon={ArrowLeft} label={text('返回', 'Back')} disabled={busy} onPress={() => { setSelected(null); closeToolSheet(); }} /> : <Action icon={Plus} label={text('添加插件', 'Add plugin')} disabled={busy} onPress={() => { setKind('auto'); setAdvancedEntry(false); setAdding(true); setDiscovery(null); setError(null); }} />}>
    {busy && <ActivityIndicator accessibilityLabel={text('正在加载', 'Loading')} color={colors.accent} />}
    {!!error && <Type selectable color={colors.danger}>{pluginError(error, text)}</Type>}
    {!selected ? <>
      {connections.map(connection => <Row key={connection.id} title={connection.title || connection.name} subtitle={bankIdForPlugin(connection) ? text('银行插件 · 模拟账户', 'Bank plugin · simulated account') : [connection.owner_name ? providerLabel(connection.owner_name, text) : null, pluginOrigin(connection.endpoint_url) ?? text('来源待确认', 'Source unavailable')].filter(Boolean).join('\n')} onPress={busy ? undefined : () => { void run(() => open(connection)); }} />)}
      {!connections.length && !busy && <View style={{ gap: 8 }}>
        <Type weight="500">{text('还没有添加插件', 'No plugins added yet')}</Type>
        <Type muted>{text('点「添加插件」，粘贴服务方的链接后确认添加。这里仅显示当前 Q 账号的个人连接。', 'Choose Add plugin and paste the publisher’s link. This list contains only the current Q account’s personal connections.')}</Type>
      </View>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action kind="ghost" icon={RefreshCw} label={text('刷新连接', 'Refresh connections')} disabled={busy} onPress={() => { void run(load); }} /><Action kind="ghost" label={text('制作接入材料', 'Create integration materials')} onPress={onOpenWorkbench} /></View>
      {status && !status.available && <Type muted>{text('服务端尚未启用远程 MCP 连接；已添加的内置银行插件仍可使用。', 'Remote MCP connections are not enabled; added built-in bank plugins remain available.')}</Type>}
    </> : <>
      {!bankIdForPlugin(selected) && selected.owner_name && <Type size={13} muted>{providerLabel(selected.owner_name, text)}</Type>}
      <SourceSummary cardUrl={selected.card_url} endpointUrl={selected.endpoint_url} bank={!!bankIdForPlugin(selected)} />
      {selected.status !== 'ready' && <Type size={13} muted>{connectionStatusLabel(selected.status, text)}</Type>}
      {selected.last_error_code && <Type color={colors.danger}>{pluginError(selected.last_error_code, text)}</Type>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action label={text('在聊天中使用', 'Use in chat')} disabled={busy || selected.status !== 'ready'} onPress={() => onSelect(selected)} />
        {!bankIdForPlugin(selected) && (selected.status === 'auth_required' || selected.auth_status === 'required') && <Action kind="secondary" label={text('授权插件', 'Authorize plugin')} disabled={busy || !status?.oauth_configured} onPress={() => { void run(authorize); }} />}
      </View>
      {oauth && <View style={{ gap: 10 }}><Type selectable size={12}>{new URL(oauth.url).origin}</Type><Action label={text('在浏览器中授权', 'Authorize in browser')} onPress={() => { void Linking.openURL(oauth.url).catch(failure => setError(failure)); }} /><Action kind="ghost" label={text('我已授权，检查结果', 'Check authorization result')} disabled={busy} onPress={() => { void run(async () => { const result = await call(`/v1/plugins/oauth/attempts/${oauth.id}`, value => { if (!record(value) || typeof value.status !== 'string') throw new WorkbenchError('INVALID_RESPONSE'); return value; }); if (result.status !== 'succeeded') throw new WorkbenchError(typeof result.error_code === 'string' ? result.error_code : 'PLUGIN_AUTH_PENDING'); const connection = await call(path(), decodePluginConnection); updateConnection(connection); await open(connection); }); }} /></View>}
      {selected.pending_update && <View style={{ gap: 10 }}>
        <Type weight="500">{text('服务有更新', 'Service update available')}</Type>
        <Type size={13} muted>{text('请核对服务来源；完整变更可在高级设置中查看。', 'Review the service source. Full changes are available in Advanced settings.')}</Type>
        {pendingCandidate && <>
          <Type>{typeof pendingCandidate.title === 'string' ? pendingCandidate.title : selected.title}</Type>
          <Type size={12} muted>{ownerLabel(normalizeOwnerName(pendingCandidate.owner_name), text)}</Type>
          {typeof pendingCandidate.card_url === 'string' && typeof pendingCandidate.endpoint_url === 'string' && <SourceSummary cardUrl={pendingCandidate.card_url} endpointUrl={pendingCandidate.endpoint_url} />}
        </>}
        <Action label={text('确认此更新', 'Accept this update')} disabled={busy} onPress={() => { void run(async () => { const value = await call(path('/accept-update'), decodePluginConnection, 'POST', { revision: selected.revision }); updateConnection(value); await open(value); }); }} />
      </View>}
      <Action kind="ghost" label={advanced ? text('收起高级设置', 'Hide advanced settings') : text('高级设置', 'Advanced settings')} disabled={busy} style={{ alignSelf: 'flex-start', minHeight: 48 }} onPress={() => { if (advanced) { setAdvanced(false); closeToolSheet(); } else { void run(openAdvanced); } }} />
      {advanced && <View style={{ gap: 14 }}>
        {!!selected.description && <Type size={13}>{selected.description}</Type>}
        <Type size={12} muted>{ownerLabel(selected.owner_name, text)}</Type>
        <Type size={12} muted>{connectionStatusLabel(selected.status, text)} · {authorizationLabel(selected.auth_status, text)}</Type>
        <Type selectable size={12} muted>{selected.name} · {selected.version}</Type>
        <Type selectable size={12} muted>{text('说明文件：', 'Server Card: ')}{selected.card_url}</Type>
        <Type selectable size={12} muted>{text('MCP 接收地址：', 'MCP endpoint: ')}{selected.endpoint_url}</Type>
        <Type size={12} muted>{text('所有者是发布者自行填写的说明，不代表小Q认证，也不改变当前账号权限。', 'The owner is a publisher declaration, not Q verification, and does not change account permissions.')}</Type>
        {!bankIdForPlugin(selected) && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Action kind="secondary" label={text('检查更新', 'Check updates')} disabled={busy} onPress={() => { void run(async () => { const value = await call(path('/refresh'), decodePluginConnection, 'POST'); updateConnection(value); await open(value); }); }} />
          {selected.status !== 'auth_required' && selected.auth_status !== 'required' && <Action kind="ghost" label={text('授权插件', 'Authorize plugin')} disabled={busy || !status?.oauth_configured} onPress={() => { void run(authorize); }} />}
        </View>}
        {selected.pending_update && <View style={{ gap: 8 }}><Type weight="500">{text('完整更新内容', 'Full update details')}</Type><Type selectable size={12}>{JSON.stringify(selected.pending_update_details, null, 2)}</Type></View>}
        <Type size={17} weight="500">{text('可用工具', 'Available tools')}</Type>
        {tools.map(item => <Row key={item.name} title={item.title || item.name} subtitle={item.description} onPress={busy ? undefined : () => { if (bankIdForPlugin(selected) && item.name === 'bank_transfer') { onSelect(selected); return; } setActiveInvocation(null); setError(null); setTool(item); }} />)}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Action kind="ghost" label={text('重新读取工具', 'Reload tools')} disabled={busy} onPress={() => { void run(async () => { setTools(await call(path('/tools'), decodeList(decodeTool))); }); }} />
          {!bankIdForPlugin(selected) && <><Action kind="ghost" label={text('浏览图片资源', 'Browse image resources')} disabled={busy} onPress={() => { void run(async () => { setResources((await call(path('/resources'), decodeResources)).filter(item => item.mimeType?.startsWith('image/'))); }); }} />
          <Action kind="ghost" label={text('查看提示模板', 'View prompts')} disabled={busy} onPress={() => { void run(async () => { setPrompts(await call(path('/prompts'), value => { if (!record(value) || !Array.isArray(value.prompts)) throw new WorkbenchError('INVALID_RESPONSE'); return value.prompts; })); }); }} /></>}
        </View>
        {resources.length > 0 && <ResourceViewer key={selected.id} token={token} connectionId={selected.id} resources={resources} />}
        {prompts.map((item, index) => record(item) && typeof item.name === 'string' ? <Row key={index} title={typeof item.title === 'string' ? item.title : item.name} subtitle={typeof item.description === 'string' ? item.description : undefined} onPress={busy ? undefined : () => { void run(async () => { setPromptResult(await call(path('/prompts/get'), value => value, 'POST', { name: item.name, arguments: {} })); }); }} /> : null)}
        {promptResult !== null && <Type selectable size={13}>{JSON.stringify(promptResult, null, 2)}</Type>}
        <Type size={17} weight="500">{text('最近调用', 'Recent invocations')}</Type>
        <Type size={12} muted>{text('结果未知的调用不会自动重试。刷新页面后仍可查询。', 'Unknown invocations are never retried automatically. Their status survives a page refresh.')}</Type>
        {invocations.map(item => <InvocationView key={item.id} invocation={item} token={token} onChanged={updateInvocation} />)}
      </View>}
      <Action kind="ghost" label={text('断开此插件', 'Disconnect this plugin')} disabled={busy} onPress={() => { void run(async () => { await call(path(), () => undefined, 'DELETE'); setSelected(null); await load(); }); }} />
    </>}
    <Sheet visible={adding} title={text('添加插件', 'Add plugin')} onClose={() => { if (!busy) { setAdding(false); if (initialIntent) onIntentHandled?.(initialIntent, 'dismissed'); } }}>
      <Input label={text('插件链接', 'Plugin link')} placeholder="https://example.com/plugin" value={entry} onChangeText={value => { setEntry(value); setDiscovery(null); setError(null); }} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={4096} editable={!busy} hint={kind === 'auto' ? text('粘贴完整 HTTPS 链接或域名，小Q会自动识别。', 'Paste a complete HTTPS link or domain. Q identifies the entry automatically.') : text('使用你选择的入口类型，可在高级选项中修改。', 'Using your selected entry type. Change it in Advanced options.')} />
      <Action label={text('继续', 'Continue')} disabled={busy || !entry.trim()} onPress={() => { void run(async () => {
        const found = await call('/v1/plugins/discover', decodeDiscovery, 'POST', { entry: entry.trim(), kind });
        setDiscovery(found);
        if (found.candidates.length && initialIntent) onIntentHandled?.(initialIntent, 'discovered');
      }); }} />
      {busy && <ActivityIndicator accessibilityLabel={text('正在查找插件', 'Looking up the plugin')} color={colors.accent} />}
      <Action kind="ghost" label={advancedEntry ? text('收起高级选项', 'Hide advanced options') : text('高级选项', 'Advanced options')} disabled={busy} onPress={() => setAdvancedEntry(value => !value)} style={{ alignSelf: 'flex-start' }} />
      {advancedEntry && <View style={{ gap: 8 }}>
        <Type size={12} muted>{text('通常无需修改。指定类型后仍保留完整链接，不会丢弃路径。', 'Usually no change is needed. Choosing a type still preserves the complete link and path.')}</Type>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{([['auto', text('自动识别', 'Automatic')], ['card', 'Server Card'], ['catalog', 'Catalog'], ['page', text('介绍页', 'Intro page')], ['domain', text('域名', 'Domain')]] as [EntryKind, string][]).map(([id, label]) => <Choice key={id} label={label} selected={kind === id} disabled={busy} onPress={() => { setKind(id); setDiscovery(null); }} />)}</View>
      </View>}
      {discovery && !discovery.candidates.length && <Type muted>{text('没有找到可添加的插件，请确认链接，或请服务方提供插件说明文件链接。', 'No addable plugin was found. Check the link or ask the publisher for its Server Card link.')}</Type>}
      {discovery?.candidates.map(candidate => <View key={candidate.candidate_id} style={{ gap: 10 }}>
        <Type size={17} weight="500">{candidate.title || candidate.name}</Type>
        <Type>{candidate.description}</Type>
        <Type size={12} muted>{ownerLabel(candidate.owner_name, text)}</Type>
        <SourceSummary cardUrl={candidate.card_url} endpointUrl={candidate.endpoint_url} />
        <TechnicalDetails cardUrl={candidate.card_url} endpointUrl={candidate.endpoint_url} />
        <Type size={12} muted>{text('添加只保存个人连接，不会自动授权或执行工具。', 'Adding saves a personal connection; it does not authorize access or execute tools.')}</Type>
        <Action label={text('确认添加', 'Confirm addition')} disabled={busy} onPress={() => { void run(async () => { const value = await call('/v1/plugins/connections', decodePluginConnection, 'POST', { discovery_id: discovery.discovery_id, candidate_id: candidate.candidate_id }); setAdding(false); await load(); await open(value); }); }} />
      </View>)}
      {!!error && <Type color={colors.danger}>{pluginError(error, text)}</Type>}
    </Sheet>
    <Sheet visible={!!tool || !!activeInvocation} title={activeInvocation ? activeInvocation.status === 'awaiting_confirmation' ? text('确认调用', 'Confirm invocation') : text('调用详情', 'Invocation details') : tool?.title || tool?.name || ''} onClose={closeToolSheet}>
      {activeInvocation ? <InvocationView key={activeInvocation.id} invocation={activeInvocation} token={token} onChanged={updateInvocation} autoShowResult />
        : tool && selected && <ToolForm key={tool.name} tool={tool} busy={busy} onPrepare={(argumentsValue, key) => { void run(async () => { const invocation = await call('/v1/plugins/invocations', decodeInvocation, 'POST', { connection_id: selected.id, tool_name: tool.name, arguments: argumentsValue, idempotency_key: key }); updateInvocation(invocation); setActiveInvocation(invocation); setTool(null); }); }} />}
      {busy && <ActivityIndicator accessibilityLabel={text('正在准备调用', 'Preparing invocation')} color={colors.accent} />}
      {!!error && <Type color={colors.danger}>{pluginError(error, text)}</Type>}
    </Sheet>
  </Page>;
}

export function PluginHostPage({ chat, onOpenWorkbench, onOpenMarketData, onSelect, initialIntent, onIntentHandled }: { chat: ChatController; onOpenWorkbench: () => void; onOpenMarketData?: () => void; onSelect: (connection: PluginConnection) => void } & LinkIntent) {
  const { text, colors } = useDesign();
  const [tab, setTab] = useState('connected');
  const [authModalPending, authModalEvent] = useReducer(pluginAuthModalReducer, chat.authOpen);
  const connectionPageReady = canPresentPluginConnectionPage({ platform: process.env.EXPO_OS, authenticated: !!chat.session, authOpen: chat.authOpen, authModalPending });
  const openAuth = () => { authModalEvent('requested'); chat.openAuth(); };
  return <View style={{ flex: 1 }}><View style={{ paddingHorizontal: 24, paddingBottom: 12 }}>
    {onOpenMarketData ? <Row title={text('金融数据工具', 'Financial data tools')} subtitle={text('查询公开币种数据、美国公司公告与财经新闻，核对来源与时间。', 'Explore public crypto data, US filings and financial news with sources and timestamps.')} onPress={onOpenMarketData} /> : null}
    <Tabs items={[{ id: 'connected', label: text('我的连接', 'My connections') }, { id: 'banks', label: text('银行插件', 'Bank plugins') }, { id: 'catalog', label: text('目录参考', 'Catalog reference') }]} value={tab} onChange={setTab} /></View>
    {tab === 'catalog' ? <PluginsPage onOpenWorkbench={onOpenWorkbench} /> : chat.session && connectionPageReady ? tab === 'banks' ? <BankPluginCatalog key={chat.session.token} token={chat.session.token} onSelect={onSelect} /> : <ConnectedPlugins key={chat.session.token} token={chat.session.token} onSelect={onSelect} onOpenWorkbench={onOpenWorkbench} initialIntent={initialIntent} onIntentHandled={onIntentHandled} />
      : chat.session ? <Page title={text('我的插件', 'My plugins')}><ActivityIndicator color={colors.accent} accessibilityLabel={text('正在完成登录', 'Finishing sign-in')} /></Page>
        : <Page title={text('我的插件', 'My plugins')}><Type muted>{initialIntent ? text('链接已保留。登录 Q 后继续查看插件信息，再确认添加。', 'Your link is kept. Sign in to Q to review the plugin and confirm addition.') : text('登录 Q 后添加插件，连接与授权保存在你的账户下。', 'Sign in to Q to save plugin connections and authorizations to your account.')}</Type><Action label={text('登录 / 注册', 'Sign in / register')} onPress={openAuth} disabled={chat.authBusy} /></Page>}
    <ChatAuthSheet controller={chat} onShow={() => authModalEvent('shown')} onDismiss={() => authModalEvent('dismissed')}
      description={text('登录后继续查看插件信息。添加、授权和执行仍需你确认。', 'After signing in, review the plugin. Adding, authorizing, and executing still require your confirmation.')} />
  </View>;
}
