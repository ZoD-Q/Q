import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useIsFocused } from 'expo-router/react-navigation';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import * as Linking from 'expo-linking';
import { ArrowDownLeft, ArrowUpRight, History, RefreshCw, Wallet } from 'lucide-react-native';
import { Action, Divider, IconAction, Page, Type, useDesign } from '../design';
import { SUPPORT_EMAIL } from '../privacy';
import { API_URL } from '../../services/api';
import { getSessionRevision, subscribeSession } from '../../services/session-store';
import { createPaymentClient, type PaymentClient } from './client';
import { createFundingController } from './controller';
import { paymentJournal } from './journal';
import type { PaymentJournal } from './journal-core';
import type { PaymentChannel, PaymentWallet } from './types';
import { money, PaymentError } from './validation';
import { FundingFlow, PaymentDetail, PaymentOrders, WithdrawContact } from './ui';

type WalletRead = { wallet: PaymentWallet | null; busy: boolean; error: string };
/** A logical sign-out fences both response publication and future token access immediately.
 * Neither disposal nor sign-out deletes owner-scoped pending payment recovery records. */
export function createPaymentWalletSession(deps: {
  token: string; ownerId: string; journal: PaymentJournal; newId(): string;
  store: { getRevision(): number; subscribe(listener: (token: string | null) => void): () => void };
  makeClient(getToken: () => string | null): PaymentClient;
  onWallet(snapshot: WalletRead): void;
}) {
  const generation = deps.store.getRevision(); let valid = true; let visible = false; let started = false;
  let activationVersion = 0; let startup: Promise<void> | null = null;
  let stopSubscription: (() => void) | null = null; let walletRequest: AbortController | null = null; let walletVersion = 0;
  const current = () => valid && generation === deps.store.getRevision();
  const client = deps.makeClient(() => current() ? deps.token : null);
  const refreshWallet = async () => {
    if (!current() || !visible) return;
    const version = ++walletVersion; walletRequest?.abort(); const request = new AbortController(); walletRequest = request;
    // A stale balance never becomes an apparent current balance while reconciling credit.
    deps.onWallet({ wallet: null, busy: true, error: '' });
    try {
      const wallet = await client.wallet(request.signal);
      if (current() && visible && version === walletVersion && !request.signal.aborted) deps.onWallet({ wallet, busy: false, error: '' });
    } catch (error) {
      if (current() && visible && version === walletVersion && !request.signal.aborted) deps.onWallet({ wallet: null, busy: false, error: error instanceof PaymentError ? error.code : 'NETWORK_ERROR' });
    } finally { if (walletRequest === request) walletRequest = null; }
  };
  const controller = createFundingController({ client, journal: deps.journal, identity: { ownerId: deps.ownerId, generation }, isCurrent: current, newId: deps.newId, onCredited: refreshWallet });
  const dispose = () => {
    valid = false; visible = false; walletVersion++; walletRequest?.abort(); controller.dispose();
    stopSubscription?.(); stopSubscription = null;
  };
  return {
    controller, client, generation, isCurrent: current, refreshWallet,
    connect() {
      stopSubscription?.();
      if (generation === deps.store.getRevision()) valid = true;
      stopSubscription = deps.store.subscribe(token => { if (token !== deps.token || !current()) dispose(); });
      if (!current()) dispose();
    },
    disconnect() {
      valid = false; visible = false; started = false; activationVersion++; walletVersion++; walletRequest?.abort(); controller.setActive(false);
      stopSubscription?.(); stopSubscription = null;
      // React development effects reconnect synchronously. Real unmount still fences token
      // access immediately, and destroys the controller before another task can run.
      queueMicrotask(() => { if (!valid) controller.dispose(); });
    },
    setActive(active: boolean) {
      visible = active && current();
      if (!visible) { started = false; activationVersion++; walletVersion++; walletRequest?.abort(); controller.setActive(false); return; }
      void refreshWallet();
      if (!started) {
        started = true; const version = activationVersion; const previous = startup;
        startup = Promise.resolve(previous).then(async () => {
          if (!current() || !visible || version !== activationVersion) return;
          await controller.load();
          if (current() && visible && version === activationVersion) controller.setActive(true);
        });
      } else controller.setActive(true);
    },
    dispose,
  };
}

/** Parent integrates this entry only after standalone review. A fresh token/owner gets a
 * fresh component before effects, so another account's balances and drafts cannot flash. */
export function PaymentWalletEntry(props: { token: string; ownerId: string; onShowDemo?(): void }) {
  return <ScopedPaymentWallet key={`${props.ownerId}:${props.token}`} {...props} />;
}
function ScopedPaymentWallet({ token, ownerId, onShowDemo }: { token: string; ownerId: string; onShowDemo?(): void }) {
  const { text, colors, phone } = useDesign(); const focused = useIsFocused();
  const revision = useSyncExternalStore(listener => subscribeSession(() => listener()), getSessionRevision, getSessionRevision);
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const [wallet, setWallet] = useState<WalletRead>({ wallet: null, busy: false, error: '' });
  const [page, setPage] = useState<'overview' | 'funding' | 'orders' | 'detail' | 'withdraw'>('overview');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [amount, setAmount] = useState(''); const [channel, setChannel] = useState<PaymentChannel>('wechat');
  const [runtime] = useState(() => createPaymentWalletSession({
    token, ownerId, store: { getRevision: getSessionRevision, subscribe: subscribeSession },
    makeClient: getToken => createPaymentClient({ baseUrl: API_URL, getToken, transport: expoFetch }),
    journal: paymentJournal(new URL(API_URL).origin, ownerId), newId: randomUUID, onWallet: setWallet,
  }));
  const controller = runtime.controller;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const identityCurrent = revision === runtime.generation && runtime.isCurrent();
  useEffect(() => { runtime.connect(); return () => runtime.disconnect(); }, [runtime]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', value => setForeground(value === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => { runtime.setActive(focused && foreground && identityCurrent); return () => runtime.setActive(false); }, [runtime, focused, foreground, identityCurrent]);
  const overview = () => { setPage('overview'); if (runtime.isCurrent()) void runtime.refreshWallet(); };
  const orders = () => { setPage('orders'); void controller.loadOrders('pending'); };
  const openCheckout = () => { void controller.openCheckout(Linking.openURL); };
  const refreshAll = () => { void controller.load(); void runtime.refreshWallet(); };
  if (!identityCurrent) return <Page title={text('钱包', 'Wallet')}><Type muted>{text('账号状态已变化，请重新登录后查看钱包。原充值记录会按账号保留。', 'Your session changed. Sign in again to view this wallet. Original funding records remain associated with their owner.')}</Type></Page>;
  if (page === 'withdraw') return <WithdrawContact email={SUPPORT_EMAIL || undefined} onBack={overview} />;
  if (page === 'orders') return <PaymentOrders state={state.orders} onView={view => { void controller.loadOrders(view); }} onRefresh={() => { void controller.loadOrders(state.orders.view); }} onMore={() => { void controller.loadOrders(state.orders.view, true); }} onSelect={order => { if (!state.busy) { setDetailId(order.payment_id); setPage('detail'); void controller.select(order); } }} onBack={overview} />;
  if (page === 'detail') return <PaymentDetail order={state.order?.payment_id === detailId ? state.order : null} busy={state.busy} error={state.error} serverOffset={state.serverOffset} onRefresh={() => { void controller.refresh(); }} onOpenCheckout={openCheckout} onDetach={() => { void controller.detach(); }} onBack={() => setPage('orders')} onOrders={orders} />;
  if (page === 'funding') return <FundingFlow
    state={state.phase === 'loading' && !state.busy && state.error ? { ...state, phase: 'unavailable' } : state}
    amount={amount} channel={channel} onAmountChange={setAmount} onChannelChange={setChannel}
    onQuote={() => { void controller.quote(amount, channel); }} onConfirm={() => { void controller.confirm(); }}
    onRefresh={() => { if (state.pending || state.order) void controller.refresh(); else void controller.load(); }} onOpenCheckout={openCheckout} onDetach={() => { void controller.detach(); }} onOrders={orders}
    onBack={() => { if (state.phase === 'review') controller.edit(); else overview(); }} />;
  const unavailable = state.capabilities ? !state.capabilities.enabled : !!state.error && !state.busy;
  const balanceError = ['UNAUTHORIZED', 'invalid_session', 'INVALID_SESSION'].includes(wallet.error)
    ? text('请重新登录 Q 后读取余额。', 'Sign in to Q again to read your balance.')
    : wallet.error === 'RATE_LIMITED'
      ? text('读取较频繁，请稍后重新读取余额。', 'Too many balance requests. Please wait and reload your balance.')
      : text('余额暂时无法读取，请重新读取余额。', 'Your balance could not be read. Please reload your balance.');
  return <Page title={text('钱包', 'Wallet')} action={<IconAction icon={RefreshCw} label={text('刷新钱包', 'Refresh wallet')} disabled={wallet.busy || state.busy} onPress={refreshAll} />}>
    <View style={{ gap: 16 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Wallet size={22} color={colors.accent} strokeWidth={1.5} /><Type size={14} muted>{text('港币支付余额', 'HKD payment balance')}</Type></View><Type selectable size={phone ? 42 : 52} weight="500" style={{ letterSpacing: -1.5, fontVariant: ['tabular-nums'] }}>{wallet.wallet ? money(wallet.wallet.balance_minor, 'HKD') : '—'}</Type><Type size={12} muted>{text('独立港币账本 · 与 QDC 及模拟银行卡资金分开', 'Separate HKD ledger · Independent of QDC and simulated bank funds')}</Type></View>
    {wallet.busy ? <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在读取港币余额', 'Loading HKD balance')} /> : null}
    {wallet.error ? <View accessibilityLiveRegion="polite" style={{ gap: 12 }}><Type selectable color={colors.danger} size={14}>{balanceError}</Type><Action kind="ghost" label={text('重新读取余额', 'Reload balance')} onPress={() => { void runtime.refreshWallet(); }} disabled={wallet.busy} /></View> : null}
    <View style={{ gap: 12 }}><Action icon={ArrowDownLeft} label={text('充值', 'Add money')} disabled={state.busy} onPress={() => { controller.edit(); setPage('funding'); }} /><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}><Action kind="secondary" icon={History} label={text('充值订单', 'Funding orders')} onPress={orders} /><Action kind="secondary" icon={ArrowUpRight} label={text('提现咨询', 'Withdrawal enquiry')} onPress={() => setPage('withdraw')} /></View></View>
    {unavailable ? <View style={{ backgroundColor: colors.soft, padding: 20, borderRadius: 20, gap: 10 }}><Type size={15} weight="500">{text('充值服务暂未开放', 'Funding is currently unavailable')}</Type><Type muted style={{ lineHeight: 23 }}>{text('服务开放后，可使用已启用的方式以人民币付款，经核实和审核后计入港币余额。当前没有本地模拟充值。', 'When enabled, available methods accept CNY payment and credit HKD after verification and review. There is no local simulated funding fallback.')}</Type></View> : <Type muted size={13} style={{ lineHeight: 22 }}>{text('人民币付款，港币入账。每笔充值均会显示实际应付金额、汇率来源及有效期。', 'Pay in CNY and receive HKD. Each quote shows the payable amount, rate source and expiry.')}</Type>}
    {state.pending || (state.order && !state.order.safe_to_start_new) ? <Action kind="secondary" label={text('查询待确认的原充值', 'Check the original pending payment')} onPress={() => { setPage('funding'); void controller.refresh(); }} /> : null}
    <Divider />{onShowDemo ? <View style={{ gap: 12 }}><Type size={17} weight="500">{text('模拟银行账户', 'Simulated bank accounts')}</Type><Type muted size={13}>{text('20 家银行插件的演示资金保留在单独的钱包中。', 'Demo funds from 20 bank plugins remain in a separate wallet.')}</Type><Action kind="ghost" label={text('查看模拟账户', 'View demo accounts')} onPress={onShowDemo} /></View> : null}
  </Page>;
}
