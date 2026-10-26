import { CheckCircle2, ArrowDown, Landmark } from 'lucide-react-native';
import { View } from 'react-native';
import { Action, Type, useDesign } from '../design';
import { bankTransferArguments, type PluginInvocation } from '../plugin-host/core';
import { bankReceiptForInvocation, bankFailureForInvocation } from './result';
import { getBank } from './catalog';
import { formatHKD } from './core';
import { SlideConfirm } from './slide-confirm';

/** Displays the saved server proposal and receipt; it never calculates or mutates balances. */
export function BankProposalView({ invocation, busy, needsRefresh, onConfirm, onCancel, onRefresh }: {
  invocation: PluginInvocation; busy: boolean; needsRefresh: boolean;
  onConfirm: () => void; onCancel: () => void; onRefresh: () => void;
}) {
  const { colors, text } = useDesign();
  const proposal = bankTransferArguments(invocation);
  if (!proposal) return <View style={{ gap: 10 }}><Type color={colors.danger}>{text('无法核对这笔转账，请取消后重新填写。', 'This transfer could not be verified. Cancel it and enter the details again.')}</Type>{invocation.status === 'awaiting_confirmation' && <Action style={{ minHeight: 48 }} kind="ghost" label={text('取消', 'Cancel')} disabled={busy} onPress={onCancel} />}</View>;
  const source = getBank(proposal.sourceBankId), destination = getBank(proposal.destinationBankId);
  const receipt = bankReceiptForInvocation(invocation);
  const failure = bankFailureForInvocation(invocation);
  const failureMessages: Record<string, [string, string]> = {
    INSUFFICIENT_FUNDS: ['付款银行的模拟余额不足。请减少金额或更换付款银行，再发送新指令。', 'The source bank has insufficient simulated funds. Reduce the amount or change the source bank and send a new instruction.'],
    BANK_ACCOUNT_UNAVAILABLE: ['付款或收款银行账户不可用。请先在钱包添加对应银行，再发送新指令。', 'A source or destination account is unavailable. Add the bank in Wallet before sending a new instruction.'],
    BANK_SAME_ACCOUNT: ['付款和收款是同一个账户。请改选收款银行。', 'The source and destination are the same account. Choose another destination bank.'],
    VALIDATION_ERROR: ['转账参数未通过校验。请核对金额和备注后重新填写。', 'The transfer details failed validation. Check the amount and memo, then write a new instruction.'],
    IDEMPOTENCY_CONFLICT: ['原请求编号与内容不一致，已阻止执行。请查看原回执。', 'This request ID has different details. Execution was blocked. Check the original receipt.'],
    BANK_TOOL_ERROR: ['银行插件拒绝了这笔模拟转账，未扣款。请核对账户与金额后发送新指令。', 'The bank plugin rejected this simulated transfer without debiting. Check the accounts and amount before a new instruction.'],
  };
  const terminalLabel: Record<string, [string, string]> = {
    cancelled: ['转账已取消', 'Transfer cancelled'], expired: ['转账确认已过期', 'Confirmation expired'],
    running: ['正在处理，请查询状态', 'Processing; check status'], unknown: ['结果待确认，请查询状态', 'Outcome unknown; check status'],
    failed: ['转账未完成', 'Transfer not completed'], tool_error: ['转账未完成', 'Transfer not completed'],
  };
  return <View style={{ borderRadius: 24, borderCurve: 'continuous', padding: 20, gap: 18, backgroundColor: colors.soft, overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {receipt ? <CheckCircle2 color={colors.accent} size={20} /> : <Landmark color={colors.accent} size={20} />}
        <Type weight="600">{receipt ? text('转账完成', 'Transfer complete') : text('银行转账', 'Bank transfer')}</Type>
      </View>
      <Type size={11} color={colors.accent}>{text('模拟 HKD', 'Demo HKD')}</Type>
    </View>
    <View style={{ gap: 4 }}><Type selectable size={30} weight="600" style={{ fontVariant: ['tabular-nums'] }}>{formatHKD(proposal.amountMinor)}</Type><Type size={12} muted>{text('仅更新小Q服务端模拟账户，不转移真实资金', 'Updates Q’s server-side simulated accounts. No real money moves.')}</Type></View>
    <View style={{ gap: 10 }}>
      <View><Type size={12} muted>{text('付款账户', 'From')}</Type><Type selectable weight="500">{text(source.zh, source.en)} · {text('我的账户', 'My account')}</Type></View>
      <ArrowDown size={16} color={colors.faint} />
      <View><Type size={12} muted>{text('收款账户', 'To')}</Type><Type selectable weight="500">{text(destination.zh, destination.en)} · {proposal.recipient === 'self' ? text('我的账户', 'My account') : text('陈小明（虚构收款人）', 'Chen Xiaoming (fictional recipient)')}</Type></View>
    </View>
    {!!proposal.memo && <View><Type size={12} muted>{text('备注', 'Memo')}</Type><Type selectable>{proposal.memo}</Type></View>}
    {receipt ? <View style={{ gap: 8 }}>
      <Type selectable size={13}>{text('付款账户余额：', 'Source balance: ')}{formatHKD(receipt.source_balance_minor)}</Type>
      {receipt.destination_balance_minor !== null && <Type selectable size={13}>{text('收款账户余额：', 'Destination balance: ')}{formatHKD(receipt.destination_balance_minor)}</Type>}
      <Type selectable size={12} muted>{new Date(receipt.created_at).toLocaleString(text('zh-CN', 'en-US'))}</Type>
    </View> : invocation.status === 'awaiting_confirmation' && !needsRefresh ? <>
      <Type size={14} weight="600">{text(`确认转出 ${formatHKD(proposal.amountMinor)}`, `Confirm ${formatHKD(proposal.amountMinor)}`)}</Type>
      <SlideConfirm key={invocation.id} busy={busy} onConfirm={onConfirm} />
      <Action style={{ minHeight: 48 }} kind="ghost" label={text('取消转账', 'Cancel transfer')} disabled={busy} onPress={onCancel} />
    </> : <View style={{ gap: 10 }}>
      <Type color={invocation.status === 'succeeded' ? colors.danger : colors.muted}>{needsRefresh
        ? text('确认结果尚未返回，请先查询，不要重新发起转账。', 'Confirmation has not returned. Check its status before another action.')
        : failure ? text(...failureMessages[failure]) : invocation.status === 'succeeded' ? text('暂时无法读取转账记录，请重新查看。', 'The transfer record could not be loaded. Check again.')
          : text(...(terminalLabel[invocation.status] ?? ['等待服务端结果', 'Waiting for the server']))}</Type>
      {!failure && <Action style={{ minHeight: 48 }} kind="secondary" label={text('查询转账状态', 'Check transfer status')} disabled={busy} onPress={onRefresh} />}
    </View>}
  </View>;
}
