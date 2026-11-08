import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';
import { ArrowUpRight, Eye, EyeOff, Sparkles } from 'lucide-react-native';
import { Action, Choice, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import {
  DEMO_NOTE, DEPOSIT_MV, DISCLAIMER, EQUITY_UNITS, FUND_MV, HOLD_COST, HOLD_MV, HOLD_PNL, holdings, marketFunds, fundCats,
  shelfItems, SIM_START_NAV, trustedExternalUrl, savingsGoal, marketMood, featuredProducts,
  type Copy, type FeaturedProduct, type MarketFund, type ShelfItem, type ShelfRiskGroup, type WealthHolding,
} from './catalog';
import {
  filterFunds, filterShelf, nextCandle, RISK_LABEL, seedCandles, sliceWindow, todayPct, todayPnl, windowBounds, type Candle,
} from './core';
import {
  insuranceTypes, groups as insuranceGroups, groupInsurers, trustedOutboundUrl as trustedInsuranceOutbound,
  regClasses, regSubLabels, formTags, sources as insuranceSources,
} from '../insurance/catalog';

type PageKey = 'overview' | 'perf' | 'holdings' | 'funds' | 'protection' | 'ai' | 'shelf' | 'settings';
const tabs: readonly { id: PageKey; title: Copy }[] = [
  { id: 'overview', title: ['总览', 'Overview'] }, { id: 'perf', title: ['收益风险', 'Risk & return'] },
  { id: 'holdings', title: ['持仓', 'Holdings'] }, { id: 'funds', title: ['基金', 'Funds'] },
  { id: 'protection', title: ['保障', 'Protection'] }, { id: 'ai', title: ['AI 助手', 'Assistant'] },
  { id: 'shelf', title: ['货架', 'Shelf'] }, { id: 'settings', title: ['设置', 'Settings'] },
];
const shelfRisks: readonly { id: ShelfRiskGroup | 'all'; title: Copy }[] = [
  { id: 'all', title: ['全部风险', 'All risk'] }, { id: 'stable', title: ['稳健 R1–R2', 'Stable'] },
  { id: 'balanced', title: ['平衡 R3', 'Balanced'] }, { id: 'aggressive', title: ['进取 R4–R5', 'Aggressive'] },
];
const shelfTerms: readonly { id: 'all' | 'live' | 'short' | 'long'; title: Copy }[] = [
  { id: 'all', title: ['全部期限', 'All terms'] }, { id: 'live', title: ['活期', 'Liquid'] }, { id: 'short', title: ['短期', 'Short'] }, { id: 'long', title: ['长期', 'Long'] },
];
const chartPeriods: readonly { id: string; title: Copy; count: number }[] = [
  { id: '1w', title: ['1周', '1W'], count: 8 },
  { id: '1m', title: ['1月', '1M'], count: 30 },
  { id: '3m', title: ['3月', '3M'], count: 66 },
  { id: '1y', title: ['1年', '1Y'], count: 120 },
];
const UP_RED = '#c73a3a', DOWN_GREEN = '#1e8a5e';
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = () => new Date().toTimeString().slice(0, 8);

function CandleChart({ candles, price, count = 26 }: { candles: Candle[]; price: number; count?: number }) {
  const { colors } = useDesign();
  const shown = sliceWindow(candles, count);
  const { min, max } = windowBounds(shown);
  const span = max - min || 1;
  const W = 280, H = 104, padT = 12, padB = 16;
  const y = (value: number) => padT + (max - value) / span * (H - padT - padB);
  const step = W / shown.length, bw = Math.max(3, step * 0.55);
  const lastY = y(price);
  return (
    <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} accessibilityRole="image" accessibilityLabel="组合基金部分净值K线，模拟行情实时更新">
      <Line x1={0} y1={lastY} x2={W} y2={lastY} stroke={colors.muted} strokeWidth={0.7} strokeDasharray="3 3" />
      {shown.map((candle, index) => {
        const cx = index * step + step / 2;
        const bullish = candle.c >= candle.o;
        const color = bullish ? '#c73a3a' : '#1e8a5e';
        const yO = y(candle.o), yC = y(candle.c);
        const top = Math.min(yO, yC), height = Math.max(1.2, Math.abs(yO - yC));
        return (
          <G key={index}>
            <Line x1={cx} y1={y(candle.h)} x2={cx} y2={y(candle.l)} stroke={color} strokeWidth={1} />
            <Rect x={cx - bw / 2} y={top} width={bw} height={height} fill={color} />
          </G>
        );
      })}
      <SvgText x={W - 2} y={Math.max(11, lastY - 4)} textAnchor="end" fontSize={10} fontWeight={600} fill={colors.ink}>{price.toFixed(4)}</SvgText>
    </Svg>
  );
}

export function WealthCenterPage({ onOpenDataService, onOpenChat }: { onOpenDataService?: () => void; onOpenChat?: () => void }) {
  const { text, colors } = useDesign();
  const [page, setPage] = useState<PageKey>('overview');
  const initMarket = () => {
    const seeded = seedCandles(120, SIM_START_NAV);
    return { candles: seeded.candles, price: seeded.price, dayOpen: seeded.candles[Math.max(0, seeded.candles.length - 30)].o };
  };
  const market = useRef<ReturnType<typeof initMarket> | null>(null);
  if (!market.current) market.current = initMarket();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const state = market.current!;
      const step = nextCandle(state.price);
      state.candles.push(step.candle);
      if (state.candles.length > 160) state.candles.shift();
      state.price = step.price;
      const active = detailRef.current;
      if (active) {
        const series = detailMarket.current[active.name];
        if (series) {
          const detailStep = nextCandle(series.price);
          series.candles.push(detailStep.candle);
          if (series.candles.length > 120) series.candles.shift();
          series.price = detailStep.price;
        }
      }
      setTick(value => value + 1);
    }, 1600);
    return () => clearInterval(timer);
  }, []);
  const price = market.current!.price;
  const dayOpen = market.current!.dayOpen;
  const pct = todayPct(price, dayOpen);
  const pnl = todayPnl(price, dayOpen);
  const totalNow = HOLD_MV + pnl;
  const [fundCat, setFundCat] = useState<'all' | MarketFund['cat']>('all');
  const [shelfRisk, setShelfRisk] = useState<ShelfRiskGroup | 'all'>('all');
  const [shelfTerm, setShelfTerm] = useState<'all' | 'live' | 'short' | 'long'>('all');
  const [aiLog, setAiLog] = useState<[string, string][]>([]);
  const [outbound, setOutbound] = useState<{ title: string; url: string } | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [riskSheet, setRiskSheet] = useState(false);
  const [expandedInsurance, setExpandedInsurance] = useState<string | null>(null);
  const [switches, setSwitches] = useState({ advisory: true, market: true, usage: false });
  const [hideAssets, setHideAssets] = useState(false);
  const [chartPeriod, setChartPeriod] = useState('1m');
  const [detail, setDetail] = useState<FeaturedProduct | null>(null);
  const detailRef = useRef<FeaturedProduct | null>(null);
  detailRef.current = detail;
  const detailMarket = useRef<Record<string, { candles: Candle[]; price: number }>>({});
  const openDetail = (item: FeaturedProduct) => {
    if (!detailMarket.current[item.name]) {
      const seeded = seedCandles(40, item.simStart ?? SIM_START_NAV);
      detailMarket.current[item.name] = { candles: seeded.candles, price: seeded.price };
    }
    setDetail(item);
  };
  const allowedUrls = useMemo(() => [
    ...holdings.map(item => item.official).filter((url): url is string => Boolean(url)),
    ...marketFunds.map(fund => `https://${fund.host}`),
    ...featuredProducts.map(item => item.official).filter((url): url is string => Boolean(url)),
    ...insuranceSources.map(source => source.url),
    ...Object.values(groupInsurers).flat().map(ref => ref.url),
  ], []);
  const openOutbound = async () => {
    if (!outbound || !(trustedExternalUrl(outbound.url, allowedUrls) || trustedInsuranceOutbound(outbound.url))) { setLinkError(true); return; }
    try { await Linking.openURL(outbound.url); setOutbound(null); }
    catch { setLinkError(true); }
  };
  const gotoOutbound = (title: string, url: string) => { setLinkError(false); setOutbound({ title, url }); };
  const aiAnswer = (question: string): string => {
    if (/风险/.test(question)) return text('当前组合以 R1–R2 资产为主（货币类约占一半），整体风险等级约 R2（中低）。近一年最大回撤 -0.8%，波动较低。', 'The portfolio is dominated by R1–R2 assets; overall risk is about R2 (low-medium) with a -0.8% max drawdown over the past year.');
    if (/收益|怎么样/.test(question)) return text(`近 30 日收益 +¥1,086.75；今日权益部分收益 ${pnl >= 0 ? '+' : ''}${money(pnl)}（实时模拟）。`, `Last 30 days +¥1,086.75; today's equity P&L is ${pnl >= 0 ? '+' : ''}${money(pnl)} (simulated, live).`);
    if (/到期/.test(question)) return text('3 个月定存（演示）¥35,000 将于 2027-02-14 到期，其余持仓为活期或开放式，无近期到期安排。', 'The demo 3-month deposit (¥35,000) matures on 2027-02-14; other holdings are liquid or open-ended.');
    if (/四笔钱|分配|怎么分/.test(question)) return text('一般性框架：活钱管流动性（货币类）、稳健理财打底（短债/存款）、长期投资追求增长（均衡类）、保险保障兜底风险。你的当前分布可看总览页的持仓速览与分布数据；该框架仅为公开知识整理，不构成投资建议。', 'A common framework: liquid cash for liquidity, stable assets as the base, long-term funds for growth, and insurance as protection. See the mix on the overview. Public knowledge only — not investment advice.');
    if (/保障|保险/.test(question)) return text('保障是第四笔钱。建议先在「保障」页按方向核对目录（重疾/医疗/意外是常用自查起点），再前往承保公司官方渠道投保；小Q不代办投保、不收款，以下内容不构成投保建议。', 'Protection is the fourth pocket. Start by verifying the catalogue on the Protection tab (critical illness, medical and accident are common starting points), then apply on insurers\' official channels. Q places no applications; this is not insurance advice.');
    if (/配|稳/.test(question)) return text('一般性信息：货币类流动性好、收益较低；债券类波动略高。稳健组合通常以货币与短债为基础。具体配置需结合你的目标与风险承受能力，不构成投资建议。', 'General information only: money-market assets trade liquidity for yield, bond funds add some volatility. Stable portfolios usually build on cash and short-duration bonds. This is not investment advice.');
    if (/回撤/.test(question)) return text('最大回撤是区间内从最高点到其后最低点的最大跌幅，用于衡量下行风险。你的组合近一年最大回撤为 -0.8%（模拟数据）。', 'Max drawdown is the largest peak-to-trough decline in a period, measuring downside risk. Your portfolio shows -0.8% over the past year (simulated).');
    return text('（演示）正式版本将接入小Q对话能力，基于模拟账本与公开知识作答，不构成投资建议。', '(Demo) The full version will connect Q chat, answering from the demo ledger and public knowledge. Not investment advice.');
  };
  const ask = (question: string) => { if (question.trim()) setAiLog(current => [...current, [question.trim(), aiAnswer(question.trim())] as [string, string]].slice(-8)); };

  const chartCount = chartPeriods.find(item => item.id === chartPeriod)!.count;
  const periodFirst = market.current!.candles.slice(-chartCount)[0]?.o ?? price;
  const periodChange = periodFirst > 0 ? (price / periodFirst - 1) * 100 : 0;
  const quickEntries: { key: string; icon: string; title: Copy; onPress: () => void }[] = [
    { key: 'cash', icon: '💰', title: ['现金宝', 'Cash'], onPress: () => openDetail(featuredProducts[0]) },
    { key: 'funds', icon: '📈', title: ['基金', 'Funds'], onPress: () => setPage('funds') },
    { key: 'term', icon: '🏦', title: ['定期理财', 'Term'], onPress: () => setPage('shelf') },
    { key: 'protect', icon: '🛡', title: ['保障', 'Protect'], onPress: () => setPage('protection') },
    { key: 'data', icon: '📊', title: ['行情数据', 'Data'], onPress: () => { if (onOpenDataService) onOpenDataService(); } },
    { key: 'ai', icon: '🤖', title: ['小Q助手', 'Assistant'], onPress: () => setPage('ai') },
    { key: 'perf', icon: '🧭', title: ['收益风险', 'Risk'], onPress: () => setPage('perf') },
    { key: 'hold', icon: '📋', title: ['持仓', 'Holdings'], onPress: () => setPage('holdings') },
  ];
  const productCard = (item: FeaturedProduct) => (
    <Pressable key={item.name} accessibilityRole="button"
      accessibilityLabel={text(`${item.name}，近一年业绩基准 ${item.bench}，查看走势与数据`, `${item.name}, 1Y benchmark ${item.bench}, view trend and data`)}
      onPress={() => openDetail(item)}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Type weight="600" size={14}>{item.name}</Type>
          {item.code !== '—' ? <Tag>{item.code}</Tag> : null}
          <Tag accent={item.risk === 'R1' || item.risk === 'R2'}>{RISK_LABEL[item.risk]}</Tag>
        </View>
        <Type size={11} muted>{item.org} · {item.term} · {text('起投', 'From')} {item.min}{item.official ? '' : text(' · 示例类别', ' · demo')}</Type>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Type selectable weight="600" size={17} style={{ color: /%/.test(item.bench) ? UP_RED : colors.ink }}>{item.bench}</Type>
        <Type size={10} muted>{text('近一年业绩基准 · 点看走势', '1Y benchmark · tap for trend')}</Type>
      </View>
    </Pressable>
  );
  const detailView = () => {
    const item = detail!;
    const series = detailMarket.current[item.name];
    const detailPrice = series?.price ?? item.simStart ?? SIM_START_NAV;
    const detailCandles = series?.candles ?? [];
    const window = sliceWindow(detailCandles, 30);
    const first = window[0]?.o ?? detailPrice;
    const detailChange = first > 0 ? (detailPrice / first - 1) * 100 : 0;
    return <>
      <Action kind="ghost" label={text('← 返回', '← Back')} onPress={() => setDetail(null)} />
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Type size={20} weight="600">{item.name}</Type>
          <Tag accent={item.risk === 'R1' || item.risk === 'R2'}>{RISK_LABEL[item.risk]}</Tag>
          {item.code !== '—' ? <Tag>{item.code}</Tag> : null}
        </View>
        <Type size={12} muted selectable>{item.org} · {item.term} · {text('起投', 'From')} {item.min} · {text('公开资料核对', 'Reviewed')} 2026-11-05</Type>
      </View>
      <View style={{ gap: 8, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Type weight="600" size={14}>{text('净值走势 · 实时（模拟）', 'NAV candles · live (demo)')}</Type>
          <Type size={10} muted>{clock()}</Type>
        </View>
        <CandleChart candles={detailCandles} price={detailPrice} count={30} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
          <View><Type size={11} muted>{text('当前净值', 'NAV')}</Type><Type selectable weight="600">{detailPrice.toFixed(4)}</Type></View>
          <View><Type size={11} muted>{text('区间涨跌', 'Period change')}</Type><Type selectable weight="600" style={{ color: detailChange >= 0 ? UP_RED : DOWN_GREEN }}>{detailChange >= 0 ? '+' : ''}{detailChange.toFixed(2)}%</Type></View>
          <View><Type size={11} muted>{text('近一年业绩基准', '1Y benchmark')}</Type><Type selectable weight="600" style={{ color: UP_RED }}>{item.bench}</Type></View>
          <Type size={10} muted>{text('基准非承诺收益 · 红涨绿跌', 'Benchmark is not a promise · red up, green down')}</Type>
        </View>
      </View>
      <View style={{ gap: 8, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <View><Type size={11} muted>{text('管理人 / 类别', 'Manager')}</Type><Type selectable weight="500">{item.org}</Type></View>
          <View><Type size={11} muted>{text('期限', 'Term')}</Type><Type selectable weight="500">{item.term}</Type></View>
          <View><Type size={11} muted>{text('起投', 'Minimum')}</Type><Type selectable weight="500">{item.min}</Type></View>
        </View>
        {item.official
          ? <Action icon={ArrowUpRight} label={text(`前往${item.org}官方申购入口`, `${item.org} official subscription entry`)} onPress={() => gotoOutbound(item.org, item.official!)} />
          : <Type size={12} muted>{text('示例类别，用于流程演示；实际投资请通过持牌销售机构办理。', 'Demo category; invest via licensed distributors.')}</Type>}
      </View>
      <Type size={12} muted>{text('走势为模拟数据，仅展示页面能力；业绩基准非承诺收益。申购在管理人直销或持牌销售机构完成，小Q不代销、不代收款。', 'The trend is simulated to demonstrate the page; benchmarks are not promised returns. Subscriptions happen via the manager or licensed distributors; Q neither distributes funds nor collects payments.')}</Type>
    </>;
  };
  const overview = () => <>
    <View style={{ gap: 12, padding: 20, borderRadius: 20, backgroundColor: colors.accentBg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Sparkles size={20} color={colors.accent} strokeWidth={1.6} /><Type size={13} muted>{text('总资产（模拟）', 'Total assets (demo)')}</Type></View>
        <Pressable accessibilityRole="button" accessibilityLabel={text('隐藏或显示资产', 'Toggle asset visibility')} onPress={() => setHideAssets(value => !value)} style={{ padding: 6 }}>
          {hideAssets ? <EyeOff size={18} color={colors.accent} /> : <Eye size={18} color={colors.accent} />}
        </Pressable>
      </View>
      <Type selectable size={34} weight="600" style={{ letterSpacing: -1 }}>{hideAssets ? '¥ ✽✽✽,✽✽✽.✽✽' : money(totalNow)}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 22 }}>
        <View><Type size={11} muted>{text('今日盈亏', "Today's P&L")}</Type><Type selectable weight="600" style={{ color: pnl >= 0 ? UP_RED : DOWN_GREEN }}>{hideAssets ? '✽✽✽' : `${pnl >= 0 ? '+' : ''}${money(pnl)}`}</Type></View>
        <View><Type size={11} muted>{text('累计收益', 'Cumulative')}</Type><Type selectable weight="600" style={{ color: UP_RED }}>{hideAssets ? '✽✽✽' : `+${money(HOLD_PNL + 3281.53)}`}</Type></View>
        <View><Type size={11} muted>{text('持仓数', 'Positions')}</Type><Type weight="600">{holdings.length}</Type></View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Tag accent>{text(`市场温度 ${marketMood.temperature}° · ${marketMood.label[0]}`, `Mood ${marketMood.temperature}° · ${marketMood.label[1]}`)}</Tag>
        <Tag>{text(savingsGoal.title[0], savingsGoal.title[1])} {Math.round(savingsGoal.progress * 100)}%</Tag>
        <Tag>{text('模拟账本', 'Demo ledger')}</Tag>
      </View>
      <Type size={11} muted>{text(`统计口径：市值按最新净值/本金估算。实时更新于 ${clock()}。`, `Market value follows the latest estimates. Live at ${clock()}.`)}</Type>
    </View>
    <View style={{ gap: 8, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Type weight="600" size={14}>{text('组合净值 · 实时', 'Portfolio NAV · live')}</Type>
        <Type size={10} muted>{text('标的：基金部分 · 红涨绿跌', 'Fund part · red up, green down')}</Type>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {chartPeriods.map(item => <Choice key={item.id} label={text(item.title[0], item.title[1])} selected={chartPeriod === item.id} onPress={() => setChartPeriod(item.id)} />)}
      </View>
      <CandleChart candles={market.current!.candles} price={price} count={chartCount} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
        <View><Type size={11} muted>{text('当前净值', 'NAV')}</Type><Type selectable weight="600">{price.toFixed(4)}</Type></View>
        <View><Type size={11} muted>{text('今日涨跌', 'Change today')}</Type><Type selectable weight="600" style={{ color: pct >= 0 ? UP_RED : DOWN_GREEN }}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</Type></View>
        <View><Type size={11} muted>{text(`${chartPeriods.find(item => item.id === chartPeriod)!.title[0]}涨跌`, 'Period change')}</Type><Type selectable weight="600" style={{ color: periodChange >= 0 ? UP_RED : DOWN_GREEN }}>{periodChange >= 0 ? '+' : ''}{periodChange.toFixed(2)}%</Type></View>
      </View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {quickEntries.map(entry => (
        <Pressable key={entry.key} accessibilityRole="button" accessibilityLabel={text(entry.title[0], entry.title[1])} onPress={entry.onPress}
          style={({ pressed }) => ({ flexGrow: 1, flexBasis: '23%', minWidth: 72, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.soft, opacity: pressed ? 0.7 : 1 })}>
          <Type size={17}>{entry.icon}</Type>
          <Type size={11}>{text(entry.title[0], entry.title[1])}</Type>
        </Pressable>
      ))}
    </View>
    <View style={{ gap: 6, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <View><Type size={11} muted>{text('持有金额', 'Held')}</Type><Type selectable weight="600">{hideAssets ? '✽✽✽' : money(HOLD_MV)}</Type></View>
        <View><Type size={11} muted>{text('持仓收益', 'Holding P&L')}</Type><Type selectable weight="600" style={{ color: HOLD_PNL >= 0 ? UP_RED : DOWN_GREEN }}>{hideAssets ? '✽✽✽' : `+${money(HOLD_PNL)}`}</Type></View>
        <View><Type size={11} muted>{text('四笔钱分布', 'Mix')}</Type><Type selectable weight="600">{text(`基金 ${(((FUND_MV + pnl) / (HOLD_MV + pnl)) * 100).toFixed(0)}% · 存款 ${((DEPOSIT_MV / (HOLD_MV + pnl)) * 100).toFixed(0)}%`, 'Funds / deposits')}</Type></View>
      </View>
      <Action kind="ghost" label={text('查看全部持仓 →', 'All holdings →')} onPress={() => setPage('holdings')} />
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Tag accent>{text('风险匹配 ✓ R2=R2', 'Risk match ✓ R2=R2')}</Tag>
      <Tag>{text('集中度合理 · 最高货币类 28.6%', 'Concentration ok · top money 28.6%')}</Tag>
      <Tag>{text('⏰ 定存 2027-02-14 到期', 'Deposit matures 2027-02-14')}</Tag>
    </View>
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Type weight="600" size={15}>{text('稳健理财', 'Stable picks')}</Type>
        <Type size={11} muted>{text('示例与公开资料 · 非推荐', 'Demo & public info · not advice')}</Type>
      </View>
      {featuredProducts.filter(item => item.cat === 'stable').map(productCard)}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
        <Type weight="600" size={15}>{text('进阶理财', 'Growth picks')}</Type>
        <Type size={11} muted>{text('波动换空间 · R3+', 'Higher volatility · R3+')}</Type>
      </View>
      {featuredProducts.filter(item => item.cat === 'growth').map(productCard)}
    </View>
    {onOpenDataService ? <Action kind="secondary" label={text('按次购买金融数据服务', 'Pay-per-use data service')} onPress={onOpenDataService} /> : null}
    <Type size={12} muted>{text(DEMO_NOTE[0], DEMO_NOTE[1])}</Type>
  </>;
  const perf = () => <>
    <View style={{ padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Type weight="600">{text('我的组合 · 基金部分 · 净值K线', 'Portfolio funds · NAV candles')}</Type>
        <Type size={10} muted>{clock()}</Type>
      </View>
      <Type size={11} muted selectable>{text('标的：持仓中的基金部分（易方达 000009 · 华夏 003003 · 稳健短债示例 · 均衡混合示例，约 ¥105,990）· 模拟行情 · 每根约 1 分钟 · 虚线 = 当前净值', 'Underlying: the fund part of your holdings (E Fund 000009, ChinaAMC 003003 and demo entries, about ¥105,990). Simulated ticks, one candle ≈ 1 minute; dashed line = current NAV.')}</Type>
      <CandleChart candles={market.current!.candles} price={price} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 20 }}>
        <View><Type size={11} muted>{text('当前净值', 'Current NAV')}</Type><Type selectable weight="600">{price.toFixed(4)}</Type></View>
        <View><Type size={11} muted>{text('今日涨跌', "Today's change")}</Type><Type selectable weight="600" color={pct >= 0 ? colors.ink : colors.danger}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</Type></View>
        <View><Type size={11} muted>{text('今日收益（权益）', "Today's P&L")}</Type><Type selectable weight="600" color={pnl >= 0 ? colors.ink : colors.danger}>{pnl >= 0 ? '+' : ''}{money(pnl)}</Type></View>
      </View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 22 }}>
      <View><Type size={11} muted>{text('累计收益', 'Cumulative')}</Type><Type selectable weight="600">{money(HOLD_PNL + 3281.53)}</Type></View>
      <View><Type size={11} muted>{text('近 7 日', 'Last 7 days')}</Type><Type selectable weight="600">+¥312.40</Type></View>
      <View><Type size={11} muted>{text('近 30 日', 'Last 30 days')}</Type><Type selectable weight="600">+¥1,086.75</Type></View>
      <View><Type size={11} muted>{text('年化收益率', 'Annualized')}</Type><Type selectable weight="600">3.12%</Type></View>
      <View><Type size={11} muted>{text('波动率', 'Volatility')}</Type><Type selectable weight="600">2.1%</Type></View>
      <View><Type size={11} muted>{text('最大回撤', 'Max drawdown')}</Type><Type selectable weight="600" color={colors.danger}>-0.8%</Type></View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}><Tag accent>{RISK_LABEL.R2}</Tag><Tag>{text('组合整体风险', 'Portfolio risk')}</Tag></View>
    <Type size={12} muted>{text('历史收益与年化数据为模拟演示，不代表未来表现；年化收益率非承诺收益。风险等级参考产品分类（R1 最低 – R5 最高）。', 'Simulated history; annualized figures are not promised returns. Risk levels follow product classifications (R1 lowest – R5 highest).')}</Type>
  </>;
  const holdingsView = () => <>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
      <Type weight="600">{text(`持仓 ${holdings.length} 笔`, `${holdings.length} positions`)}</Type>
      <Type muted>{text(`市值 ${money(HOLD_MV)} · 成本 ${money(HOLD_COST)}`, `MV ${money(HOLD_MV)} · cost ${money(HOLD_COST)}`)}</Type>
    </View>
    {holdings.map((item: WealthHolding) => <View key={item.id} style={{ gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Type weight="600">{item.name}</Type>
        <Tag accent={item.risk === 'R1' || item.risk === 'R2'}>{RISK_LABEL[item.risk]}</Tag>
      </View>
      <Type size={12} muted>{text(item.type[0], item.type[1])} · {item.code} · {text(`占比 ${(item.mv / HOLD_MV * 100).toFixed(1)}%`, `${(item.mv / HOLD_MV * 100).toFixed(1)}% of book`)} · {item.term}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 20 }}>
        <View><Type size={11} muted>{text('持有金额', 'Held')}</Type><Type selectable weight="500">{money(item.hold)}</Type></View>
        <View><Type size={11} muted>{text('当前市值', 'Market value')}</Type><Type selectable weight="500">{money(item.mv)}</Type></View>
        <View><Type size={11} muted>{text('收益', 'P&L')}</Type><Type selectable weight="500">{item.pnl > 0 ? '+' : ''}{money(item.pnl)}</Type></View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Tag>{text(item.status[0], item.status[1])}</Tag>
        {item.official ? <Action kind="ghost" icon={ArrowUpRight} label={text('官方办理入口', 'Official channel')} onPress={() => gotoOutbound(item.name, item.official!)} /> : <Tag>{text('示例条目 · 官方渠道办理', 'Demo entry · invest via official channels')}</Tag>}
      </View>
    </View>)}
    <Type size={12} muted>{text('持仓为模拟账本演示。申购、赎回与存款支取在基金管理人直销、持牌销售机构或银行官方渠道完成；小Q不代办交易、不代收款。', 'Holdings are demo ledger entries. Transactions happen via fund managers, licensed distributors or banks; Q places no orders or payments.')}</Type>
  </>;
  const funds = () => <>
    <Type size={12} muted>{text('主流基金公开资料列举，排名不分先后、不构成推荐；风险等级为参考分类，收益特征以产品法律文件为准。', 'Public listings of mainstream funds, unordered and not recommendations. Risk levels are reference classifications; terms govern.')}</Type>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{fundCats.map(cat => <Choice key={cat.id} label={text(cat.title[0], cat.title[1])} selected={fundCat === cat.id} onPress={() => setFundCat(cat.id)} />)}</View>
    <Type size={12} muted>{text(`${filterFunds(marketFunds, fundCat).length} 只 · 公开资料`, `${filterFunds(marketFunds, fundCat).length} funds · public disclosures`)}</Type>
    {filterFunds(marketFunds, fundCat).map(fund => <View key={fund.code} style={{ gap: 7, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Type weight="600">{fund.name}</Type>
        <Tag accent={fund.risk === 'R1' || fund.risk === 'R2'}>{RISK_LABEL[fund.risk]}</Tag>
      </View>
      <Type size={12} muted selectable>{fund.code} · {text(fund.type[0], fund.type[1])} · {fund.org}</Type>
      <Type size={12}>{fund.feat}</Type>
      <Action kind="ghost" icon={ArrowUpRight} label={text('官方申购入口', 'Official subscription entry')} onPress={() => gotoOutbound(fund.org, `https://${fund.host}`)} />
    </View>)}
    <Type size={12} muted>{text('开户、申购与赎回在基金管理人官方直销渠道或持牌销售机构完成；小Q不代销基金、不代收款。基金投资有风险，历史业绩不代表未来表现。', 'Subscriptions happen via the manager or licensed distributors; Q does not distribute funds or collect payments. Funds involve risk; past performance does not predict future results.')}</Type>
  </>;
  const ai = () => <>
    <View style={{ gap: 10 }}>
      {aiLog.length ? aiLog.map(([question, answer], index) => <View key={index} style={{ gap: 6 }}>
        <View style={{ alignSelf: 'flex-end', backgroundColor: colors.accentBg, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, maxWidth: '88%' }}><Type size={13}>{question}</Type></View>
        <View style={{ alignSelf: 'flex-start', backgroundColor: colors.soft, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, maxWidth: '92%' }}><Type size={13} selectable>{answer}</Type></View>
      </View>) : <Type muted>{text('选择下面的问题开始；回答基于模拟账本与公开知识整理。', 'Pick a question below; answers come from the demo ledger and public knowledge.')}</Type>}
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[[text('我的组合风险有多高？', 'How risky is my portfolio?'), text('当前组合以 R1–R2 资产为主（货币类约占一半），整体风险等级约 R2（中低）。近一年最大回撤 -0.8%，波动较低。', 'Dominated by R1–R2 assets; overall about R2 (low-medium), max drawdown -0.8% over the past year.')],
      [text('这个月收益怎么样？', 'How are returns this month?'), text(`近 30 日收益 +¥1,086.75；今日权益部分收益 ${pnl >= 0 ? '+' : ''}${money(pnl)}（实时模拟）。`, `Last 30 days +¥1,086.75; today ${pnl >= 0 ? '+' : ''}${money(pnl)} (simulated, live).`)],
      [text('哪笔快到期？', 'What matures soon?'), text('3 个月定存（演示）¥35,000 将于 2027-02-14 到期，其余持仓为活期或开放式，无近期到期安排。', 'The demo deposit (¥35,000) matures 2027-02-14; others are liquid or open-ended.')],
      [text('四笔钱怎么分？', 'How to split the four pockets?'), text('一般性框架：活钱管流动性（货币类）、稳健理财打底（短债/存款）、长期投资追求增长（均衡类）、保险保障兜底风险。当前分布见总览页四笔钱卡片；公开知识整理，不构成投资建议。', 'A common framework: liquidity, stable base, long-term growth, insurance protection. See the overview cards. Public knowledge only — not investment advice.')],
      [text('我的保障够吗？', 'Is my protection enough?'), text('保障是第四笔钱。先在「保障」页按方向核对目录（重疾/医疗/意外是常用自查起点），再前往承保公司官方渠道投保；小Q不代办投保，以下内容不构成投保建议。', 'Protection is the fourth pocket. Verify the catalogue on the Protection tab first, then apply on insurers\' official channels. Not insurance advice.')],
      [text('存款和基金怎么配更稳？', 'How to allocate more steadily?'), text('一般性信息：货币类流动性好、收益较低；债券类波动略高。稳健组合通常以货币与短债为基础。具体配置需结合你的目标与风险承受能力，不构成投资建议。', 'General information only. Not investment advice.')]].map(([question, answer], index) => <Choice key={index} label={question} selected={false} onPress={() => setAiLog(current => [...current, [question, answer] as [string, string]].slice(-8))} />)}
    </View>
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Choice label={text('什么是最大回撤？', 'What is max drawdown?')} selected={false} onPress={() => setAiLog(current => [...current, [text('什么是最大回撤？', 'What is max drawdown?'), text('最大回撤是区间内从最高点到其后最低点的最大跌幅，用于衡量下行风险。你的组合近一年最大回撤为 -0.8%（模拟数据）。', 'The largest peak-to-trough decline in a period. Your portfolio: -0.8% over the past year (simulated).')] as [string, string]].slice(-8))} />
      {onOpenChat ? <Action kind="secondary" label={text('在主对话中提问', 'Ask in main chat')} onPress={onOpenChat} /> : null}
    </View>
    <Type size={12} muted>{text('AI 回答为公开知识与模拟数据的信息整理，不构成投资建议；交易类操作不在对话中执行。', 'Answers summarize public knowledge and demo data; not investment advice. No trades execute in chat.')}</Type>
  </>;
  const shelf = () => <>
    <View style={{ gap: 8 }}>
      <Type size={12} muted>{text('按风险与期限筛选示例类别；业绩基准不是承诺收益。', 'Filter demo categories by risk and term. Benchmarks are not promised returns.')}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{shelfRisks.map(item => <Choice key={item.id} label={text(item.title[0], item.title[1])} selected={shelfRisk === item.id} onPress={() => setShelfRisk(item.id)} />)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{shelfTerms.map(item => <Choice key={item.id} label={text(item.title[0], item.title[1])} selected={shelfTerm === item.id} onPress={() => setShelfTerm(item.id)} />)}</View>
    </View>
    <Type size={12} muted>{text(`${filterShelf(shelfItems, shelfRisk, shelfTerm).length} 项 · 示例类别，非推荐`, `${filterShelf(shelfItems, shelfRisk, shelfTerm).length} items · demo categories, not recommendations`)}</Type>
    {filterShelf(shelfItems, shelfRisk, shelfTerm).map((item: ShelfItem) => <View key={item.name} style={{ gap: 6, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Type weight="600">{item.name}</Type>
        <Tag accent={item.risk === 'R1' || item.risk === 'R2'}>{RISK_LABEL[item.risk]}</Tag>
      </View>
      <Type size={12} muted selectable>{item.bench}</Type>
      <Type size={12} muted>{text(`起投 ${item.min} · ${item.term}`, `From ${item.min} · ${item.term}`)}</Type>
    </View>)}
    <Type size={12} muted>{text('货架为公开产品类别的示例展示，不构成推荐或个性化排序；实际投资在持牌销售机构办理，R4/R5 需先完成正式风险测评。', 'Demo categories only. Invest via licensed distributors; R4/R5 require a formal risk assessment first.')}</Type>
  </>;
  const settings = () => <>
    <Row title={text('银行卡', 'Bank cards')} subtitle={text('模拟银行卡 ×3；演示资金与理财模拟账本分开管理。港币钱包（真实）充值通道未接通，与模拟账本隔离。', '3 demo cards; demo funds stay separate from the wealth ledger. The real HKD wallet top-up is not connected.')} />
    <Row title={text('适当性自我评估', 'Suitability self-assessment')} subtitle={text('当前自评 R2 · 中低。自评结果不构成适当性匹配结论，正式测评由持牌机构完成。', 'Self-assessed R2. This is not a suitability conclusion; formal assessments happen at licensed firms.')} onPress={() => setRiskSheet(true)} />
    <Row title={text('高风险产品可见性', 'High-risk visibility')} subtitle={text('开启后货架显示 R4–R5 示例；购买前仍需完成正式风险测评。', 'Show R4–R5 demo entries; a formal assessment is still required before purchase.')} onPress={() => setSwitches(current => ({ ...current, advisory: !current.advisory }))} last />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <Tag accent={switches.advisory}>{switches.advisory ? text('R4–R5 可见', 'Visible') : text('R4–R5 已隐藏', 'Hidden')}</Tag>
    </View>
    <Row title={text('数据授权 · 公开行情', 'Data · public quotes')} subtitle={text('币种快照、公司公告等按次查询所需。', 'Needed for per-use quotes and filings.')} onPress={() => setSwitches(current => ({ ...current, market: !current.market }))} />
    <Row title={text('数据授权 · 用量统计', 'Data · usage stats')} subtitle={text('按量付费订单与用量事件的统计汇总。', 'Aggregate stats for pay-per-use orders.')} onPress={() => setSwitches(current => ({ ...current, usage: !current.usage }))} last />
    <Type size={12} muted>{text('本页均为演示状态标注。真实数据授权与适当性评估以持牌机构流程为准。', 'All states here are demo annotations; real authorizations follow licensed processes.')}</Type>
  </>;
  const protection = () => <>
    <Type size={12} muted>{text('第四笔钱 · 保障规划视图：以下为保险目录镜像（43 类入口，双口径）。投保前逐条核对，投保申请在承保公司官方渠道完成；小Q不代办投保、不报价、不收款。', 'The fourth pocket: a planning mirror of the insurance catalogue (43 entries, dual taxonomy). Verify before applying — applications happen on insurers\' official channels. Q places no applications, quotes or payments.')}</Type>
    {insuranceGroups.map(group => <View key={group.id} style={{ gap: 6 }}>
      <Type weight="600" size={14}>{text(group.title[0], group.title[1])} · {insuranceTypes.filter(item => item.group === group.id).length}</Type>
      {insuranceTypes.filter(item => item.group === group.id).map(item => {
        const expanded = expandedInsurance === item.id;
        return <View key={item.id} style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.line }}>
          <Row title={text(item.title[0], item.title[1])} subtitle={text(item.coverage[0], item.coverage[1])} last onPress={() => setExpandedInsurance(expanded ? null : item.id)} />
          {expanded ? <View style={{ gap: 6, padding: 12, paddingTop: 0 }}>
            <Type size={12} muted selectable>{text('监管归属', 'Regulation')}：{text(regClasses[item.regClass][0], regClasses[item.regClass][1])} · {text(regSubLabels[item.regSub][0], regSubLabels[item.regSub][1])} · {text(formTags[item.formTag][0], formTags[item.formTag][1])}</Type>
            <Type size={12} muted selectable>{text('重点核对', 'Check carefully')}：{item.caution}</Type>
            <Type size={12} muted>{text('承保公司官方投保入口（列举 3 家，非排名非推荐）：', 'Official insurer entries (3 listed, not a ranking or recommendation):')}</Type>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(groupInsurers[group.id] ?? []).map(insurer => <Choice key={insurer.url} label={`${text(insurer.name[0], insurer.name[1])} ↗`} selected={false} onPress={() => gotoOutbound(text(insurer.name[0], insurer.name[1]), insurer.url)} />)}
            </View>
            <Type size={11} muted>{text(`条目整理于 ${item.updatedAt} · 保障豁免、等待期、理赔材料以条款为准；详见「保险」页。`, `Reviewed ${item.updatedAt}. Exclusions, waiting periods and claim documents follow policy terms; see the Insurance page for details.`)}</Type>
          </View> : null}
        </View>;
      })}
    </View>)}
    <Type size={12} muted>{text('本视图与「保险」页为同一目录的两面：理财侧看配置，保险侧看核对。任何修改不得让用户产生「可以在这里买保险」的预期。', 'This view and the Insurance page share one catalogue: allocation here, verification there. Users must never expect to buy insurance inside Q.')}</Type>
  </>;
  const views = { overview, perf, holdings: holdingsView, funds, protection, ai, shelf, settings };
  return <Page
    title={text('理财', 'Wealth')}
    action={<Action kind="ghost" label={text('模拟账本', 'Demo ledger')} onPress={() => setRiskSheet(true)} />}
    description={text('模拟持仓、公开基金资料与按次数据服务在一个页面。不构成投资建议。', 'A demo portfolio, public fund directory and pay-per-use data on one screen. Not investment advice.')}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tabs.map(tab => <Choice key={tab.id} label={text(tab.title[0], tab.title[1])} selected={page === tab.id && !detail} onPress={() => { setDetail(null); setPage(tab.id); }} />)}
    </View>
    {detail ? detailView() : views[page]()}
    <Sheet visible={!!outbound} title={text('前往官方网站', 'Visit official website')} onClose={() => setOutbound(null)}>
      {outbound ? <>
        <Type>{text('即将离开小Q，打开以下官方页面：', 'You are leaving Q for this official page:')}</Type>
        <Type weight="600">{outbound.title}</Type>
        <Type selectable size={13}>{outbound.url}</Type>
        <Type muted>{text('开户、申购、赎回、投保与费率确认均在官方渠道完成；小Q不代办交易、不代收款，也不会自动提交任何资料。', 'Account opening, orders, policies and fee confirmation happen on the official channel. Q places no orders or payments and submits nothing automatically.')}</Type>
        {linkError ? <Type color={colors.danger}>{text('未能打开，请重试或复制上方链接。', 'Unable to open. Retry or copy the link above.')}</Type> : null}
        <Action icon={ArrowUpRight} label={text('继续打开', 'Continue')} onPress={() => void openOutbound()} />
        <Action kind="secondary" label={text('返回', 'Back')} onPress={() => setOutbound(null)} />
      </> : null}
    </Sheet>
    <Sheet visible={riskSheet} title={text('模拟账本说明', 'About the demo ledger')} onClose={() => setRiskSheet(false)}>
      <Type>{text(DEMO_NOTE[0], DEMO_NOTE[1])}</Type>
      <Type>{text(DISCLAIMER[0], DISCLAIMER[1])}</Type>
      <Action label={text('知道了', 'Got it')} onPress={() => setRiskSheet(false)} />
    </Sheet>
  </Page>;
}
