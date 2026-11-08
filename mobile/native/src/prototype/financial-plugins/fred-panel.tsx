import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, View } from 'react-native';
import { ArrowLeft } from 'lucide-react-native';
import { Action, Choice, Input, Page, Type, useDesign } from '../design';
import { WorkbenchError } from '../api-workbench/core';
import { pluginRequest } from '../plugin-host/client';
import { type PluginConnection } from '../plugin-host/core';
import { financialError } from './core';
import { decodeFredCatalog, decodeFredReading, fredArguments, fredFields, fredLabel, fredToolLabel, type FredCatalog, type FredField, type FredReading } from './fred-core';

export function FredResearchPanel({ token, connection, active, onBack }: { token: string; connection: PluginConnection; active: boolean; onBack: () => void }) {
  const { colors, text, locale } = useDesign();
  const [catalog, setCatalog] = useState<FredCatalog | null>(null);
  const [selected, setSelected] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});
  const [result, setResult] = useState<FredReading | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const owner = `${token}:${connection.id}:${connection.revision}`;
  const identity = useRef(owner);
  const enabled = useRef(active);
  const [stateOwner, setStateOwner] = useState(owner);
  if (stateOwner !== owner) { setStateOwner(owner); setCatalog(null); setSelected(''); setInput({}); setResult(null); setError(null); setBusy(false); setCleared(true); }
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) { setWasActive(active); if (!active) { setCatalog(null); setInput({}); setResult(null); setSelected(''); setError(null); setBusy(false); setCleared(true); } }
  const clear = () => {
    request.current?.abort(); request.current = null;
    setCatalog(null); setSelected(''); setInput({}); setResult(null); setError(null); setBusy(false); setCleared(true);
  };
  useLayoutEffect(() => {
    identity.current = owner; enabled.current = active;
    request.current?.abort(); request.current = null;
  }, [owner, active]);
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') clear(); });
    return () => { mounted.current = false; listener.remove(); request.current?.abort(); request.current = null; };
    // clear only holds setters and the current request ref; no user data is captured.
  }, []);
  const current = (signal: AbortSignal) => mounted.current && enabled.current && identity.current === owner && !signal.aborted;
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (request.current || !active || !enabled.current || identity.current !== owner || AppState.currentState !== 'active') return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null); setResult(null);
    try { await action(controller.signal); }
    catch (failure) { if (current(controller.signal)) { setError(failure); setResult(null); if (failure instanceof WorkbenchError && ['PLUGIN_AUTH_CHANGED', 'PLUGIN_RECONFIRM_REQUIRED', 'PLUGIN_AUTH_REQUIRED', 'PLUGIN_UNAVAILABLE'].includes(failure.code)) { setCatalog(null); setInput({}); setSelected(''); } } }
    finally { if (request.current === controller) { request.current = null; if (current(controller.signal)) setBusy(false); } }
  };
  const load = () => { void run(async signal => {
    const value = await pluginRequest(token, `/v1/plugins/connections/${connection.id}/fred/tools`, decodeFredCatalog, { signal, timeoutMs: 40000 });
    if (value.connection_revision !== connection.revision) throw new WorkbenchError('PLUGIN_AUTH_CHANGED');
    if (current(signal)) { setCatalog(value); setSelected(value.items[0]?.name ?? ''); setInput({}); setCleared(false); }
  }); };
  const tool = catalog?.items.find(item => item.name === selected);
  let fields: FredField[] = [], unsupported = false;
  if (tool) { try { fields = fredFields(tool); } catch { unsupported = true; } }
  const query = () => {
    if (!tool || !catalog || unsupported) return;
    let args: ReturnType<typeof fredArguments>;
    try { args = fredArguments(fields, input); } catch (failure) { setError(failure); setResult(null); return; }
    void run(async signal => {
      const value = await pluginRequest(token, `/v1/plugins/connections/${connection.id}/fred/query`, value => decodeFredReading(value, { id: connection.id, revision: catalog.connection_revision, tool: tool.name }, locale),
        { signal, method: 'POST', timeoutMs: 40000, body: { connection_revision: catalog.connection_revision, tool_name: tool.name, arguments: args } });
      if (current(signal)) setResult(value);
    });
  };
  const errorText = error instanceof WorkbenchError && ['FRED_FORM_UNSUPPORTED', 'FRED_INPUT_INVALID', 'FRED_RESULT_INVALID'].includes(error.code)
    ? error.code === 'FRED_INPUT_INVALID' ? text('请检查必填条件、日期或数值范围。', 'Check required fields, dates and numeric ranges.')
      : error.code === 'FRED_FORM_UNSUPPORTED' ? text('这项查询的条件暂不支持，请选择其他查询。', 'These query fields are not supported. Choose another query.')
        : text('来源返回的结果无法完整展示，本次没有保留结果。', 'The source result could not be displayed safely. Nothing was retained.')
    : financialError(error, text);
  return <Page title={text('临时宏观研究', 'Temporary macro research')} description={text('使用 FRED 官方经济数据，先核对指标口径。', 'Explore official FRED economic data and check series definitions.')}
    action={<Action icon={ArrowLeft} kind="ghost" label={text('返回 FRED', 'Back to FRED')} onPress={() => { clear(); onBack(); }} />}>
    <View style={{ backgroundColor: colors.soft, borderRadius: 18, borderCurve: 'continuous', padding: 18, gap: 8 }}>
      <Type weight="600">{text('本次查询不保存', 'This research is not saved')}</Type>
      <Type size={14}>{text('查询和结果仅在当前页面临时显示，不进入小Q缓存或聊天历史。离开、切换账号或进入后台后清空。', 'Queries and results appear only on this page. Q does not cache them or add them to chat history. Leaving, switching accounts or backgrounding clears them.')}</Type>
      <Type size={13} muted>{text('FRED 数据不代表圣路易斯联储认可小Q或其分析。', 'FRED data does not imply endorsement of Q or its analysis by the Federal Reserve Bank of St. Louis.')}</Type>
      <Action kind="ghost" label={text('查看 FRED 使用条款', 'View FRED terms')} onPress={() => { void Linking.openURL('https://fred.stlouisfed.org/legal/#MCPConnector').catch(() => { if (mounted.current && enabled.current && identity.current === owner) setError(new WorkbenchError('NETWORK_ERROR')); }); }} />
    </View>
    {cleared && <Type muted>{text('临时内容已清空。需要继续时，重新读取查询选项。', 'Temporary content was cleared. Load the query options again to continue.')}</Type>}
    {!catalog && <Action label={text('读取查询选项', 'Load query options')} disabled={!active || busy} onPress={load} />}
    {catalog && <>
      <View accessibilityRole="tablist" style={{ gap: 8 }}>
        {catalog.items.map(item => <Choice key={item.name} label={fredToolLabel(item.name, locale)} selected={selected === item.name} disabled={busy} onPress={() => { setSelected(item.name); setInput({}); setResult(null); setError(null); }} />)}
      </View>
      {unsupported ? <Type color={colors.danger}>{text('服务提供了当前页面尚不支持的查询条件。本次未提交查询。', 'The service requires fields this page cannot support. No query was submitted.')}</Type> : fields.map(field => <View key={field.name} style={{ gap: 8 }}>
        {field.choices || field.type === 'boolean' ? <><Type size={14} weight="500">{fredLabel(field.name, locale)}{field.required ? text(' · 必填', ' · Required') : text(' · 可选', ' · Optional')}</Type>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{(field.choices ?? ['true', 'false']).map(choice => <Choice key={choice} label={field.type === 'boolean' ? choice === 'true' ? text('是', 'Yes') : text('否', 'No') : choice} selected={input[field.name] === choice} disabled={busy} onPress={() => { setInput(previous => ({ ...previous, [field.name]: previous[field.name] === choice && !field.required ? '' : choice })); setResult(null); }} />)}</View>
        </> : <Input label={`${fredLabel(field.name, locale)}${field.required ? text(' · 必填', ' · Required') : text(' · 可选', ' · Optional')}`} value={input[field.name] ?? ''}
          maxLength={field.maxLength ?? 500} editable={!busy && active} autoCapitalize="none" autoCorrect={false} keyboardType={['number', 'integer'].includes(field.type) ? 'numbers-and-punctuation' : 'default'}
          onChangeText={value => { setInput(previous => ({ ...previous, [field.name]: value })); setResult(null); }} />}
      </View>)}
      <Action label={text('查询 FRED', 'Query FRED')} disabled={!active || busy || !tool || unsupported} onPress={query} />
    </>}
    {busy && <View style={{ gap: 8 }}><ActivityIndicator accessibilityLabel={text('正在读取 FRED', 'Reading FRED')} color={colors.accent} /><Action kind="ghost" label={text('取消并清空', 'Cancel and clear')} onPress={clear} /></View>}
    {!!error && <View accessibilityLiveRegion="polite"><Type color={colors.danger}>{errorText}</Type></View>}
    {result && <View style={{ gap: 16 }}>
      <Type size={20} weight="600">{text('本次结果', 'Current result')}</Type>
      <Type size={13} muted>{text('获取时间：', 'Retrieved: ')}{result.retrievedAt}</Type>
      {result.rows.map((row, index) => <View key={index} style={{ gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderColor: colors.line }}><Type size={13} muted>{row.label}</Type><Type>{row.value}</Type></View>)}
      {result.limited && <Type muted>{text('仅展示本次结果的前一部分；请缩小查询范围。', 'Only part of this result is shown. Narrow the query for more detail.')}</Type>}
      <Action kind="ghost" label={text('清空本次研究', 'Clear this research')} onPress={clear} />
    </View>}
  </Page>;
}
