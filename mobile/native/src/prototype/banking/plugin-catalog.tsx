import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Landmark, RefreshCw } from 'lucide-react-native';
import { Action, Page, Type, useDesign } from '../design';
import { pluginRequest } from '../plugin-host/client';
import { bankIdForPlugin, decodePluginConnection, type PluginConnection } from '../plugin-host/core';
import { WorkbenchError } from '../api-workbench/core';
import { BANKS } from './catalog';
import { bankingError, connectBanks, fetchBankWallet, type BankWallet } from './client';

export function BankPluginCatalog({ token, onSelect }: { token: string; onSelect: (connection: PluginConnection) => void }) {
  const { colors, text } = useDesign();
  const [wallet, setWallet] = useState<BankWallet | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  const run = async (id: string, operation: (signal: AbortSignal) => Promise<void>) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setBusy(id); setError(null);
    try { await operation(controller.signal); } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(null); } }
  };
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    void fetchBankWallet(token, controller.signal).then(value => { if (!controller.signal.aborted) setWallet(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); })
      .finally(() => { if (!controller.signal.aborted) { request.current = null; setBusy(null); } });
    return () => { controller.abort(); request.current?.abort(); };
  }, [token]);
  const choose = (bankId: string, connectionId: string) => { void run(bankId, async signal => {
    const connection = await pluginRequest(token, `/v1/plugins/connections/${connectionId}`, decodePluginConnection, { signal });
    if (bankIdForPlugin(connection) !== bankId || connection.status !== 'ready') throw new WorkbenchError('BANK_NOT_CONNECTED');
    if (!signal.aborted) onSelect(connection);
  }); };
  return <Page title={text('银行插件', 'Bank plugins')} description={text('在小Q对话里查询余额和转账。每个已添加的模拟账户首次获得 HK$100,000。', 'Check balances and transfer in your Q chat. Each new simulated account starts with HK$100,000.')}>
    <Type size={12} muted>{text('20 家银行场景由小Q提供，使用服务器模拟资金。未连接银行真实系统。', 'Q provides 20 bank scenarios with server-side simulated funds. Real bank systems are not connected.')}</Type>
    {!!error && <Type color={colors.danger}>{bankingError(error, text)}</Type>}
    <Action kind="ghost" icon={RefreshCw} label={text('刷新银行插件', 'Refresh bank plugins')} disabled={!!busy} onPress={() => { void run('load', async signal => { const value = await fetchBankWallet(token, signal); if (!signal.aborted) setWallet(value); }); }} />
    {busy === 'load' && <ActivityIndicator color={colors.accent} />}
    {BANKS.map(bank => {
      const account = wallet?.accounts.find(item => item.bank_id === bank.id);
      return <View key={bank.id} style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' }}><Landmark size={22} color={bank.color} /></View>
        <View style={{ flex: 1, minWidth: 130, gap: 4 }}><Type weight="500">{text(bank.zh, bank.en)}</Type><Type size={12} muted>{account?.connection_id ? text('已添加 · 模拟账户', 'Added · simulated account') : text('余额 · 转账 · 交易记录', 'Balance · transfers · history')}</Type></View>
        {busy === bank.id ? <ActivityIndicator color={colors.accent} /> : account?.connection_id
          ? <Action kind="secondary" label={text('在聊天中用', 'Use in chat')} disabled={!!busy} onPress={() => choose(bank.id, account.connection_id!)} />
          : <Action kind="ghost" label={text('添加插件', 'Add plugin')} disabled={!!busy || !wallet} onPress={() => { void run(bank.id, async signal => { const value = await connectBanks(token, [bank.id], signal); if (!signal.aborted) setWallet(value); }); }} />}
      </View>;
    })}
  </Page>;
}
