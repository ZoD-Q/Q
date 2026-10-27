import { useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ExternalLink, type LucideIcon } from 'lucide-react-native';
import { Page, Row, Sheet, Type, useDesign } from '../design';
import { buildResearchDraft, marketErrorText, marketLimitationText, marketQueryKey, type MarketQuery, type MarketReport } from './core';
import { useMarketData } from './use-market-data';

type Outbound = { title: string; url: string };
const externalProviders = [
  { name: ['金十数据', 'Jin10'], url: 'https://mcp.jin10.com/app/doc.html' },
  { name: ['同花顺', 'Tonghuashun'], url: 'https://www.10jqka.com.cn/' },
  { name: ['同花顺 iFinD', 'iFinD'], url: 'https://ftwc.51ifind.com/gwstatic/static/ds_web/quantapi-web/download.html' },
  { name: ['Alpaca', 'Alpaca'], url: 'https://docs.alpaca.markets/us/docs/about-market-data-api' },
  { name: ['Massive', 'Massive'], url: 'https://massive.com/docs' },
] as const;
const topicNames = {
  monetary_policy: ['货币政策', 'Monetary policy'], earnings: ['财报', 'Earnings'],
  crypto: ['加密资产', 'Crypto'], technology: ['科技', 'Technology'], markets: ['市场', 'Markets'],
} as const;

function Button({ label, onPress, selected, disabled = false, primary = false, icon: Icon }: {
  label: string; onPress: () => void; selected?: boolean; disabled?: boolean; primary?: boolean; icon?: LucideIcon;
}) {
  const { colors } = useDesign();
  const color = primary ? colors.onAccent : selected ? colors.accent : colors.ink;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: primary ? colors.accent : selected ? colors.accentBg : colors.soft, opacity: disabled ? 0.45 : pressed ? 0.65 : 1, flexShrink: 1 })}>
    {Icon ? <Icon accessible={false} size={16} color={color} strokeWidth={1.7} /> : null}
    <Type size={14} weight={primary || selected ? '600' : '400'} color={color} style={{ flexShrink: 1 }}>{label}</Type>
  </Pressable>;
}

function Group({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

function timestamp(value: string | null, missing: string) {
  if (!value) return missing;
  return value.includes('T') ? value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC') : value;
}

function publicHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.hostname : null;
  } catch { return null; }
}

function ResultRecords({ report, preview }: { report: MarketReport; preview: (link: Outbound) => void }) {
  const { text, colors, locale } = useDesign();
  const unavailable = text('未提供', 'Not provided');
  const number = (value: number | null, currency = false) => value === null ? unavailable : new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', currency ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) < 1 ? 6 : 2 } : { maximumFractionDigits: 2 }).format(value);
  if (report.kind === 'crypto') return <View style={{ gap: 18 }}>
    {report.records.slice(0, 20).map(record => <View key={record.id} style={{ gap: 16 }}>
      <Type size={17} weight="600">{record.name} · {record.symbol}</Type>
      <View style={{ gap: 2 }}><Type size={32} weight="600" selectable>{number(record.priceUsd, true)}</Type><Type size={13} muted>{text('报价币种：USD（美元）', 'Quote currency: USD')}</Type></View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 24 }}>
        <View style={{ gap: 4 }}><Type size={13} muted>{text('24 小时变化', '24-hour change')}</Type><Type selectable weight="500">{record.change24hPct === null ? unavailable : `${record.change24hPct > 0 ? '+' : ''}${number(record.change24hPct)}%`}</Type></View>
        <View style={{ gap: 4 }}><Type size={13} muted>{text('24 小时成交量 · USD', '24-hour volume · USD')}</Type><Type selectable>{number(record.volume24hUsd, true)}</Type></View>
        <View style={{ gap: 4 }}><Type size={13} muted>{text('市值 · USD', 'Market cap · USD')}</Type><Type selectable>{number(record.marketCapUsd, true)}</Type></View>
      </View>
      <Type size={13} muted>{text('源方报价时间：', 'Provider quote time: ')}{timestamp(record.asOf, unavailable)}</Type>
    </View>)}
  </View>;
  if (report.kind === 'filings') return <View style={{ gap: 20 }}>
    <Type size={13} muted>{text('公告日、报告期和受理时间含义不同；列表为所选公司的近期公开申报文件。', 'Filing date, report period and acceptance time are distinct. These are recent public filings for the selected company.')}</Type>
    {report.records.slice(0, 20).map(record => <View key={record.accessionNumber} style={{ gap: 8, paddingBottom: 20, borderBottomWidth: 1, borderColor: colors.line }}>
      <Type size={18} weight="600">{record.form}</Type>
      <Type size={14} selectable>{text('公告日：', 'Filing date: ')}{record.filingDate}</Type>
      <Type size={13} muted selectable>{text('报告期：', 'Report period: ')}{timestamp(record.reportDate, unavailable)}</Type>
      <Type size={13} muted selectable>{text('SEC 受理时间：', 'SEC accepted at: ')}{timestamp(record.acceptedAt, unavailable)}</Type>
      <Type size={12} muted selectable>{text('文件编号：', 'Accession: ')}{record.accessionNumber}</Type>
      <View style={{ alignSelf: 'flex-start' }}><Button icon={ExternalLink} label={text('查看 SEC 原始文件', 'View SEC filing')} onPress={() => preview({ title: `SEC · ${record.form}`, url: record.url })} /></View>
    </View>)}
  </View>;
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 10, backgroundColor: colors.soft, borderRadius: 16, padding: 18 }}>
      <Type weight="600">{text('当前样本主题', 'Themes in this sample')}</Type>
      <Type size={13} muted>{text(`基于当前 ${report.records.length} 条去重新闻的标题与摘要计数，一条可包含多个主题；不代表全网热度，也不证明事件因果。`, `Counts use titles and summaries from ${report.records.length} deduplicated news items. An item may match several themes; this is not a measure of global popularity or evidence of causation.`)}</Type>
      {report.hotspots.length ? <Group>{report.hotspots.map(item => <Type key={item.topic} size={14}>{text(topicNames[item.topic][0], topicNames[item.topic][1])} · {item.count}</Type>)}</Group> : <Type size={13} muted>{text('当前样本没有匹配的主题。', 'No matching themes in this sample.')}</Type>}
    </View>
    {report.records.slice(0, 20).map(record => <View key={record.url} style={{ gap: 8, paddingBottom: 20, borderBottomWidth: 1, borderColor: colors.line }}>
      <Type size={17} weight="500" selectable>{record.title}</Type>
      <Type size={13} muted>{record.publisher ?? text('发布者未提供', 'Publisher not provided')} · {publicHost(record.url) ?? text('链接不可用', 'Link unavailable')}</Type>
      <Type size={13} muted>{record.timeKind === 'indexed' ? text('GDELT 索引时间（非发布日期）：', 'GDELT index time (not publication): ') : text('源方发布时间：', 'Provider publication time: ')}{timestamp(record.observedAt, unavailable)}</Type>
      {record.summary ? <Type size={14}>{record.summary}</Type> : null}
      <View style={{ alignSelf: 'flex-start' }}><Button icon={ExternalLink} label={text('查看来源页面', 'View source page')} disabled={!publicHost(record.url)} onPress={() => preview({ title: record.publisher ?? report.source.name, url: record.url })} /></View>
    </View>)}
  </View>;
}

export function MarketDataPage({ active, onAnalyze }: { active: boolean; onAnalyze: (draft: string) => boolean }) {
  const { text, colors, locale } = useDesign();
  const [query, setQuery] = useState<MarketQuery>({ kind: 'crypto', asset: 'BTC' });
  const [outbound, setOutbound] = useState<Outbound | null>(null);
  const [sourceDetails, setSourceDetails] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const [handoffError, setHandoffError] = useState(false);
  const market = useMarketData(query, active);
  const blocked = query.kind === 'crypto' && !__DEV__;
  const loading = market.phase === 'loading';
  const oldResult = Boolean(market.report && (market.stale || market.phase === 'error' || market.phase === 'cancelled'));
  const currentProvider = query.kind === 'crypto' ? 'CoinPaprika' : query.kind === 'filings' ? 'SEC EDGAR' : query.topic === 'fed' ? text('美联储', 'Federal Reserve') : 'GDELT';
  const providerUrl = query.kind === 'crypto' ? 'https://docs.coinpaprika.com/' : query.kind === 'filings' ? 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces' : query.topic === 'fed' ? 'https://www.federalreserve.gov/feeds/feeds.htm' : 'https://www.gdeltproject.org/';
  const choose = (next: MarketQuery) => { if (marketQueryKey(next) === marketQueryKey(query)) return; market.cancel(); setHandoffError(false); setQuery(next); };
  const preview = (link: Outbound) => { setLinkError(false); setSourceDetails(false); setOutbound(link); };
  const openLink = async () => {
    if (!outbound || !publicHost(outbound.url)) { setLinkError(true); return; }
    try { await Linking.openURL(outbound.url); setOutbound(null); } catch { setLinkError(true); }
  };
  const sendToChat = () => {
    if (!market.report || loading || !active) return;
    setHandoffError(!onAnalyze(buildResearchDraft({ ...market.report, freshness: oldResult ? 'stale' : market.report.freshness }, locale)));
  };
  return <Page title={text('市场资料', 'Market research')} description={text('按需查看公开行情、公司公告和新闻标题，核对来源后整理分析草稿。', 'Look up public quotes, company filings and news headlines, then prepare a research draft with its sources.')} action={<Button label={text('数据来源', 'Data sources')} onPress={() => setSourceDetails(true)} />}>
    <Group>
      <Button label={text('加密货币行情', 'Crypto quotes')} selected={query.kind === 'crypto'} onPress={() => choose({ kind: 'crypto', asset: 'BTC' })} />
      <Button label={text('美国公司公告', 'US company filings')} selected={query.kind === 'filings'} onPress={() => choose({ kind: 'filings', company: 'AAPL' })} />
      <Button label={text('新闻热点', 'News themes')} selected={query.kind === 'news'} onPress={() => choose({ kind: 'news', topic: 'fed' })} />
    </Group>
    <View style={{ gap: 12 }}>
      <Type size={15} weight="600">{query.kind === 'crypto' ? text('选择资产', 'Choose an asset') : query.kind === 'filings' ? text('选择公司', 'Choose a company') : text('选择主题', 'Choose a topic')}</Type>
      <Group>
        {query.kind === 'crypto' ? (['BTC', 'ETH', 'SOL'] as const).map(asset => <Button key={asset} label={asset} selected={query.asset === asset} onPress={() => choose({ kind: 'crypto', asset })} />) : null}
        {query.kind === 'filings' ? ([['AAPL', '苹果', 'Apple'], ['MSFT', '微软', 'Microsoft'], ['NVDA', '英伟达', 'NVIDIA']] as const).map(([company, zh, en]) => <Button key={company} label={`${company} · ${text(zh, en)}`} selected={query.company === company} onPress={() => choose({ kind: 'filings', company })} />) : null}
        {query.kind === 'news' ? ([['fed', '美联储', 'Federal Reserve'], ['markets', '金融市场', 'Markets'], ['crypto', '加密资产', 'Crypto'], ['technology', '科技', 'Technology']] as const).map(([topic, zh, en]) => <Button key={topic} label={text(zh, en)} selected={query.topic === topic} onPress={() => choose({ kind: 'news', topic })} />) : null}
      </Group>
      <Type size={13} muted>{text('来源：', 'Source: ')}{currentProvider}{text(' · 仅公开资料 · 点击后查询', ' · Public data only · Query on tap')}</Type>
      {query.kind === 'crypto' ? <Type size={13} muted>{blocked ? text('正式版本暂停 CoinPaprika 查询：商业使用许可仍待核实。可查看公开说明，不能获取行情。', 'CoinPaprika queries are disabled in release builds while commercial-use permission is unverified. Public documentation remains available.') : text('开发研究模式：CoinPaprika 仅供非商业开发研究；报价可能延迟，不是实时交易报价。', 'Development research only: CoinPaprika is restricted to noncommercial development research. Quotes may be delayed and are not live trading prices.')}</Type> : null}
      {query.kind === 'filings' ? <Type size={13} muted>{text('查询 SEC 公开申报摘要，不包含股票报价。', 'Queries SEC public filing metadata; stock prices are not included.')}</Type> : null}
      {query.kind === 'news' && query.topic !== 'fed' ? <Type size={13} muted>{text('GDELT 仅提供标题与索引信息。限流或暂不可用时会显示错误，不替换为其他来源。', 'GDELT supplies headline and index metadata. Rate limits or unavailable data are shown explicitly; no other source is substituted.')}</Type> : null}
    </View>
    <View style={{ gap: 12 }}>
      <Group>
        <Button primary label={loading ? text('正在查询…', 'Querying…') : market.report ? text('刷新资料', 'Refresh data') : market.phase === 'error' ? text('重试查询', 'Retry query') : text('查询公开资料', 'Query public data')} disabled={!active || blocked || loading || market.coolingDown} onPress={market.run} />
        {loading ? <Button label={text('取消查询', 'Cancel query')} onPress={market.cancel} /> : null}
        <Button icon={ExternalLink} label={text('来源说明', 'Source details')} onPress={() => preview({ title: currentProvider, url: providerUrl })} />
      </Group>
      <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
        {market.phase === 'idle' ? <Type size={13} muted>{text('尚未查询；打开页面不会自动请求公开资料。', 'Not queried. Opening this page does not request public data.')}</Type> : null}
        {loading ? <Type size={13} muted>{text('正在读取所选来源；离页或应用进入后台会取消。', 'Reading the selected source. Leaving the page or backgrounding the app cancels the request.')}</Type> : null}
        {market.phase === 'cancelled' ? <Type size={13} muted>{text('查询已取消，迟到的响应不会显示。', 'Query cancelled. Late responses will not be displayed.')}</Type> : null}
        {market.phase === 'error' ? <Type size={14} color={colors.danger}>{marketErrorText(market.error, locale)}</Type> : null}
        {market.coolingDown && !loading ? <Type size={13} muted>{text('为尊重来源更新频率与限流，下次可查询时间：', 'To respect source updates and rate limits, next query: ')}{timestamp(market.nextAllowedAt ? new Date(market.nextAllowedAt).toISOString() : null, '—')}</Type> : null}
        {market.phase === 'cooldown' && !market.coolingDown ? <Type size={13} muted>{text('现在可以手动重试。', 'You may retry manually now.')}</Type> : null}
      </View>
    </View>
    {market.report ? <View style={{ gap: 22 }}>
      <View style={{ gap: 8, borderLeftWidth: 3, borderLeftColor: oldResult ? colors.muted : colors.accent, paddingLeft: 14 }}>
        <Type weight="600">{oldResult ? text('旧结果 · 未更新', 'Previous result · not updated') : market.fromCache ? text('本次会话缓存', 'Cached in this session') : text('已获取公开资料', 'Public data retrieved')}</Type>
        {oldResult ? <Type size={13} muted>{text('以下仍是上次成功获取的资料，不代表当前状态。', 'The data below is the last successful result and may not reflect the current state.')}</Type> : null}
        <Type size={13} muted selectable>{text('提供方：', 'Provider: ')}{market.report.source.name}</Type>
        <Type size={13} muted selectable>{text('资料截至（源方）：', 'As of (provider): ')}{timestamp(market.report.asOf, text('未提供', 'Not provided'))}</Type>
        <Type size={13} muted selectable>{text('本次获取：', 'Fetched at: ')}{timestamp(market.report.fetchedAt, text('未提供', 'Not provided'))}</Type>
        <Type size={13} muted>{market.stale ? text('资料已过期或源方时间较旧，请在允许时刷新。', 'Data has expired or the provider timestamp is old. Refresh when available.') : market.report.freshness === 'unknown' ? text('无法确认资料新鲜度。', 'Data freshness cannot be confirmed.') : text('仍可能存在源方延迟；不保证实时。', 'Provider delays may still apply; real-time data is not guaranteed.')}</Type>
        <View style={{ alignSelf: 'flex-start' }}><Button icon={ExternalLink} label={text('本次资料来源', 'Source of this result')} onPress={() => preview({ title: market.report!.source.name, url: market.report!.source.url })} /></View>
      </View>
      {!market.report.records.length ? <Type muted>{text('此次查询没有返回记录。', 'No records returned by this query.')}</Type> : <ResultRecords report={market.report} preview={preview} />}
      <View style={{ gap: 6 }}>{market.report.limitations.map(item => <Type key={item} size={13} muted>{marketLimitationText(item, locale)}</Type>)}</View>
      <View style={{ gap: 10, alignItems: 'flex-start' }}>
        <Button primary label={text('交给小Q分析', 'Analyze with Q')} disabled={!active || loading || market.report.records.length === 0} onPress={sendToChat} />
        <Type size={13} muted>{text('仅将这份公开资料整理成新对话草稿，不会自动发送。可先检查、修改，再自行发送。', 'Prepares a new chat draft with this public data only. It is not sent automatically; review and edit it before sending.')}</Type>
        {handoffError ? <Type color={colors.danger} size={13}>{text('暂时无法打开分析草稿，请先结束正在进行的对话，再重试。', 'Cannot open the research draft right now. Finish the current conversation activity and retry.')}</Type> : null}
      </View>
    </View> : null}
    <Sheet visible={active && sourceDetails} title={text('来源与可用范围', 'Sources and availability')} onClose={() => setSourceDetails(false)}>
      <Type size={14} muted>{text('公开网址不等于业务已连接。来源只有在查询成功后才显示获取时间；本页不读取账户、凭据或个人财务资料。', 'A public URL does not establish a connection. A fetch time appears only after a successful query. This page does not read accounts, credentials or personal financial records.')}</Type>
      <Row title="CoinPaprika" subtitle={text('仅开发研究；正式版本禁用，商业许可待核实。', 'Development research only; disabled in release builds while commercial permission is unverified.')} onPress={() => preview({ title: 'CoinPaprika', url: 'https://docs.coinpaprika.com/' })} />
      <Row title="SEC EDGAR" subtitle={text('按需查询公开申报元数据；未查询不代表已连接。', 'On-demand public filing metadata. Availability is not a completed connection.')} onPress={() => preview({ title: 'SEC EDGAR', url: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces' })} />
      <Row title={text('美联储 / GDELT', 'Federal Reserve / GDELT')} subtitle={text('公开新闻源；GDELT 可能限流，未抓取文章全文。', 'Public news sources; GDELT may rate-limit requests. Article bodies are not fetched.')} last />
      <Type size={16} weight="600">{text('需官方权限，未连接', 'Official access required · Not connected')}</Type>
      {externalProviders.map(provider => <Row key={provider.name[1]} title={text(provider.name[0], provider.name[1])} subtitle={`${text('需官方权限，未连接', 'Official access required · Not connected')}\n${publicHost(provider.url)}`} onPress={() => preview({ title: text(provider.name[0], provider.name[1]), url: provider.url })} last />)}
      <Type size={13} muted>{text('官方账号、订阅与数据展示许可须另行确认，本页不提供密钥输入或自动授权。', 'Official accounts, subscriptions and display permissions require separate confirmation. This page has no key-entry or automatic authorization flow.')}</Type>
    </Sheet>
    <Sheet visible={active && Boolean(outbound)} title={text('打开外部来源', 'Open external source')} onClose={() => setOutbound(null)}>
      {outbound ? <>
        <Type weight="600">{outbound.title}</Type>
        <Type>{text('即将打开的域名：', 'Destination hostname: ')}{publicHost(outbound.url) ?? text('无效链接', 'Invalid link')}</Type>
        <Type selectable size={13} muted>{outbound.url}</Type>
        <Type size={13} muted>{text('由外部网站提供内容。打开链接不会验证其业务已接入小Q；本页不自动抓取文章全文。', 'Content is provided by an external website. Opening it does not establish an integration with Q. This page does not automatically fetch article bodies.')}</Type>
        {linkError ? <Type color={colors.danger}>{text('无法打开链接，请重试或复制上方地址。', 'Could not open the link. Retry or copy the address above.')}</Type> : null}
        <Button primary icon={ExternalLink} label={text('继续打开', 'Continue to website')} disabled={!publicHost(outbound.url)} onPress={() => void openLink()} />
        <Button label={text('返回', 'Back')} onPress={() => setOutbound(null)} />
      </> : null}
    </Sheet>
  </Page>;
}
