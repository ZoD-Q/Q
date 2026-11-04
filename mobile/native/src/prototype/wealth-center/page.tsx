import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';
import { ArrowUpRight, Sparkles } from 'lucide-react-native';
import { Action, Choice, Page, Row, Sheet, Tag, Type, useDesign } from '../design';
import {
  DEMO_NOTE, DEPOSIT_MV, DISCLAIMER, EQUITY_UNITS, FUND_MV, HOLD_COST, HOLD_MV, HOLD_PNL, holdings, marketFunds, fundCats,
  shelfItems, SIM_START_NAV, trustedExternalUrl, type Copy, type MarketFund, type ShelfItem, type ShelfRiskGroup, type WealthHolding,
} from './catalog';
import {
  filterFunds, filterShelf, nextCandle, RISK_LABEL, seedCandles, sliceWindow, todayPct, todayPnl, windowBounds, type Candle,
} from './core';

type PageKey = 'overview' | 'perf' | 'holdings' | 'funds' | 'ai' | 'shelf' | 'settings';
const tabs: readonly { id: PageKey; title: Copy }[] = [
  { id: 'overview', title: ['总览', 'Overview'] }, { id: 'perf', title: ['收益风险', 'Risk & return'] },
  { id: 'holdings', title: ['持仓', 'Holdings'] }, { id: 'funds', title: ['基金', 'Funds'] },
  { id: 'ai', title: ['AI 助手', 'Assistant'] }, { id: 'shelf', title: ['货架', 'Shelf'] }, { id: 'settings', title: ['设置', 'Settings'] },
];
const shelfRisks: readonly { id: ShelfRiskGroup | 'all'; title: Copy }[] = [
  { id: 'all', title: ['全部风险', 'All risk'] }, { id: 'stable', title: ['稳健 R1–R2', 'Stable'] },
  { id: 'balanced', title: ['平衡 R3', 'Balanced'] }, { id: 'aggressive', title: ['进取 R4–R5', 'Aggressive'] },
];
const shelfTerms: readonly { id: 'all' | 'live' | 'short' | 'long'; title: Copy }[] = [
  { id: 'all', title: ['全部期限', 'All terms'] }, { id: 'live', title: ['活期', 'Liquid'] }, { id: 'short', title: ['短期', 'Short'] }, { id: 'long', title: ['长期', 'Long'] },
];
const money = (value: number) => `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = () => new Date().toTimeString().slice(0, 8);

function CandleChart({ candles, price }: { candles: Candle[]; price: number }) {
  const { colors } = useDesign();
  const shown = sliceWindow(candles, 26);
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
    const seeded = seedCandles(30, SIM_START_NAV);
    return { candles: seeded.candles, price: seeded.price, dayOpen: seeded.candles[Math.max(0, seeded.candles.length - 26)].o };
  };
  const market = useRef<ReturnType<typeof initMarket> | null>(null);
  if (!market.current) market.current = initMarket();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const state = market.current!;
      const step = nextCandle(state.price);
      state.candles.push(step.candle);
      if (state.candles.length > 90) state.candles.shift();
      state.price = step.price;
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
  const [switches, setSwitches] = useState({ advisory: true, market: true, usage: false });
  const allowedUrls = useMemo(() => [
    ...holdings.map(item => item.official).filter((url): url is string => Boolean(url)),
    ...marketFunds.map(fund => `https://${fund.host}`),
  ], []);
  const openOutbound = async () => {
    if (!outbound || !trustedExternalUrl(outbound.url, allowedUrls)) { setLinkError(true); return; }
    try { await Linking.openURL(outbound.url); setOutbound(null); }
    catch { setLinkError(true); }
  };
  const gotoOutbound = (title: string, url: string) => { setLinkError(false); setOutbound({ title, url }); };
  const aiAnswer = (question: string): string => {
    if (/风险/.test(question)) return text('当前组合以 R1–R2 资产为主（货币类约占一半），整体风险等级约 R2（中低）。近一年最大回撤 -0.8%，波动较低。', 'The portfolio is dominated by R1–R2 assets; overall risk is about R2 (low-medium) with a -0.8% max drawdown over the past year.');
    if (/收益|怎么样/.test(question)) return text(`近 30 日收益 +¥1,086.75；今日权益部分收益 ${pnl >= 0 ? '+' : ''}${money(pnl)}（实时模拟）。`, `Last 30 days +¥1,086.75; today's equity P&L is ${pnl >= 0 ? '+' : ''}${money(pnl)} (simulated, live).`);
    if (/到期/.test(question)) return text('3 个月定存（演示）¥35,000 将于 2027-02-14 到期，其余持仓为活期或开放式，无近期到期安排。', 'The demo 3-month deposit (¥35,000) matures on 2027-02-14; other holdings are liquid or open-ended.');
    if (/配|稳/.test(question)) return text('一般性信息：货币类流动性好、收益较低；债券类波动略高。稳健组合通常以货币与短债为基础。具体配置需结合你的目标与风险承受能力，不构成投资建议。', 'General information only: money-market assets trade liquidity for yield, bond funds add some volatility. Stable portfolios usually build on cash and short-duration bonds. This is not investment advice.');
    if (/回撤/.test(question)) return text('最大回撤是区间内从最高点到其后最低点的最大跌幅，用于衡量下行风险。你的组合近一年最大回撤为 -0.8%（模拟数据）。', 'Max drawdown is the largest peak-to-trough decline in a period, measuring downside risk. Your portfolio shows -0.8% over the past year (simulated).');
    return text('（演示）正式版本将接入小Q对话能力，基于模拟账本与公开知识作答，不构成投资建议。', '(Demo) The full version will connect Q chat, answering from the demo ledger and public knowledge. Not investment advice.');
  };
  const ask = (question: string) => { if (question.trim()) setAiLog(current => [...current, [question.trim(), aiAnswer(question.trim())] as [string, string]].slice(-8)); };

  const overview = () => <>
    <View style={{ gap: 12, padding: 20, borderRadius: 20, backgroundColor: colors.accentBg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Sparkles size={20} color={colors.accent} strokeWidth={1.6} /><Type size={13} muted>{text('总资产（模拟）', 'Total assets (demo)')}</Type></View>
        <Tag>{text('模拟账本', 'Demo ledger')}</Tag>
      </View>
      <Type selectable size={34} weight="600" style={{ letterSpacing: -1 }}>{money(totalNow)}</Type>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 22 }}>
        <View><Type size={11} muted>{text('今日收益', "Today's P&L")}</Type><Type selectable weight="600" color={pnl >= 0 ? colors.ink : colors.danger}>{pnl >= 0 ? '+' : ''}{money(pnl)}</Type></View>
        <View><Type size={11} muted>{text('累计收益', 'Cumulative')}</Type><Type selectable weight="600">{money(HOLD_PNL + 3281.53)}</Type></View>
        <View><Type size={11} muted>{text('持仓数', 'Positions')}</Type><Type weight="600">{holdings.length}</Type></View>
      </View>
      <Type size={11} muted>{text(`统计口径：市值按最新净值/本金估算。实时更新于 ${clock()}。`, `Market value follows the latest estimates. Live at ${clock()}.`)}</Type>
    </View>
    <View style={{ gap: 10, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}>
      <Type weight="600">{text('资产分布', 'Asset mix')}</Type>
      <View style={{ flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden' }}>
        <View style={{ backgroundColor: colors.accent, flex: FUND_MV + pnl }} />
        <View style={{ backgroundColor: colors.soft, flex: DEPOSIT_MV }} />
      </View>
      <Type size={12} muted selectable>{text(`基金 ${money(FUND_MV + pnl)} · 存款 ${money(DEPOSIT_MV)}`, `Funds ${money(FUND_MV + pnl)} · deposits ${money(DEPOSIT_MV)}`)}</Type>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <Tag>{RISK_LABEL.R2}</Tag>
      <Tag>{text('年化 3.12%（模拟，非承诺）', '3.12% annualized (demo)')}</Tag>
    </View>
    {onOpenDataService ? <Action label={text('按次购买金融数据服务', 'Pay-per-use data service')} onPress={onOpenDataService} /> : null}
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
  const views = { overview, perf, holdings: holdingsView, funds, ai, shelf, settings };
  return <Page
    title={text('理财', 'Wealth')}
    action={<Action kind="ghost" label={text('模拟账本', 'Demo ledger')} onPress={() => setRiskSheet(true)} />}
    description={text('模拟持仓、公开基金资料与按次数据服务在一个页面。不构成投资建议。', 'A demo portfolio, public fund directory and pay-per-use data on one screen. Not investment advice.')}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tabs.map(tab => <Choice key={tab.id} label={text(tab.title[0], tab.title[1])} selected={page === tab.id} onPress={() => setPage(tab.id)} />)}
    </View>
    {views[page]()}
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
