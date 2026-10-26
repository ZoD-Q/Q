import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Action, Type, useDesign } from '../design';
import { WorkbenchError } from '../api-workbench/core';
import { BankProposalView } from '../banking/proposal';
import { bankReceiptForInvocation, bankFailureForInvocation } from '../banking/result';
import { formatHKD } from '../banking/core';
import { getBank } from '../banking/catalog';
import { bankIdForPlugin, bankTransferArguments, decodeInvocation, pluginError, type PluginInvocation } from './core';
import { pluginRequest } from './client';
import { PluginResultView } from './result-view';
import { argumentRows, bankReadPresentation, invocationActionTitle, resolvedInvocation } from './presentation';

/** Conversation surface only. Advanced connection and tool details remain in My plugins. */
export function ChatInvocationView({ invocation, token, onChanged, onResolved, mediaOnly = false, disabled = false }: {
  invocation: PluginInvocation; token: string; onChanged: (value: PluginInvocation) => void;
  onResolved?: (value: PluginInvocation) => void; mediaOnly?: boolean; disabled?: boolean;
}) {
  const { colors, text } = useDesign();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [needsRefresh, setNeedsRefresh] = useState(false);
  const request = useRef<AbortController | null>(null);
  const uncertain = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  const bank = bankIdForPlugin(invocation), transfer = !!bank && invocation.tool_name === 'bank_transfer';
  const act = async (action: '' | '/confirm' | '/cancel') => {
    if (request.current || mediaOnly || disabled) return;
    if (action === '/confirm' && (uncertain.current || needsRefresh || invocation.status !== 'awaiting_confirmation' || (transfer && !bankTransferArguments(invocation)))) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
    // A submitted confirmation is never submitted a second time after an unknown outcome.
    if (action) uncertain.current = true;
    try {
      const result = await pluginRequest(token, `/v1/plugins/invocations/${invocation.id}${action}`, decodeInvocation, {
        method: action ? 'POST' : 'GET', ...(action === '/confirm' ? { body: { confirmed: true } } : {}), signal: controller.signal,
      });
      if (result.id !== invocation.id || result.connection_id !== invocation.connection_id) throw new WorkbenchError('INVALID_RESPONSE');
      if (controller.signal.aborted) return;
      onChanged(result);
      setNeedsRefresh(uncertain.current && result.status === 'awaiting_confirmation');
      if (action !== '/cancel' && resolvedInvocation(result)) onResolved?.(result);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure); if (action) setNeedsRefresh(true); }
    } finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  };
  if (mediaOnly) {
    const receipt = bankReceiptForInvocation(invocation), failure = bankFailureForInvocation(invocation);
    return <View style={{ gap: 8 }}>
      {receipt ? <Type selectable size={13}>{text(`已转出 ${formatHKD(receipt.amount_minor)} 至${getBank(receipt.destination_bank_id).zh} · ${receipt.recipient === 'self' ? '我的账户' : '陈小明'}（模拟 HKD）`, `Sent ${formatHKD(receipt.amount_minor)} to ${getBank(receipt.destination_bank_id).en} · ${receipt.recipient === 'self' ? 'My account' : 'Chen Xiaoming'} (Demo HKD)`)}</Type>
        : failure ? <Type size={13} color={colors.danger}>{failure === 'INSUFFICIENT_FUNDS' ? text('模拟余额不足，转账未完成。', 'Insufficient simulated balance. The transfer was not completed.') : text('模拟转账未完成，请核对账户和金额。', 'The simulated transfer did not complete. Check the accounts and amount.')}</Type> : null}
      {invocation.result != null && <PluginResultView value={invocation.result} token={token} connectionId={invocation.connection_id} compact mediaOnly />}
    </View>;
  }
  const completed = resolvedInvocation(invocation), bankRead = bankReadPresentation(invocation, text);
  const waiting = invocation.status === 'awaiting_confirmation' && !needsRefresh;
  return <View style={{ gap: 12, paddingVertical: 8 }}>
    {transfer ? <BankProposalView invocation={invocation} busy={busy || disabled} needsRefresh={needsRefresh} onConfirm={() => { void act('/confirm'); }} onCancel={() => { void act('/cancel'); }} onRefresh={() => { void act(''); }} />
      : waiting ? <View style={{ backgroundColor: colors.soft, borderRadius: 18, padding: 16, gap: 12 }}>
        <Type size={13} muted>{invocation.connection_title}</Type>
        <Type weight="500">{invocationActionTitle(invocation, text)}</Type>
        {argumentRows(invocation.arguments, invocation.input_schema, text).map((row, index) => <View key={index} style={{ gap: 4 }}><Type size={12} muted>{row.label}</Type><Type selectable size={14}>{row.value}</Type></View>)}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action style={{ minHeight: 48 }} label={text('确认', 'Confirm')} disabled={busy || disabled} onPress={() => { void act('/confirm'); }} /><Action style={{ minHeight: 48 }} kind="ghost" label={text('取消', 'Cancel')} disabled={busy || disabled} onPress={() => { void act('/cancel'); }} /></View>
      </View> : completed ? <>
        {bankRead ? <View style={{ gap: 8 }}><Type size={13} muted>{bankRead.title} · {text('模拟 HKD', 'Demo HKD')}</Type>{bankRead.lines.map((line, index) => <Type key={index} selectable size={bankRead.lines.length === 1 ? 22 : 14}>{line}</Type>)}</View>
          : <PluginResultView value={invocation.result} token={token} connectionId={invocation.connection_id} compact />}
      </> : <View style={{ gap: 8 }}>
        <Type size={13} muted>{needsRefresh || invocation.status === 'unknown' ? text('结果待确认', 'Waiting for confirmation of the result')
          : invocation.status === 'running' ? text('正在处理…', 'Working…')
            : invocation.status === 'succeeded' ? text('暂时无法读取结果', 'The result is not available yet')
              : invocation.status === 'cancelled' ? text('已取消', 'Cancelled') : invocation.status === 'expired' ? text('这项操作已过期，请重新提出请求。', 'This action expired. Send a new request.')
                : text('这项操作未完成', 'This action did not complete')}</Type>
        {['unknown', 'running', 'succeeded', 'tool_error'].includes(invocation.status) || needsRefresh ? <Action style={{ minHeight: 48 }} kind="ghost" label={text('查看进度', 'Check progress')} disabled={busy || disabled} onPress={() => { void act(''); }} /> : null}
      </View>}
    {busy && <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在处理', 'Working')} />}
    {!!error && <Type size={13} color={colors.danger}>{pluginError(error, text)}</Type>}
    {!!invocation.error_code && !transfer && <Type size={13} color={colors.danger}>{pluginError(invocation.error_code, text)}</Type>}
  </View>;
}
