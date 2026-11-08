import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, View } from 'react-native';
import { ArrowLeft, ChartNoAxesCombined, RefreshCw, Search, Landmark, Newspaper, Bitcoin, ChevronRight } from 'lucide-react-native';
import { Action, Input, Page, Row, Sheet, Type, useDesign } from '../design';
import { decodeList, WorkbenchError } from '../api-workbench/core';
import { pluginRequest } from '../plugin-host/client';
import { connectionStatusLabel, decodeTool, type PluginConnection } from '../plugin-host/core';
import { FredResearchPanel } from './fred-panel';
import { FINANCIAL_PROVIDERS, decodeAuthorizationAttempt, decodeFinancialAuthorization, decodeFinancialCatalog, decodeFinancialConnection, financialError, financialProviderId, type FinancialAuthorization, type FinancialCatalog, type FinancialProviderId } from './core';

export function FinancialPluginCatalog({ token, onSelect, active = true, initialProviderId }: { token: string; active?: boolean; onSelect: (connection: PluginConnection) => void; initialProviderId?: string | null }) {
  const { colors, text } = useDesign();
  const [catalog, setCatalog] = useState<{ owner: string; value: FinancialCatalog } | null>(null);
  const [selected, setSelected] = useState<FinancialProviderId | null>(financialProviderId(initialProviderId) ? initialProviderId : null);
  const [busy, setBusy] = useState(active);
  const [fredOpen, setFredOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [keyFor, setKeyFor] = useState<{ owner: string; provider: FinancialProviderId } | null>(null);
  const [secret, setSecret] = useState('');
  const [disconnecting, setDisconnecting] = useState<FinancialProviderId | null>(null);
  const [oauth, setOauth] = useState<{ owner: string; value: FinancialAuthorization } | null>(null);
  const [stateOwner, setStateOwner] = useState(token);
  if (stateOwner !== token) { setStateOwner(token); setFredOpen(false); setSecret(''); setKeyFor(null); setDisconnecting(null); setOauth(null); setSelected(null); setError(null); setNotice(''); setNeedsReload(false); setBusy(true); }
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) { setWasActive(active); if (!active) { setFredOpen(false); setSecret(''); setKeyFor(null); setDisconnecting(null); setBusy(false); setNeedsReload(true); } }
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const visible = useRef(active);
  const owner = useRef(token);
  useLayoutEffect(() => { visible.current = active; if (!active) { pending.current?.abort(); pending.current = null; } }, [active]);
  useLayoutEffect(() => { owner.current = token; }, [token]);
  const data = catalog?.owner === token ? catalog.value : null;
  const current = (signal: AbortSignal) => mounted.current && visible.current && owner.current === token && !signal.aborted;
  const request = <T,>(path: string, decode: (value: unknown) => T, signal: AbortSignal, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) => pluginRequest(token, path, decode, { method, body, signal, timeoutMs: 40000 });
  const load = async (signal: AbortSignal) => {
    if (!current(signal)) return;
    const value = await request('/v1/plugins/financial/providers?catalog_version=2', decodeFinancialCatalog, signal);
    if (current(signal)) { setCatalog({ owner: token, value }); setNeedsReload(false); }
  };
  const clearKey = () => { setSecret(''); setKeyFor(null); };
  const stop = () => {
    if (pending.current) { if (mutating.current) setNeedsReload(true); pending.current.abort(); pending.current = null; }
    setBusy(false); setFredOpen(false); clearKey(); setDisconnecting(null);
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>, mutation = false) => {
    if (pending.current || !active || !visible.current || owner.current !== token || !mounted.current || AppState.currentState !== 'active') return;
    const controller = new AbortController(); pending.current = controller; mutating.current = mutation;
    setBusy(true); setError(null); setNotice('');
    try { await action(controller.signal); }
    catch (failure) { if (current(controller.signal)) { setError(failure); if (mutation) setNeedsReload(true); } }
    finally { if (pending.current === controller) { pending.current = null; mutating.current = false; if (current(controller.signal)) setBusy(false); } }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); if (active) pending.current = controller;
    if (active) void Promise.resolve().then(() => load(controller.signal)).catch(failure => { if (current(controller.signal)) setError(failure); })
      .finally(() => { if (pending.current === controller) { pending.current = null; if (current(controller.signal)) setBusy(false); } });
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    return () => { mounted.current = false; listener.remove(); controller.abort(); pending.current?.abort(); pending.current = null; };
    // Parent keys this component by account token; current() also rejects stale owners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const found = (id: FinancialProviderId) => data?.providers.find(item => item.id === id);
  const connectionFor = (id: FinancialProviderId) => found(id)?.connection ?? null;
  const update = (id: FinancialProviderId, connection: PluginConnection | null) => setCatalog(previous => previous?.owner === token ? { owner: token, value: { ...previous.value, providers: previous.value.providers.map(item => item.id === id ? { ...item, connection } : item) } } : previous);
  const add = (id: FinancialProviderId) => { void run(async signal => {
    const value = await request('/v1/plugins/financial/connections', value => decodeFinancialConnection(value, id), signal, 'POST', { provider_id: id });
    if (current(signal)) { update(id, value); setNotice(text('已添加个人连接。按下方状态完成授权后使用。', 'Personal connection added. Complete authorization as needed below.')); }
  }, true); };
  const refresh = (id: FinancialProviderId) => { const connection = connectionFor(id); if (!connection) return; void run(async signal => {
    const value = await request(`/v1/plugins/connections/${connection.id}/refresh`, value => decodeFinancialConnection(value, id, connection.id), signal, 'POST');
    if (current(signal)) update(id, value);
  }); };
  const openChat = (id: FinancialProviderId) => { if (id === 'fred') return; const connection = connectionFor(id); if (!connection) return; void run(async signal => {
    const tools = await request(`/v1/plugins/connections/${connection.id}/tools`, decodeList(decodeTool), signal);
    if (!current(signal)) return;
    if (!tools.length) throw new WorkbenchError('PLUGIN_CAPABILITY_UNSUPPORTED');
    const value = await request(`/v1/plugins/connections/${connection.id}`, value => decodeFinancialConnection(value, id), signal);
    if (value.id !== connection.id || value.status !== 'ready' || value.pending_update) throw new WorkbenchError('PLUGIN_RECONFIRM_REQUIRED');
    if (current(signal)) onSelect(value);
  }); };
  const authorize = (id: FinancialProviderId) => { const connection = connectionFor(id); if (!connection) return; void run(async signal => {
    const value = await request(`/v1/plugins/connections/${connection.id}/oauth/start`, value => decodeFinancialAuthorization(value, id, connection.id), signal, 'POST');
    if (current(signal)) { setOauth({ owner: token, value }); update(id, { ...connection, status: 'auth_required', auth_status: 'required' }); }
  }, true); };
  const checkAuthorization = (authorization: FinancialAuthorization) => { void run(async signal => {
    await request(`/v1/plugins/oauth/attempts/${authorization.id}`, value => decodeAuthorizationAttempt(value, authorization), signal);
    if (!current(signal)) return;
    const value = await request(`/v1/plugins/connections/${authorization.connectionId}`, value => decodeFinancialConnection(value, authorization.provider, authorization.connectionId), signal);
    if (value.auth_status !== 'authorized') throw new WorkbenchError('PLUGIN_AUTH_REQUIRED');
    if (current(signal)) { update(authorization.provider, value); setOauth(null); setNotice(authorization.provider === 'fred' ? text('授权已完成，可以开始临时研究；查询和结果不会保存。', 'Authorization completed. Start temporary research; queries and results are not saved.') : text('授权已完成，可刷新能力后在聊天中使用。', 'Authorization completed. Refresh capabilities, then use the service in chat.')); }
  }); };
  const saveKey = () => {
    if (!keyFor || keyFor.owner !== token || busy || needsReload || !data?.credentials_configured || !secret.trim()) return;
    const id = keyFor.provider, connection = connectionFor(id), value = secret.trim();
    if (!connection) return;
    clearKey();
    void run(async signal => {
      const saved = await request(`/v1/plugins/connections/${connection.id}/credential`, value => decodeFinancialConnection(value, id, connection.id), signal, 'POST', { secret: value });
      if (current(signal)) { update(id, saved); setNotice(text('个人密钥已提交；请按连接状态核对是否可用。', 'Personal key submitted. Check connection status for availability.')); }
    }, true);
  };
  const disconnect = () => { const id = disconnecting, connection = id && connectionFor(id); if (!id || !connection) return; setDisconnecting(null); void run(async signal => {
    await request(`/v1/plugins/connections/${connection.id}`, () => undefined, signal, 'DELETE');
    if (current(signal)) { update(id, null); setOauth(null); setNotice(text('已断开此个人连接。', 'Personal connection disconnected.')); }
  }, true); };
  const detail = selected && found(selected), local = selected && FINANCIAL_PROVIDERS[selected], connection = selected && connectionFor(selected);
  const disabled = !active || busy || needsReload || !data?.available;
  const authorization = oauth?.owner === token && oauth.value.provider === selected ? oauth.value : null;
  if (fredOpen && selected === 'fred' && connection && active) return <FredResearchPanel key={`${token}:${connection.id}:${connection.revision}`} token={token} connection={connection} active={active} onBack={() => setFredOpen(false)} />;
  const status = (id: FinancialProviderId) => {
    const item = found(id), saved = connectionFor(id);
    return saved ? connectionStatusLabel(saved.status, text) : !data ? text('连接状态未读取', 'Connection state not loaded') : !item ? text('当前服务暂不支持', 'Not supported by this server') : text('未添加', 'Not added');
  };
  const groups: { title: string; ids: FinancialProviderId[] }[] = [
    { title: text('研究与宏观', 'Research and macro'), ids: ['tavily', 'fred'] },
    { title: text('金融数据', 'Financial data'), ids: ['ifind', 'jin10', 'massive', 'alphavantage', 'twelvedata', 'coingecko'] },
  ];
  const purposes: Record<FinancialProviderId, [string, string]> = { tavily: ['搜索与原文', 'Search and sources'], fred: ['宏观经济指标', 'Economic series'], ifind: ['证券、财务与公告', 'Securities and filings'], jin10: ['财经事件与快讯', 'Events and news'], massive: ['美国市场数据', 'US market data'], alphavantage: ['公司基本面', 'Company fundamentals'], twelvedata: ['行情与技术指标', 'Prices and indicators'], coingecko: ['加密资产研究', 'Crypto research'] };
  const icons = { tavily: Search, fred: Landmark, jin10: Newspaper, coingecko: Bitcoin };
  const keyAction = () => { setSecret(''); setKeyFor({ owner: token, provider: selected! }); };
  return <Page title={local ? text(local.name, local.en) : text('金融插件', 'Financial plugins')}
    description={selected ? undefined : text('选择资料来源，在小Q中研究市场。', 'Choose sources for your market research in Q.')}
    action={selected ? <Action kind="ghost" icon={ArrowLeft} label={text('返回金融插件', 'Back to financial plugins')} disabled={busy} onPress={() => { clearKey(); setSelected(null); if (data) setError(null); setNotice(''); }} /> : undefined}>
    {!!error && <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.soft, padding: 16, borderRadius: 14 }}><Type selectable color={colors.danger}>{financialError(error, text)}</Type></View>}
    {!!notice && <View accessibilityLiveRegion="polite"><Type>{notice}</Type></View>}
    {needsReload && <Type muted>{text('连接可能已保存或更新。请先刷新状态后再操作。', 'The connection may have been saved or changed. Refresh its state before continuing.')}</Type>}
    {busy && <View style={{ gap: 8 }}><ActivityIndicator accessibilityLabel={text('正在处理金融插件', 'Processing financial plugin')} color={colors.accent} /><Action kind="ghost" label={text('取消操作', 'Cancel operation')} onPress={stop} /></View>}
    {data && !data.available && <Type muted>{text('服务器暂未启用金融插件连接。', 'Financial plugin connections are not enabled on this server.')}</Type>}
    {!selected ? <>
      {groups.map(group => <View key={group.title} style={{ gap: 8 }}>
        <Type header size={14} weight="600" muted>{group.title}</Type>
        <View style={{ backgroundColor: colors.surface, borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 16 }}>
          {group.ids.map((id, index) => { const item = FINANCIAL_PROVIDERS[id]; return <Pressable key={id} accessibilityRole="button" accessibilityLabel={text(item.name, item.en)} accessibilityHint={`${text(...purposes[id])} · ${status(id)}`} accessibilityState={{ disabled: busy }} disabled={busy}
            onPress={() => { setSelected(id); clearKey(); setNotice(''); }} style={({ pressed }) => ({ opacity: busy ? 0.55 : pressed ? 0.65 : 1, minHeight: 48 })}><Row last={index === group.ids.length - 1}
            icon={id in icons ? icons[id as keyof typeof icons] : ChartNoAxesCombined} title={text(item.name, item.en)}
            subtitle={`${text(...purposes[id])} · ${status(id)}`} right={<ChevronRight size={17} color={colors.muted} />} /></Pressable>; })}
        </View>
      </View>)}
      <Action kind="ghost" icon={RefreshCw} label={text('刷新连接状态', 'Refresh connection state')} disabled={busy} onPress={() => { void run(load); }} />
      <Type size={13} muted>{text('连接属于你的账号。数据范围、费用和额度由服务方决定。', 'Connections belong to your account. Providers set data coverage, fees and quotas.')}</Type>
    </> : local && <>
      <View style={{ gap: 12, padding: 20, borderRadius: 20, borderCurve: 'continuous', backgroundColor: colors.soft }}>
        <Type size={16}>{text(local.description[0], local.description[1])}</Type>
        <Type size={14} weight="600" color={connection?.status === 'ready' ? colors.green : colors.muted}>{status(selected)}</Type>
        {!detail && data && <Type muted>{text('当前服务器尚未开放此来源，请在服务更新后再连接。已有来源仍可使用。', 'This server has not enabled this source yet. Connect after the service is updated; existing sources remain available.')}</Type>}
      </View>
      <View style={{ gap: 8 }}><Type header size={14} weight="600">{text('研究方向', 'Research ideas')}</Type><Type size={15}>{text(local.example[0], local.example[1])}</Type></View>
      {selected === 'fred' && <View style={{ gap: 6 }}><Type weight="600">{text('临时研究，不保存结果', 'Temporary research, without saved results')}</Type><Type size={14} muted>{text('FRED 使用独立研究页。查询与结果不进入小Q缓存或聊天历史；离开或进入后台后清空。', 'FRED uses a separate research page. Q does not cache queries or results or save them in chat history. Leaving or backgrounding clears them.')}</Type></View>}
      {connection?.last_error_code && <Type selectable color={colors.danger}>{financialError(new WorkbenchError(connection.last_error_code), text)}</Type>}
      {connection ? <>
        {(connection.status === 'ready' || selected === 'fred' && connection.status === 'blocked' && connection.auth_status === 'authorized') && !connection.pending_update && (selected === 'fred'
          ? <Action label={text('开始临时研究', 'Start temporary research')} disabled={disabled} onPress={() => setFredOpen(true)} />
          : <Action label={text('在聊天中使用', 'Use in chat')} disabled={disabled} onPress={() => openChat(selected)} />)}
        {detail?.auth_mode === 'api_key' && connection.auth_status !== 'authorized' && <Action label={text('配置个人密钥', 'Configure personal key')} disabled={disabled || !data?.credentials_configured} onPress={keyAction} />}
        {detail?.auth_mode === 'oauth' && connection.auth_status !== 'authorized' && !authorization && <Action label={text('连接服务账号', 'Connect provider account')} disabled={disabled || !data?.oauth_configured} onPress={() => authorize(selected)} />}
        {selected === 'alphavantage' && detail?.auth_mode === 'oauth' && connection.auth_status !== 'authorized' && <Type size={13} muted>{text('请准备自己的 Alpha Vantage API Key，并在服务方的授权页面填写。', 'Have your Alpha Vantage API key ready to enter on the provider’s authorization page.')}</Type>}
        {authorization && <View style={{ gap: 12 }}>
          <Type size={14} muted>{text('在服务方页面登录并确认范围，返回小Q后检查授权结果。', 'Sign in and review permissions on the provider page, then return to Q and check the result.')}</Type>
          <Action label={text('在浏览器中授权', 'Authorize in browser')} disabled={!active || busy} onPress={() => { if (!visible.current || owner.current !== token) return; void Linking.openURL(authorization.url).catch(() => setError(new WorkbenchError('NETWORK_ERROR'))); }} />
          <Action kind="secondary" label={text('我已授权 检查结果', 'Check authorization result')} disabled={busy} onPress={() => checkAuthorization(authorization)} />
        </View>}
        {connection.pending_update && <Type muted>{text('服务有更新，请到“我的连接”核对并确认后继续使用。', 'Review and accept the service update in My connections before continuing.')}</Type>}
        {detail?.auth_mode === 'api_key' && !data?.credentials_configured && <Type muted>{text('服务器尚未启用安全密钥保存，暂不能配置。', 'Secure key storage is not enabled on this server.')}</Type>}
        {detail?.auth_mode === 'oauth' && !data?.oauth_configured && <Type muted>{text('服务器尚未启用浏览器授权，暂不能连接账号。', 'Browser authorization is not enabled on this server.')}</Type>}
        <View style={{ gap: 8 }}>
          <Type header size={14} weight="600" muted>{text('连接管理', 'Connection settings')}</Type>
          <Action kind="secondary" icon={RefreshCw} label={text('刷新连接状态', 'Refresh connection state')} disabled={busy} onPress={() => { void run(load); }} />
          {selected !== 'fred' && <Action kind="ghost" label={text('刷新服务能力', 'Refresh service capabilities')} disabled={disabled} onPress={() => refresh(selected)} />}
          {detail?.auth_mode === 'api_key' && connection.auth_status === 'authorized' && <Action kind="ghost" label={text('更换个人密钥', 'Replace personal key')} disabled={disabled || !data?.credentials_configured} onPress={keyAction} />}
          {detail?.auth_mode === 'oauth' && connection.auth_status === 'authorized' && <Action kind="ghost" label={text('重新连接服务账号', 'Reconnect provider account')} disabled={disabled || !data?.oauth_configured} onPress={() => authorize(selected)} />}
          <Action kind="ghost" label={text('断开此插件', 'Disconnect plugin')} disabled={disabled} onPress={() => setDisconnecting(selected)} />
        </View>
      </> : <Action label={text('添加金融插件', 'Add financial plugin')} disabled={disabled || !detail} onPress={() => add(selected)} />}
      {!connection && <Action kind="ghost" icon={RefreshCw} label={text('刷新连接状态', 'Refresh connection state')} disabled={busy} onPress={() => { void run(load); }} />}
      <Action kind="ghost" label={text('查看服务官方说明', 'View official service details')} onPress={() => { void Linking.openURL(local.home).catch(() => setError(new WorkbenchError('NETWORK_ERROR'))); }} />
      <Type size={13} muted>{text('添加连接不会自动查询。可用范围以本次授权和实际返回结果为准。', 'Adding a connection does not run a query. Availability follows your authorization and the actual results returned.')}</Type>
    </>}
    <Sheet visible={active && keyFor?.owner === token} title={text('配置个人密钥', 'Configure personal key')} onClose={clearKey}>
      <Type muted>{keyFor?.provider === 'ifind' ? text('粘贴同花顺官方配置中的完整 Authorization 值。不会自动添加或修改前缀。', 'Paste the complete Authorization value from the official iFinD configuration. No prefix is added or changed.') : text('粘贴金十官方提供的 MCP Token。', 'Paste the MCP Token provided by Jin10.')}</Type>
      <Input label={text('个人服务密钥', 'Personal provider key')} value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" maxLength={8192} editable={!busy} />
      <Type size={13} muted>{text('密钥仅用于当前账号的此项连接，加密保存在服务器；不会加入聊天。提交或关闭后清空输入。', 'The key is encrypted on the server for this connection and account only. It is never added to chat; input is cleared after submission or closing.')}</Type>
      <Action label={text('保存个人密钥', 'Save personal key')} disabled={busy || needsReload || !secret.trim()} onPress={saveKey} />
    </Sheet>
    <Sheet visible={active && disconnecting !== null} title={text('断开金融插件', 'Disconnect plugin')} onClose={() => setDisconnecting(null)}>
      <Type>{text('断开后，小Q不能再使用此连接查询。服务方账号和订阅不受影响。', 'Q will no longer query through this connection. Your provider account and subscription remain unchanged.')}</Type>
      <Action label={text('确认断开', 'Confirm disconnect')} disabled={busy} onPress={disconnect} />
    </Sheet>
  </Page>;
}
