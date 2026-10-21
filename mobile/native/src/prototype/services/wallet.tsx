import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, CreditCard, Landmark, Plus, RefreshCw, WalletCards } from 'lucide-react-native';
import { Action, Choice, Divider, IconAction, Input, Page, Row, Sheet, Tabs, Type, useDesign } from '../design';
import { useQAccount } from '../account/account-state';
import { BANKS, getBank } from '../banking/catalog';
import { BankCardArt, hasBankCardImage } from '../banking/cards';
import { formatHKD } from '../banking/core';
import { bankingError, connectBanks, fetchBankEntries, fetchBankTransactions, fetchBankWallet, type BankAccount, type BankEntry, type BankReceipt, type BankWallet } from '../banking/client';

type Snapshot = { token: string; bankId: string; wallet: BankWallet; receipts: BankReceipt[]; entries: BankEntry[]; receiptCursor: string | null; entryCursor: string | null };
export function WalletPage({ onTransfer }: { onTransfer: (account: BankAccount) => void }) {
  const { text, colors } = useDesign();
  const account = useQAccount();
  if (!account.session) return <Page title={text('钱包', 'Wallet')}><View style={{ gap: 20, paddingVertical: 30 }}><WalletCards size={40} strokeWidth={1.3} color={colors.accent} /><Type size={24} weight="500">{text('你的银行卡和每一笔流水。', 'Your cards and every transaction.')}</Type><Type muted style={{ lineHeight: 24 }}>{text('登录 Q 后添加银行插件，查看属于你的模拟港币账户。', 'Sign in to Q to add bank plugins and view your simulated HKD accounts.')}</Type><Action label={text('登录 / 注册', 'Sign in / register')} disabled={account.authBusy} onPress={account.requestAuth} /></View></Page>;
  // A new identity gets a fresh view immediately, before effects can run.
  return <BankWalletContent key={account.session.token} token={account.session.token} onTransfer={onTransfer} />;
}
function BankWalletContent({ token, onTransfer }: { token: string; onTransfer: (account: BankAccount) => void }) {
  const { text, colors, phone, locale } = useDesign();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('transactions');
  const [error, setError] = useState('');
  const [working, setBusy] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const [adding, setAdding] = useState(false);
  const [bankSearch, setBankSearch] = useState('');
  const [detail, setDetail] = useState<BankReceipt | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const cardCarousel = useRef<ComponentRef<typeof ScrollView>>(null);
  const request = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const queryKey = `${selected}:${refreshCount}`;
  const busy = working || loadedKey !== queryKey;
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    void Promise.all([fetchBankWallet(token, controller.signal), fetchBankTransactions(token, { bankId: selected || undefined, signal: controller.signal }), fetchBankEntries(token, { bankId: selected || undefined, signal: controller.signal })]).then(([wallet, receipts, entries]) => {
      if (!controller.signal.aborted) setSnapshot({ token, bankId: selected, wallet, receipts: receipts.items, entries: entries.items, receiptCursor: receipts.next_cursor, entryCursor: entries.next_cursor });
    }).then(() => { if (!controller.signal.aborted) setError(''); }).catch(failure => { if (!controller.signal.aborted) setError(bankingError(failure, text)); }).finally(() => { if (!controller.signal.aborted) setLoadedKey(queryKey); });
    return () => controller.abort();
    // Locale changes update presentation, not account scope or network requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selected, refreshCount, queryKey]);
  useEffect(() => () => { request.current?.abort(); mutation.current?.abort(); }, []);
  const visible = snapshot?.bankId === selected ? snapshot : null;
  const wallet = snapshot?.wallet;
  const orderedAccounts = useMemo(() => [...(wallet?.accounts ?? [])].sort((a,b) => BANKS.findIndex(item => item.id === a.bank_id) - BANKS.findIndex(item => item.id === b.bank_id)), [wallet?.accounts]);
  useEffect(() => {
    const index = orderedAccounts.findIndex(item => item.bank_id === selected);
    if (index >= 0) cardCarousel.current?.scrollTo({ x: index * (phone ? 279 : 294), animated: false });
  }, [selected, orderedAccounts, phone]);
  const selectedAccount = wallet?.accounts.find(a => a.bank_id === selected);
  const refresh = () => setRefreshCount(value => value + 1);
  const connect = async (bankIds: string[]) => {
    if (!token || mutation.current || busy) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError('');
    try {
      await connectBanks(token, bankIds, controller.signal);
      if (!controller.signal.aborted) { setAdding(false); refresh(); }
    } catch (failure) { if (!controller.signal.aborted) setError(bankingError(failure, text)); }
    finally { if (mutation.current === controller) mutation.current = null; if (!controller.signal.aborted) setBusy(false); }
  };
  const more = async () => {
    if (!token || !visible || busy) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true); setError('');
    try {
      if (tab === 'transactions' && visible.receiptCursor) {
        const page = await fetchBankTransactions(token, { bankId: selected || undefined, cursor: visible.receiptCursor, signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot(current => current?.token === token ? { ...current, receipts: [...current.receipts, ...page.items.filter(item => !current.receipts.some(r => r.id === item.id))], receiptCursor: page.next_cursor } : current);
      } else if (tab === 'entries' && visible.entryCursor) {
        const page = await fetchBankEntries(token, { bankId: selected || undefined, cursor: visible.entryCursor, signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot(current => current?.token === token ? { ...current, entries: [...current.entries, ...page.items.filter(item => !current.entries.some(r => r.id === item.id))], entryCursor: page.next_cursor } : current);
      }
    } catch (failure) { if (!controller.signal.aborted) setError(bankingError(failure, text)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const name = (id: string) => text(getBank(id).zh, getBank(id).en);
  const timestamp = (value: string) => new Date(value).toLocaleString(locale === 'zh' ? 'zh-HK' : 'en-HK');
  const detailRow = (label: string, value: string) => <View style={{ flexDirection: 'row', gap: 20, justifyContent: 'space-between' }}><Type size={13} muted>{label}</Type><Type selectable size={13} style={{ flexShrink: 1, textAlign: 'right' }}>{value}</Type></View>;
  return <Page title={text('钱包', 'Wallet')} action={<IconAction icon={RefreshCw} label={text('刷新钱包', 'Refresh wallet')} disabled={busy || !token} onPress={refresh} />}>
    <>
      <View style={{ gap: 10 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Type size={12} muted>{text('模拟港币总资产', 'Total simulated HKD')}</Type><View style={{ paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.accentBg, borderRadius: 5 }}><Type size={10} color={colors.accent}>{text('模拟资金', 'DEMO FUNDS')}</Type></View></View><Type selectable size={phone ? 36 : 42} weight="500" style={{ letterSpacing: -1.5, fontVariant: ['tabular-nums'] }}>{wallet ? formatHKD(wallet.total_balance_minor) : '—'}</Type><Type size={12} muted>{text('银行插件账户 · 随 Q 账号保存至服务器', 'Bank plugin accounts · Saved with your Q account')}</Type></View>
      {error && loadedKey === queryKey ? <View accessibilityLiveRegion="polite" style={{ gap: 8 }}><Type selectable color={colors.danger} size={13}>{error}</Type><Action kind="ghost" label={text('重新读取钱包', 'Reload wallet')} disabled={busy} onPress={refresh} /></View> : null}
      {busy ? <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在更新钱包', 'Updating wallet')} /> : null}
      <View style={{ gap: 16 }}><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><Type size={19} weight="600">{text('我的银行卡', 'My bank cards')} {wallet?.accounts.length ? `· ${wallet.accounts.length}` : ''}</Type><Action kind="ghost" icon={Plus} label={text('添加银行卡', 'Add cards')} disabled={busy} onPress={() => { setBankSearch(''); setAdding(true); }} /></View>
        {!wallet?.accounts.length ? <View style={{ backgroundColor: colors.soft, padding: 24, borderRadius: 24, gap: 18 }}><CreditCard size={34} color={colors.accent} strokeWidth={1.2} /><Type size={19} weight="500">{text('把银行插件放进钱包', 'Bring bank plugins into your wallet')}</Type><Type muted style={{ lineHeight: 24 }}>{text('支持 20 家香港银行的内置模拟插件。每个新账户有 HK$100,000 演示额度，可在首页对话完成模拟转账。', 'Built-in simulations for 20 Hong Kong banks. Each new account starts with HK$100,000, ready for transfers in your Q conversation.')}</Type><Action label={text('添加 20 张模拟银行卡', 'Add 20 simulated bank cards')} disabled={busy || !wallet} onPress={() => { setBankSearch(''); setAdding(true); }} /></View> : <>
          <ScrollView ref={cardCarousel} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingBottom: 5 }}>
            {orderedAccounts.map(card => <Pressable key={card.id} accessibilityRole="button" accessibilityLabel={text(`查看${name(card.bank_id)}银行卡及流水`, `View ${name(card.bank_id)} card and activity`)} accessibilityState={{ selected: selected === card.bank_id, disabled: busy }} disabled={busy} onPress={() => { if (!busy) setSelected(card.bank_id); }} style={({ pressed }) => ({ width: phone ? 265 : 280, borderWidth: 1, borderColor: selected === card.bank_id ? colors.accent : colors.line, backgroundColor: pressed ? colors.soft : colors.surface, borderRadius: 24, padding: 18, gap: 13 })}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><Type size={15} weight="600" style={{ flexShrink: 1 }}>{name(card.bank_id)}</Type><Type size={10} color={colors.accent}>{text('模拟账户', 'DEMO')}</Type></View>
              <BankCardArt bankId={card.bank_id} />
              <Type size={10} muted>{hasBankCardImage(card.bank_id) ? text('银行公开产品参考图 · 非实际绑定卡', 'Public product reference · Not a linked real card') : text('模拟数字账户 · 非实体发行卡', 'Simulated digital account · No physical card issued')}</Type>
              <Type selectable size={12} muted>{card.masked_number}</Type><Type selectable size={25} weight="500" style={{ fontVariant: ['tabular-nums'] }}>{formatHKD(card.balance_minor)}</Type>
            </Pressable>)}
          </ScrollView>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Action icon={ArrowUpRight} label={text('在对话中转账', 'Transfer in chat')} disabled={busy} onPress={() => { const source = selectedAccount ?? orderedAccounts[0]; if (source.connection_id) onTransfer(source); else { setBankSearch(name(source.bank_id)); setAdding(true); } }} /><Action kind="secondary" icon={ChevronDown} label={selectedAccount ? name(selectedAccount.bank_id) : text('全部银行卡', 'All bank cards')} disabled={busy} onPress={() => setFilterOpen(true)} /></View>
        </>}
      </View>
      <Divider />
      <View style={{ gap: 18 }}><Tabs items={[{ id: 'transactions', label: text('转账记录', 'Transfers') }, { id: 'entries', label: text('资金流水', 'Account activity') }]} value={tab} onChange={setTab} />
        {selected ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><Type size={12} muted>{name(selected)}</Type><Action kind="ghost" label={text('查看全部', 'View all')} disabled={busy} onPress={() => setSelected('')} /></View> : null}
        {tab === 'transactions' ? visible?.receipts.length ? visible.receipts.map(receipt => <Pressable key={receipt.id} accessibilityRole="button" accessibilityLabel={text(`查看模拟转账回执 ${formatHKD(receipt.amount_minor)}`, `View demo receipt ${formatHKD(receipt.amount_minor)}`)} onPress={() => setDetail(receipt)} style={{ minHeight: 74, flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: colors.line }}><View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' }}><ArrowUpRight size={20} color={colors.accent} /></View><View style={{ flex: 1, gap: 5 }}><Type size={14} weight="500">{receipt.recipient === 'self' ? text('自己的账户', 'Own account') : text('陈小明（虚构）', 'Chen (fictional)')}</Type><Type size={11} muted>{name(receipt.source_bank_id)} → {name(receipt.destination_bank_id)}</Type><Type size={10} muted>{timestamp(receipt.created_at)}</Type></View><Type selectable size={15} weight="500" style={{ fontVariant: ['tabular-nums'] }}>{formatHKD(receipt.amount_minor)}</Type></Pressable>) : <Type muted size={14}>{text('暂无转账记录。确认一笔模拟转账后，回执会出现在这里。', 'No transfers yet. Confirm a demo transfer to see its receipt here.')}</Type>
          : visible?.entries.length ? visible.entries.map(entry => <View key={entry.id} style={{ minHeight: 80, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: colors.line, paddingVertical: 13 }}><View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: entry.direction === 'in' ? colors.greenBg : colors.soft, alignItems: 'center', justifyContent: 'center' }}>{entry.direction === 'in' ? <ArrowDownLeft size={20} color={colors.green} /> : <ArrowUpRight size={20} color={colors.muted} />}</View><View style={{ flex: 1, gap: 5 }}><Type size={14} weight="500">{entry.kind === 'initial' ? text('初始演示额度', 'Initial demo credit') : entry.direction === 'in' ? text('转账收入', 'Transfer credit') : text('转账支出', 'Transfer debit')}</Type><Type size={11} muted>{name(entry.bank_id)} · {timestamp(entry.created_at)}</Type>{entry.memo ? <Type size={11} muted>{entry.memo}</Type> : null}</View><View style={{ gap: 5, alignItems: 'flex-end' }}><Type selectable size={15} color={entry.direction === 'in' ? colors.green : colors.ink} style={{ fontVariant: ['tabular-nums'] }}>{entry.direction === 'in' ? '+' : '−'}{formatHKD(entry.amount_minor)}</Type><Type size={10} muted>{text('余额 ', 'Balance ')}{formatHKD(entry.balance_after_minor)}</Type></View></View>) : <Type muted size={14}>{text('添加银行卡后显示初始额度、收入与支出的完整流水。', 'Add cards to see initial credits, incoming and outgoing entries.')}</Type>}
        {(tab === 'transactions' ? visible?.receiptCursor : visible?.entryCursor) ? <Action kind="secondary" label={text('加载更多', 'Load more')} disabled={busy} onPress={() => { void more(); }} /> : null}
      </View>
      <Type size={11} muted style={{ lineHeight: 19 }}>{text('模拟港币与 QDC 分开记账。卡面仅为产品参考或模拟数字账户，不代表真实开户、绑卡或银行合作。', 'Simulated HKD is separate from QDC. Card imagery is a product reference or simulated digital account, not a real account, linked card, or bank partnership.')}</Type>
    </>
    <Sheet visible={adding} title={text('添加银行插件和模拟卡', 'Add bank plugins and simulated cards')} onClose={() => { if (!busy) setAdding(false); }}>
      <Type muted style={{ lineHeight: 23 }}>{text('添加后可在对话中调用此银行插件。新账户初始 HK$100,000；重复添加不会重新充值。所有资金均为模拟。', 'After adding, call the bank plugin in chat. Each new account starts with HK$100,000; adding again does not refill it. All funds are simulated.')}</Type>
      <Action label={text('确认添加全部 20 家银行', 'Confirm adding all 20 banks')} disabled={busy || !token} onPress={() => { void connect(BANKS.map(bank => bank.id)); }} />
      <Input label={text('搜索银行', 'Search banks')} value={bankSearch} onChangeText={setBankSearch} />
      {BANKS.filter(bank => [bank.zh, bank.en, ...bank.aliases].join(' ').toLowerCase().includes(bankSearch.toLowerCase())).map(bank => <Row key={bank.id} title={text(bank.zh, bank.en)} subtitle={wallet?.accounts.some(a => a.bank_id === bank.id && a.connection_id) ? text('已添加 · 在钱包查看', 'Added · View in wallet') : text('内置模拟插件 · HKD', 'Built-in demo plugin · HKD')} right={wallet?.accounts.some(a => a.bank_id === bank.id && a.connection_id) ? <Check size={18} color={colors.accent} /> : <Plus size={18} color={colors.accent} />} onPress={busy ? undefined : () => { void connect([bank.id]); }} />)}
    </Sheet>
    <Sheet visible={filterOpen} title={text('选择银行卡', 'Select a bank card')} onClose={() => setFilterOpen(false)}>
      <Choice label={text('全部银行卡', 'All cards')} selected={!selected} onPress={() => { setSelected(''); setFilterOpen(false); }} />
      {wallet?.accounts.map(card => <Row key={card.id} icon={Landmark} title={name(card.bank_id)} subtitle={`${card.masked_number} · ${formatHKD(card.balance_minor)}`} right={selected === card.bank_id ? <Check size={18} color={colors.accent} /> : undefined} onPress={() => { setSelected(card.bank_id); setFilterOpen(false); }} />)}
    </Sheet>
    <Sheet visible={detail !== null} title={text('模拟转账回执', 'Demo transfer receipt')} onClose={() => setDetail(null)}>
      {detail ? <><Type size={35} weight="500">{formatHKD(detail.amount_minor)}</Type><Type color={colors.green}>{text('已记账 · 无真实资金转移', 'Recorded · No real funds moved')}</Type><Divider />{detailRow(text('付款银行', 'From'), name(detail.source_bank_id))}{detailRow(text('收款银行', 'To bank'), name(detail.destination_bank_id))}{detailRow(text('收款人', 'Recipient'), detail.recipient === 'self' ? text('我自己', 'Myself') : text('陈小明（虚构）', 'Chen (fictional)'))}{detailRow(text('付款后余额', 'Source balance after'), formatHKD(detail.source_balance_minor))}{detail.destination_balance_minor !== null ? detailRow(text('收款后余额', 'Destination balance after'), formatHKD(detail.destination_balance_minor)) : null}{detail.memo ? detailRow(text('备注', 'Memo'), detail.memo) : null}{detailRow(text('时间', 'Time'), timestamp(detail.created_at))}<Type selectable size={12} muted>{detail.id}</Type></> : null}
    </Sheet>
  </Page>;
}
