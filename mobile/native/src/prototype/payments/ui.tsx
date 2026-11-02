import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as Linking from 'expo-linking';
import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3, ShieldCheck, Wallet } from 'lucide-react-native';
import { Action, Choice, Divider, IconAction, Input, Page, Row, Sheet, Tabs, Type, useDesign } from '../design';
import type { FundingState, PaymentChannel, PaymentOrder } from './types';
import { amountMinor, money, safeCheckout, trustedUnsubmittedProof } from './validation';

/** StaticRef: official KAI HBC module2188 amount/method/review/status/orders;
 * module1855 checkout-detach. Native reference screens were not observed at runtime.
 * Q uses its own theme/components and server contract, never KAI demo funding fixtures. */
export function paymentStatus(status: PaymentOrder['status'], text: (zh: string, en: string) => string) {
  const labels = {
    creating: ['正在建立订单', 'Creating order'], awaiting_payment: ['等待付款', 'Awaiting payment'],
    confirming: ['正在核实付款', 'Verifying payment'], awaiting_credit_approval: ['付款已确认 · 等待入账审核', 'Payment verified · Awaiting credit review'],
    crediting: ['正在入账', 'Crediting your wallet'], credited: ['已入账', 'Credited'], expired: ['支付页面已到期', 'Checkout expired'],
    failed: ['未完成', 'Not completed'], review_required: ['需要人工核实', 'Review required'],
  } satisfies Record<PaymentOrder['status'], [string, string]>;
  return text(...labels[status]);
}
export function paymentError(code: string, text: (zh: string, en: string) => string) {
  if (code === 'UNAUTHORIZED' || code === 'invalid_session') return text('请重新登录，原充值记录会保留。', 'Sign in again. Your original payment is retained.');
  if (code === 'INVALID_AMOUNT') return text('请输入限额内、最多两位小数的正数港币金额。', 'Enter a positive HKD amount within the limits, with up to two decimal places.');
  if (code === 'PAYMENT_QUOTE_EXPIRED') return text('报价已过期，请重新获取并核对。', 'This quote expired. Get and review a new quote.');
  if (code === 'PAYMENT_STORAGE_ERROR') return text('无法安全保存充值意图，未继续提交。请先查询原订单。', 'The payment intent could not be saved safely. Submission stopped. Check the original order.');
  if (code === 'PAYMENTS_UNAVAILABLE') return text('充值服务暂未开放，请稍后查看。', 'Funding is currently unavailable. Check again later.');
  if (code === 'PAYMENT_OPERATION_PENDING') return text('请先核实原充值结果，再开始另一笔。', 'Check the original payment before starting another.');
  if (code === 'RATE_LIMITED') return text('操作较频繁，请稍后查询原订单。', 'Too many requests. Wait before checking the original order.');
  return text('暂时无法确认结果。请查询原充值，不要重复付款。', 'The result could not be confirmed. Check the original payment; do not pay again.');
}
function DetailRow({ label, value }: { label: string; value: string }) {
  const { phone } = useDesign();
  return <View style={{ flexDirection: phone ? 'column' : 'row', justifyContent: 'space-between', gap: 6 }}><Type size={13} muted>{label}</Type><Type selectable size={15} style={{ flexShrink: 1 }}>{value}</Type></View>;
}
function ErrorNotice({ code, message }: { code: string; message?: string }) {
  const { text, colors } = useDesign();
  return code ? <View accessibilityLiveRegion="polite"><Type selectable size={14} color={colors.danger}>{message ?? paymentError(code, text)}</Type></View> : null;
}
export type FundingFlowProps = {
  state: FundingState; amount: string; channel: PaymentChannel; onAmountChange(value: string): void; onChannelChange(value: PaymentChannel): void;
  onQuote(): void; onConfirm(): void; onRefresh(): void; onOpenCheckout(): void; onBack(): void; onOrders(): void; onDetach(): void;
};
export function FundingFlow(props: FundingFlowProps) {
  const { text, colors } = useDesign(); const { state, amount, channel } = props;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const quote = state.quote; const caps = state.capabilities;
  const seconds = quote ? Math.max(0, Math.ceil((Date.parse(quote.expires_at) - clock - state.serverOffset) / 1000)) : 0;
  const parsed = amountMinor(amount); const available = caps?.enabled && caps.channels.some(c => c.id === channel && c.enabled);
  const validAmount = parsed !== null && caps?.min_credit_amount_minor_hkd !== null && caps?.min_credit_amount_minor_hkd !== undefined && caps?.max_credit_amount_minor_hkd !== null && caps?.max_credit_amount_minor_hkd !== undefined && parsed >= caps.min_credit_amount_minor_hkd && parsed <= caps.max_credit_amount_minor_hkd;
  const busy = state.busy || (state.retryAt !== null && clock < state.retryAt);
  if (state.order || (state.pending && state.phase !== 'review')) return <PaymentDetail order={state.order} busy={busy} error={state.error} pending={!!state.pending} serverOffset={state.serverOffset} onRefresh={props.onRefresh} onOpenCheckout={props.onOpenCheckout} onDetach={props.onDetach} onBack={props.onBack} onOrders={props.onOrders} />;
  return <Page title={text('充值', 'Add money')} action={<IconAction icon={ArrowLeft} label={text('返回钱包', 'Back to wallet')} onPress={props.onBack} />}>
    <View style={{ gap: 12 }}><Wallet size={32} color={colors.accent} strokeWidth={1.3} /><Type size={14} muted>{text('人民币付款 · 港币入账', 'Pay in CNY · Receive HKD')}</Type><Type size={30} weight="500">{text('为钱包充值', 'Fund your wallet')}</Type></View>
    {state.phase === 'loading' ? <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在读取充值服务', 'Loading funding service')} /> : null}
    {state.phase === 'unavailable' || (!caps?.enabled && state.phase !== 'loading') ? <View style={{ gap: 18 }}><Type muted>{text('充值服务暂未开放。模拟银行卡余额保留在独立的演示账户中。', 'Funding is currently unavailable. Simulated bank balances remain in separate demo accounts.')}</Type><Action kind="secondary" label={text('重新查看服务', 'Check availability')} onPress={props.onRefresh} disabled={busy} /></View> : state.phase === 'review' && quote ? <>
      <Type size={21} weight="500">{text('核对充值', 'Review funding')}</Type>
      <View style={{ backgroundColor: colors.soft, borderRadius: 20, padding: 20, gap: 20 }}><DetailRow label={text('到账金额', 'Wallet credit')} value={`${money(quote.credit_amount_minor_hkd, 'HKD')} HKD`} /><Divider /><DetailRow label={text('实际支付', 'You pay')} value={`${money(quote.pay_amount_minor_cny, 'CNY')} CNY`} /><DetailRow label={text('包含费用', 'Fee included')} value={money(quote.fee_minor_cny, 'CNY')} /><DetailRow label={text('支付方式', 'Payment method')} value={quote.channel === 'wechat' ? text('微信支付', 'WeChat Pay') : text('支付宝', 'Alipay')} /></View>
      <View style={{ gap: 14 }}><DetailRow label={text('每100港币汇率', 'CNY per 100 HKD')} value={quote.rate_cny_per_100_hkd} /><DetailRow label={text('汇率来源', 'Rate source')} value={quote.rate_source} /><DetailRow label={text('来源日期', 'Source date')} value={quote.rate_source_date} /><DetailRow label={text('报价剩余', 'Quote remaining')} value={seconds ? `${seconds}${text(' 秒', ' seconds')}` : text('已过期', 'Expired')} /></View>
      <Type size={13} muted>{text('付款后仍需核实并完成入账审核。返回应用不代表充值成功。', 'Payment verification and credit review follow payment. Returning to the app does not confirm credit.')}</Type>
      <Action label={seconds ? text(`支付 ${money(quote.pay_amount_minor_cny, 'CNY')} CNY`, `Pay ${money(quote.pay_amount_minor_cny, 'CNY')} CNY`) : text('报价已过期', 'Quote expired')} disabled={busy || !seconds} onPress={props.onConfirm} />
      <Action kind="secondary" label={seconds ? text('修改金额或方式', 'Edit amount or method') : text('重新获取报价', 'Get a new quote')} disabled={busy} onPress={props.onBack} />
    </> : caps?.enabled ? <>
      <Input label={text('希望到账的金额（HKD）', 'Amount to receive (HKD)')} value={amount} keyboardType="decimal-pad" maxLength={24} editable={!busy} onChangeText={props.onAmountChange} hint={caps.min_credit_amount_minor_hkd !== null && caps.max_credit_amount_minor_hkd !== null ? `${money(caps.min_credit_amount_minor_hkd, 'HKD')} – ${money(caps.max_credit_amount_minor_hkd, 'HKD')}` : undefined} />
      {amount && !validAmount ? <Type size={13} color={colors.danger}>{text('请输入限额内的港币金额，最多两位小数。', 'Enter an HKD amount within the limits, with up to two decimals.')}</Type> : null}
      <View style={{ gap: 12 }}><Type size={15} weight="500">{text('支付方式', 'Payment method')}</Type>{(['wechat', 'alipay'] as const).map(id => { const enabled = caps.channels.some(c => c.id === id && c.enabled); return <View key={id} style={{ opacity: enabled ? 1 : 0.45 }}><Choice label={`${id === 'wechat' ? text('微信支付', 'WeChat Pay') : text('支付宝', 'Alipay')}${enabled ? '' : text(' · 暂未开放', ' · Unavailable')}`} selected={channel === id} onPress={() => { if (!busy && enabled) props.onChannelChange(id); }} /></View>; })}</View>
      <Action label={busy ? text('正在获取报价', 'Getting quote') : text('获取并核对报价', 'Get and review quote')} disabled={busy || !available || !validAmount} onPress={props.onQuote} />
    </> : null}
    <ErrorNotice code={state.error} message={!state.pending && !state.order && state.phase === 'amount' && ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(state.error) ? text('未能取得可用报价，尚未创建新的充值订单。请稍后重试。', 'A usable quote could not be obtained. No new funding order has been created. Please try again later.') : undefined} /><Action kind="ghost" label={text('充值订单', 'Funding orders')} onPress={props.onOrders} />
  </Page>;
}
export function PaymentDetail({ order, busy, error = '', pending = false, serverOffset = 0, onRefresh, onOpenCheckout, onDetach, onBack, onOrders }: {
  order: PaymentOrder | null; busy: boolean; error?: string; pending?: boolean; serverOffset?: number; onRefresh(): void; onOpenCheckout(): void; onDetach(): void; onBack(): void; onOrders?(): void;
}) {
  const { text, colors } = useDesign(); const [time, setTime] = useState(() => Date.now());
  const [detachOpen, setDetachOpen] = useState(false);
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const isCredited = order?.status === 'credited';
  const notSubmitted = order !== null && trustedUnsubmittedProof(order);
  return <Page title={text('充值详情', 'Funding details')} action={<IconAction icon={ArrowLeft} label={text('返回', 'Back')} onPress={onBack} />}>
    <View accessibilityLiveRegion="polite" style={{ gap: 18, alignItems: 'flex-start' }}>{isCredited ? <CheckCircle2 size={44} color={colors.green} strokeWidth={1.4} /> : <Clock3 size={44} color={colors.accent} strokeWidth={1.4} />}<Type size={25} weight="500">{notSubmitted ? text('未提交付款', 'Payment not submitted') : order ? paymentStatus(order.status, text) : text('正在核实原充值', 'Checking original payment')}</Type><Type muted style={{ lineHeight: 24 }}>{isCredited ? text('港币已计入钱包余额。', 'HKD has been credited to your wallet.') : notSubmitted ? order?.safe_to_start_new ? text('服务端已确认这笔订单未提交付款、没有扣款。可以重新获取报价后发起新充值。', 'The server confirmed this order was not submitted and no payment was debited. Get a new quote to start another payment.') : text('服务端已确认这笔订单未提交付款、没有扣款。其他充值订单仍需单独查询，暂不能发起新充值。', 'The server confirmed this order was not submitted and no payment was debited for it. Other orders must be checked separately before another payment can start.') : text('请查询这笔充值的原始结果。离开支付页面或返回应用不代表成功，也不代表已取消付款。', 'Check this original payment. Leaving checkout or returning to the app does not confirm success or cancellation.')}</Type></View>
    {order ? <><Type selectable size={36} weight="500">{money(order.credit_amount_minor_hkd, 'HKD')}</Type><DetailRow label={text('订单应付（CNY）', 'Order payable (CNY)')} value={money(order.pay_amount_minor_cny, 'CNY')} /><DetailRow label={text('订单编号', 'Order reference')} value={order.payment_id} /><DetailRow label={text('创建时间', 'Created')} value={new Date(order.created_at).toLocaleString()} />{order.checkout_detached ? <Type muted>{text('已解除支付页面关联 · 原订单继续核实', 'Checkout detached · Original order remains under review')}</Type> : null}</> : pending ? <Type muted>{text('已保存原请求。网络恢复后请查询，不要重新付款。', 'The original request is saved. Check it when connected; do not pay again.')}</Type> : null}
    {order && order.status === 'awaiting_payment' && !order.checkout_detached && !order.terminal && safeCheckout(order.checkout_url) && Date.parse(order.checkout_expires_at) > time + serverOffset ? <Action icon={ArrowUpRight} label={text('打开支付页面', 'Open checkout')} disabled={busy} onPress={onOpenCheckout} /> : null}
    <Action kind="secondary" label={busy ? text('正在核实', 'Checking') : text('查询原充值', 'Check original payment')} disabled={busy} onPress={onRefresh} />
    {order?.can_detach_checkout ? <Action kind="ghost" label={text('切换支付方式', 'Switch payment method')} disabled={busy} onPress={() => setDetachOpen(true)} /> : null}
    {order?.safe_to_start_new ? <Action label={text('完成', 'Done')} onPress={onBack} /> : null}
    {onOrders ? <Action kind="ghost" label={text('查看充值订单', 'View funding orders')} onPress={onOrders} /> : null}<ErrorNotice code={error} />
    <Sheet visible={detachOpen} title={text('切换支付方式？', 'Switch payment method?')} onClose={() => setDetachOpen(false)}><Type style={{ lineHeight: 24 }}>{text('旧支付页面将不可重新打开，但旧订单仍可能完成付款并入账。请勿重复支付；旧订单会保留在历史记录中。', 'The old checkout cannot be reopened, but its order may still complete and be credited. Do not pay twice. The old order stays in history.')}</Type><Action label={text('确认解除关联', 'Detach checkout')} disabled={busy || !order?.can_detach_checkout} onPress={() => { setDetachOpen(false); onDetach(); }} /><Action kind="secondary" label={text('保留当前订单', 'Keep order')} onPress={() => setDetachOpen(false)} /></Sheet>
  </Page>;
}
export function PaymentOrders({ state, onView, onRefresh, onMore, onSelect, onBack }: { state: FundingState['orders']; onView(view: 'pending' | 'history'): void; onRefresh(): void; onMore(): void; onSelect(order: PaymentOrder): void; onBack(): void }) {
  const { text, colors } = useDesign();
  return <Page title={text('充值订单', 'Funding orders')} action={<IconAction icon={ArrowLeft} label={text('返回钱包', 'Back to wallet')} onPress={onBack} />}><Tabs items={[{ id: 'pending', label: text('待处理', 'Pending') }, { id: 'history', label: text('历史记录', 'History') }]} value={state.view} onChange={view => { if (view === 'pending' || view === 'history') onView(view); }} /><Action kind="secondary" label={text('刷新订单', 'Refresh orders')} disabled={state.busy} onPress={onRefresh} />{state.busy ? <ActivityIndicator color={colors.accent} /> : null}{state.items.map(order => <Row key={order.payment_id} title={`${money(order.credit_amount_minor_hkd, 'HKD')} · ${paymentStatus(order.status, text)}`} subtitle={`${money(order.pay_amount_minor_cny, 'CNY')} CNY · ${new Date(order.created_at).toLocaleString()}`} onPress={() => onSelect(order)} />)}{!state.busy && !state.items.length ? <Type muted>{text('暂无充值订单', 'No funding orders yet')}</Type> : null}{state.cursor ? <Action kind="secondary" label={text('加载更多', 'Load more')} disabled={state.busy} onPress={onMore} /> : null}<ErrorNotice code={state.error} /></Page>;
}
export function WithdrawContact({ email, onBack }: { email?: string; onBack(): void }) {
  const { text, colors } = useDesign(); const configured = !!email && email.length <= 254 && /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
  const [failed, setFailed] = useState(false);
  return <Page title={text('申请提现', 'Request a withdrawal')} action={<IconAction icon={ArrowLeft} label={text('返回钱包', 'Back to wallet')} onPress={onBack} />}><ShieldCheck size={36} color={colors.accent} strokeWidth={1.4} /><Type size={22} weight="500">{text('联系客服核实提现安排', 'Contact support about withdrawal')}</Type><Type muted style={{ lineHeight: 24 }}>{configured ? text('请使用注册邮箱联系 Q。仅在客服确认接收方式后提供所需材料；发送邮件不代表提现已受理或完成。', 'Contact Q from your registered email. Provide requested documents only after support confirms the receiving process. Sending email does not confirm withdrawal acceptance or completion.') : text('Q 尚未配置提现联系方式。当前不提供自动提现，请稍后查看服务状态。', 'Q has not configured a withdrawal contact. Automatic withdrawals are unavailable. Check service availability later.')}</Type>{[text('法定姓名及 Q 账号', 'Legal name and Q account'), text('手机号（含国家/地区代码）', 'Phone number with country/region code'), text('提现金额及币种', 'Withdrawal amount and currency'), text('收款人、银行、开户地区及账号', 'Recipient, bank, account region and number'), text('客服要求的身份证明材料', 'Identity documents requested by support')].map(item => <Type key={item} size={14}>• {item}</Type>)}{configured ? <><Type selectable>{email}</Type><Action label={text('使用邮箱联系 Q', 'Email Q support')} onPress={() => { void Linking.openURL(`mailto:${email}?subject=${encodeURIComponent(text('Q 提现咨询', 'Q withdrawal enquiry'))}`).catch(() => setFailed(true)); }} /></> : null}{failed ? <Type color={colors.danger}>{text('无法打开邮件，请复制以上地址并从注册邮箱联系。', 'Mail could not be opened. Copy the address and contact us from your registered email.')}</Type> : null}</Page>;
}
