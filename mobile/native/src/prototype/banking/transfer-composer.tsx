import { useState } from 'react';
import { View } from 'react-native';
import { ArrowLeft, Check, ChevronDown } from 'lucide-react-native';
import { Action, Choice, Input, Row, Sheet, Type, useDesign } from '../design';
import { BANKS, getBank } from './catalog';
import { parseAmount } from './core';

/** Produces an editable chat instruction only; no account or tool executes here. */
export function BankTransferComposer({ bankId, onClose, onDraft }: { bankId: string; onClose: () => void; onDraft: (value: string) => void }) {
  const { text, colors } = useDesign();
  const [recipient, setRecipient] = useState<'self' | 'demo_chen' | ''>('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const source = getBank(bankId);
  const finish = () => {
    if (!recipient || !destination) { setError(text('请选择收款人和收款银行。', 'Select the recipient and destination bank.')); return; }
    if (recipient === 'self' && destination === bankId) { setError(text('请选择另一个收款账户。', 'Choose a different destination account.')); return; }
    try {
      const cents = parseAmount(amount), to = getBank(destination);
      if (Array.from(memo).length > 120 || /[\u0000-\u001f\u007f]/.test(memo)) throw new Error('MEMO');
      const formatted = (cents / 100).toFixed(2);
      const line = text(`从${source.zh}转${formatted}港币到${recipient === 'self' ? '我自己' : '陈小明'}的${to.zh}账户`, `Transfer HKD ${formatted} from ${source.en} to ${recipient === 'self' ? 'my own' : 'Chen at'} ${to.en} account`);
      onDraft(line + (memo.trim() ? text(` 备注：${memo.trim()}`, ` memo: ${memo.trim()}`) : ''));
      onClose();
    } catch { setError(text('金额需大于零且最多两位小数；备注最多 120 字。', 'Enter a positive amount with up to two decimals and a memo up to 120 characters.')); }
  };
  return <Sheet visible title={choosing ? text('选择收款银行', 'Choose destination bank') : text('转账', 'Transfer')} onClose={onClose}>
    {choosing ? <>
      <Action icon={ArrowLeft} kind="ghost" label={text('返回转账信息', 'Back to transfer details')} onPress={() => setChoosing(false)} />
      <Input label={text('搜索银行', 'Search banks')} value={search} onChangeText={setSearch} />
      {BANKS.filter(bank => [bank.zh, bank.en, ...bank.aliases].join(' ').toLowerCase().includes(search.toLowerCase())).map(bank => <Row key={bank.id} title={text(bank.zh, bank.en)} right={destination === bank.id ? <Check color={colors.accent} size={18} /> : undefined} onPress={() => { setDestination(bank.id); setChoosing(false); setError(''); }} />)}
    </> : <>
      <Type size={12} color={colors.accent}>{text('银行插件 · 模拟港币', 'Bank plugin · Simulated HKD')}</Type>
      <Row title={text('付款银行', 'Source bank')} subtitle={text(source.zh, source.en)} />
      <View style={{ gap: 8 }}><Type size={13} weight="500">{text('收款人', 'Recipient')}</Type><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Choice label={text('我自己', 'Myself')} selected={recipient === 'self'} onPress={() => setRecipient('self')} /><Choice label={text('陈小明（虚构）', 'Chen (fictional)')} selected={recipient === 'demo_chen'} onPress={() => setRecipient('demo_chen')} /></View><Type size={12} muted>{text('DEMO-0001 为虚构收款标识，不查询真实手机号。', 'DEMO-0001 is a fictional recipient ID. Real phone numbers are not queried.')}</Type></View>
      <Row title={text('收款银行', 'Destination bank')} subtitle={destination ? text(getBank(destination).zh, getBank(destination).en) : text('选择银行', 'Choose a bank')} right={<ChevronDown color={colors.muted} size={18} />} onPress={() => { setSearch(''); setChoosing(true); }} />
      <Input label={text('金额（HKD）', 'Amount (HKD)')} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="500.00" />
      <Input label={text('备注（可选）', 'Memo (optional)')} value={memo} onChangeText={setMemo} maxLength={120} />
      <Type size={12} muted>{text('即时转账。预约和定期转账暂不支持。', 'Instant transfers only. Scheduled and recurring transfers are unavailable.')}</Type>
      {error ? <Type color={colors.danger} size={13}>{error}</Type> : null}
      <Action label={text('填写到对话框', 'Use in chat')} onPress={finish} />
      <Type size={12} muted>{text('先生成指令，发送后核对转账卡并确认。此步骤不会扣款。', 'Review the instruction, send it, then confirm the transfer card. This step does not debit your account.')}</Type>
    </>}
  </Sheet>;
}
