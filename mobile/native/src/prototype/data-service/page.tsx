import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Link2, Sparkles } from 'lucide-react-native';
import { Action, Choice, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import { requestMarketReport, marketErrorText } from '../market-data/client';
import type { MarketReport, MarketQuery } from '../market-data/core';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import {
  dataServices, dataServiceById, priceText, DATA_SERVICE_REVIEWED_ON, REAL_CHANNEL_CONNECTED,
  DEMO_LEDGER_NOTE_ZH, DEMO_LEDGER_NOTE_EN, SERVICE_DISCLAIMER_ZH, SERVICE_DISCLAIMER_EN, type Copy, type DataService,
} from './catalog';
import {
  createServiceLedger, chargeService, markDelivered, refundOrder, redeemProQaCredit, topUpDemoCredit,
  DEMO_INITIAL_TOPUP_MINOR_CNY, type ServiceLedger, type ServiceOrder,
} from './core';

const cryptoAssets = ['BTC', 'ETH', 'SOL'] as const;
const filingCompanies = [['AAPL', '苹果', 'Apple'], ['MSFT', '微软', 'Microsoft'], ['NVDA', '英伟达', 'NVIDIA']] as const;
const newsTopics = [['fed', '美联储', 'Federal Reserve'], ['markets', '金融市场', 'Markets'], ['crypto', '加密资产', 'Crypto'], ['technology', '科技', 'Technology']] as const;

function reportQuery(service: DataService, param: string): MarketQuery | null {
  if (!service.query) return null;
  if (service.query.kind === 'crypto' && (cryptoAssets as readonly string[]).includes(param)) return { kind: 'crypto', asset: param as (typeof cryptoAssets)[number] };
  if (service.query.kind === 'filings' && filingCompanies.some(([symbol]) => symbol === param)) return { kind: 'filings', company: param as 'AAPL' | 'MSFT' | 'NVDA' };
  if (service.query.kind === 'news' && newsTopics.some(([topic]) => topic === param)) return { kind: 'news', topic: param as 'fed' | 'markets' | 'crypto' | 'technology' };
  return service.query;
}
function paramChoices(service: DataService): { value: string; label: string }[] {
  if (service.query?.kind === 'crypto') return cryptoAssets.map(value => ({ value, label: value }));
  if (service.query?.kind === 'filings') return filingCompanies.map(([value, zh, en]) => ({ value, label: `${value} · ${zh}` }));
  if (service.query?.kind === 'news') return newsTopics.map(([value, zh]) => ({ value, label: zh }));
  return [];
}
function summarize(report: MarketReport, locale: 'zh' | 'en'): { headline: string; lines: string[] } {
  const zh = locale === 'zh';
  if (report.kind === 'crypto') {
    const record = report.records[0];
    return {
      headline: record ? `${record.name} · ${record.symbol}` : zh ? '快照已返回' : 'Snapshot returned',
      lines: record ? [
        `${zh ? '参考价' : 'Reference price'}: ${record.priceUsd === null ? '—' : `$${record.priceUsd}`}${record.change24hPct === null ? '' : ` (${record.change24hPct > 0 ? '+' : ''}${record.change24hPct}%)`}`,
        `${zh ? '源方更新' : 'Provider as of'}: ${record.asOf ?? '—'}`,
      ] : [],
    };
  }
  if (report.kind === 'filings') {
    const latest = report.records[0];
    return {
      headline: zh ? `返回 ${report.records.length} 条近期申报` : `${report.records.length} recent filings`,
      lines: latest ? [`${latest.form} · ${zh ? '公告日' : 'filed'} ${latest.filingDate}`, `${zh ? '文件编号' : 'Accession'}: ${latest.accessionNumber}`] : [],
    };
  }
  const themes = report.hotspots.map(item => `${item.topic} ×${item.count}`).join(' · ');
  return {
    headline: zh ? `样本 ${report.records.length} 条去重新闻` : `${report.records.length} deduplicated headlines`,
    lines: themes ? [`${zh ? '主题命中' : 'Themes'}: ${themes}`] : [],
  };
}

type Receipt = { order: ServiceOrder; headline: string; lines: string[]; refunded: boolean };

export function DataServicePage() {
  const { text, colors, locale } = useDesign();
  const zh = locale === 'zh';
  const [ledger, setLedger] = useState<ServiceLedger>(createServiceLedger);
  const [confirming, setConfirming] = useState<DataService | null>(null);
  const [param, setParam] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [deliveryError, setDeliveryError] = useState('');
  const openConfirm = (service: DataService) => {
    const choices = paramChoices(service);
    setParam(choices.length ? choices[0].value : '');
    setDeliveryError('');
    setConfirming(service);
  };
  const topUp = () => setLedger(state => topUpDemoCredit(state, DEMO_INITIAL_TOPUP_MINOR_CNY, new Date().toISOString(), randomUUID));
  const confirmPurchase = () => {
    const service = confirming;
    if (!service || busy) return;
    const charged = chargeService(ledger, service.id, new Date().toISOString(), randomUUID);
    if (!charged.ok) { setDeliveryError(charged.error === 'insufficient_balance' ? text('余额不足，请先领取演示额度。', 'Insufficient balance. Claim the demo credit first.') : text('暂时无法购买该服务。', 'This service cannot be purchased right now.')); return; }
    setBusy(true); setDeliveryError('');
    const finish = (next: ServiceLedger, receiptValue: Receipt) => { setLedger(next); setReceipt(receiptValue); setConfirming(null); setBusy(false); };
    if (!service.query) {
      const redeemed = redeemProQaCredit(charged.state);
      const delivered = markDelivered(redeemed.ok ? redeemed.state : charged.state, charged.order.id, zh ? '问答额度 +1' : 'Q&A credit +1');
      finish(delivered, { order: { ...charged.order, status: 'delivered' }, headline: text('问答额度已解锁', 'Q&A credit unlocked'), lines: [text('在对话中发起深度理财问题时消耗 1 次额度。', 'One credit is consumed when you ask a deep financial question in chat.')], refunded: false });
      return;
    }
    const query = reportQuery(service, param);
    void (async () => {
      if (!query) { finish(refundOrder(charged.state, charged.order.id, new Date().toISOString(), randomUUID), { order: charged.order, headline: text('查询参数无效，已全额退回', 'Invalid query parameters; fully refunded'), lines: [], refunded: true }); return; }
      try {
        const report = await requestMarketReport(query, { transport: expoFetch });
        const summary = summarize(report, locale);
        finish(markDelivered(charged.state, charged.order.id, summary.headline), { order: { ...charged.order, status: 'delivered' }, headline: summary.headline, lines: [...summary.lines, `${zh ? '来源' : 'Source'}: ${report.source.name}`], refunded: false });
      } catch (error) {
        const refunded = refundOrder(charged.state, charged.order.id, new Date().toISOString(), randomUUID);
        finish(refunded, { order: { ...charged.order, status: 'refunded' }, headline: text('交付失败，费用已全额退回', 'Delivery failed; the charge was fully refunded'), lines: [marketErrorText(error, locale)], refunded: true });
      }
    })();
  };
  const service = confirming;
  const choices = service ? paramChoices(service) : [];
  const afterBalance = service ? Math.max(0, ledger.balanceMinorCny - service.priceMinorCny) : 0;
  return <Page
    title={text('金融数据服务', 'Financial data service')}
    description={text('按次购买公开来源的市场数据与整理结果，付费即交付，失败自动退回。', 'Buy public-source market data per use. Delivery on payment; failed deliveries are refunded automatically.')}>
    <View style={{ gap: 12, padding: 20, borderRadius: 20, backgroundColor: colors.accentBg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Sparkles size={22} color={colors.accent} strokeWidth={1.6} />
        <Type size={13} muted>{text('演示数据余额', 'Demo data balance')}</Type>
      </View>
      <Type selectable size={36} weight="600" style={{ letterSpacing: -1 }}>{priceText(ledger.balanceMinorCny)}</Type>
      <Type size={12} muted>{zh ? DEMO_LEDGER_NOTE_ZH : DEMO_LEDGER_NOTE_EN}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Action kind="secondary" label={text('领取演示额度 ¥10.00', 'Claim demo credit ¥10.00')} onPress={topUp} />
        <Tag accent>{REAL_CHANNEL_CONNECTED ? text('真实按量通道', 'Real pay-per-use channel') : text('真实通道未接入', 'Real channel not connected')}</Tag>
        {ledger.proQaCredits > 0 ? <Tag>{text(`问答额度 ×${ledger.proQaCredits}`, `Q&A credits ×${ledger.proQaCredits}`)}</Tag> : null}
      </View>
    </View>
    <Type size={13} muted>{text('以下单价为每次调用的固定定价，来源与核对日期见各服务详情。', 'List prices below are per call. Sources and review dates appear in each service sheet.')}</Type>
    {dataServices.map(item => <View key={item.id} style={{ gap: 10, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <Type size={17} weight="600">{text(item.title[0], item.title[1])}</Type>
        <Type size={17} weight="600" color={colors.accent}>{priceText(item.priceMinorCny)}<Type size={12} muted>{text(' / 次', ' / use')}</Type></Type>
      </View>
      <Type size={14} muted>{text(item.summary[0], item.summary[1])}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Action label={item.id === 'pro-qa' ? text('购买问答额度', 'Buy Q&A credit') : text('立即查询', 'Query now')} onPress={() => openConfirm(item)} />
        {item.id === 'pro-qa' && ledger.proQaCredits > 0 ? <Tag accent>{text(`可用额度 ×${ledger.proQaCredits}`, `Available ×${ledger.proQaCredits}`)}</Tag> : null}
      </View>
    </View>)}
    <Type size={12} muted>{zh ? SERVICE_DISCLAIMER_ZH : SERVICE_DISCLAIMER_EN}</Type>
    {ledger.orders.length ? <View style={{ gap: 10 }}>
      <Type size={18} weight="600">{text('订单与用量', 'Orders and usage')}</Type>
      {ledger.orders.slice(0, 5).map(order => {
        const item = dataServiceById(order.serviceId);
        return <Row key={order.id} title={item ? text(item.title[0], item.title[1]) : order.serviceId}
          subtitle={`${priceText(order.priceMinorCny)} · ${order.status === 'delivered' ? text('已交付', 'Delivered') : order.status === 'refunded' ? text('已退回', 'Refunded') : text('交付中', 'Delivering')}${order.detail ? ` · ${order.detail}` : ''} · ${order.at.slice(11, 19)}`} last />;
      })}
      {ledger.events.slice(0, 6).map(event => {
        const item = dataServiceById(event.serviceId);
        return <Type key={event.id} size={12} muted selectable>{event.at.slice(0, 19).replace('T', ' ')} · {event.kind === 'topup' ? text('演示额度入账', 'Demo credit') : event.kind === 'refund' ? text('失败退回', 'Refund') : text('按次扣费', 'Per-use charge')} {event.deltaMinorCny > 0 ? '+' : ''}{priceText(event.deltaMinorCny)}{item ? ` · ${text(item.title[0], item.title[1])}` : ''}</Type>;
      })}
    </View> : null}
    <Sheet visible={!!service} title={service ? text(service.title[0], service.title[1]) : ''} onClose={() => { if (!busy) setConfirming(null); }}>
      {service ? <>
        <Type size={13} muted>{text(service.kind[0], service.kind[1])}</Type>
        <Type size={14}>{text(service.deliverable[0], service.deliverable[1])}</Type>
        {choices.length ? <View style={{ gap: 8 }}>
          <Type size={13} muted>{text('选择查询对象', 'Choose the query target')}</Type>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{choices.map(choice => <Choice key={choice.value} label={choice.label} selected={param === choice.value} onPress={() => setParam(choice.value)} />)}</View>
        </View> : null}
        <Row title={text('本次费用', 'Charge for this use')} subtitle={`${priceText(service.priceMinorCny)} · ${text('扣费后余额', 'Balance after')} ${priceText(afterBalance)}`} />
        <Row title={text('数据来源', 'Data source')} subtitle={`${service.sourceName} · ${text('核对', 'Reviewed')} ${DATA_SERVICE_REVIEWED_ON}`} last />
        <Type size={12} muted>{zh ? DEMO_LEDGER_NOTE_ZH : DEMO_LEDGER_NOTE_EN}</Type>
        {deliveryError ? <Type color={colors.danger} size={13}>{deliveryError}</Type> : null}
        <Action icon={busy ? undefined : Link2} label={busy ? text('正在交付…', 'Delivering…') : `${text('确认支付', 'Confirm payment')} ${priceText(service.priceMinorCny)}`} disabled={busy} onPress={confirmPurchase} />
        {busy ? <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在获取数据', 'Fetching data')} /> : null}
        <Type size={12} muted>{zh ? SERVICE_DISCLAIMER_ZH : SERVICE_DISCLAIMER_EN}</Type>
      </> : null}
    </Sheet>
    <Sheet visible={!!receipt} title={receipt?.refunded ? text('订单已退回', 'Order refunded') : text('交付完成', 'Delivery complete')} onClose={() => setReceipt(null)}>
      {receipt ? <>
        <Type size={17} weight="600">{receipt.headline}</Type>
        {receipt.lines.map((line, index) => <Type key={index} size={14} selectable>{line}</Type>)}
        <Row title={text('计量回执', 'Usage receipt')} subtitle={`${text('订单号', 'Order')} ${receipt.order.id.slice(0, 8)} · ${receipt.order.status === 'refunded' ? text('已全额退回', 'Fully refunded') : priceText(receipt.order.priceMinorCny)} · ${receipt.order.at.slice(0, 19).replace('T', ' ')}`} last />
        {receipt.refunded ? <Type size={13} muted>{text('本次读取失败未产生费用；扣费与退回两条分录均已记录，可在订单与用量中核对。', 'The failed read cost nothing. Charge and refund entries are both recorded under orders and usage.')}</Type> : null}
        <Type size={12} muted>{zh ? DEMO_LEDGER_NOTE_ZH : DEMO_LEDGER_NOTE_EN}</Type>
        <Action label={text('完成', 'Done')} onPress={() => setReceipt(null)} />
      </> : null}
    </Sheet>
  </Page>;
}
