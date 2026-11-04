// Paid financial data services (Machine Pay: pay-per-use). Prices are fixed list prices in CNY fen.
// Public sources only; every service names its source and review date. This is an information and
// data service — never investment advice, return promises or product recommendations.
export type Copy = readonly [string, string];
export type DataServiceId = 'crypto-quote' | 'company-filings' | 'news-themes' | 'pro-qa';
export type DataService = {
  id: DataServiceId;
  title: Copy;
  kind: Copy;
  priceMinorCny: number;
  summary: Copy;
  deliverable: Copy;
  sourceName: string;
  sourceUrl: string;
  // Market query executed on delivery; pro-qa delivers Q&A credit instead of a data fetch.
  query: ({ kind: 'crypto'; asset: 'BTC' | 'ETH' | 'SOL' } | { kind: 'filings'; company: 'AAPL' | 'MSFT' | 'NVDA' } | { kind: 'news'; topic: 'fed' | 'markets' | 'crypto' | 'technology' } | null);
};
export const DATA_SERVICE_REVIEWED_ON = '2026-11-03';
// Real Alipay pay-per-use channel is not connected yet; the ledger below is an explicit demo meter.
export const REAL_CHANNEL_CONNECTED = false;
export const dataServices: readonly DataService[] = [
  {
    id: 'crypto-quote', title: ['币种快照', 'Crypto snapshot'], kind: ['市场数据 · 按次', 'Market data · per use'], priceMinorCny: 5,
    summary: ['读取所选币种的链上美元参考价与更新时间，返回单条快照。', 'Reads the on-chain USD reference price and update time for one asset.'],
    deliverable: ['一次快照读取：参考价、24 小时变化与源方更新时间。', 'One snapshot: reference price, 24h change and provider update time.'],
    sourceName: 'Chainlink · Ethereum', sourceUrl: 'https://docs.chain.link/data-feeds/using-data-feeds',
    query: { kind: 'crypto', asset: 'BTC' },
  },
  {
    id: 'company-filings', title: ['公司公告检索', 'Company filings lookup'], kind: ['公开申报 · 按次', 'Public filings · per use'], priceMinorCny: 30,
    summary: ['查询所选美国公司的近期公开申报文件列表（公告日、报告期、文件编号）。', 'Lists recent public filings for one US company with dates and accession numbers.'],
    deliverable: ['一次申报列表读取：最多展示 20 条近期申报及 SEC 原文链接。', 'One filings read: up to 20 recent filings with links to SEC documents.'],
    sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',
    query: { kind: 'filings', company: 'AAPL' },
  },
  {
    id: 'news-themes', title: ['新闻样本主题分析', 'News theme analysis'], kind: ['样本分析 · 按次', 'Sample analysis · per use'], priceMinorCny: 50,
    summary: ['按主题抓取一组去重新闻标题，统计主题命中并给出样本说明。', 'Fetches a deduplicated headline sample for one theme and counts topic hits.'],
    deliverable: ['一次样本分析：主题计数、标题列表与来源时间说明。', 'One sample: theme counts, headline list and source-time notes.'],
    sourceName: 'GDELT', sourceUrl: 'https://www.gdeltproject.org/',
    query: { kind: 'news', topic: 'markets' },
  },
  {
    id: 'pro-qa', title: ['Pro 理财问答', 'Pro Q&A credit'], kind: ['问答额度 · 按次', 'Q&A credit · per use'], priceMinorCny: 50,
    summary: ['解锁一次深度理财问答额度，可在与小Q的对话中发起深度问题。', 'Unlocks one deep financial Q&A credit usable in your chat with Q.'],
    deliverable: ['一次问答额度：在对话中发起深度理财问题时消耗。', 'One Q&A credit, consumed when you ask a deep financial question in chat.'],
    sourceName: '小Q · Pro 问答', sourceUrl: 'https://q.kaicloudpay.com',
    query: null,
  },
];
export function dataServiceById(id: string): DataService | null {
  return dataServices.find(service => service.id === id) ?? null;
}
export function priceText(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}
export const DEMO_LEDGER_NOTE_ZH = '演示计量账本：仅用于演示按量计费流程，与港币钱包及模拟银行资金完全分开，不构成真实扣款。真实支付宝按量付费通道接入后，此账本将被真实订单替换。';
export const DEMO_LEDGER_NOTE_EN = 'Demo metering ledger: it demonstrates the pay-per-use flow only, and is fully separate from the HKD wallet and simulated bank funds. No real charge is made. It will be replaced by real orders once the Alipay pay-per-use channel is connected.';
export const SERVICE_DISCLAIMER_ZH = '金融信息与数据服务：只交付公开来源的数据与整理结果，不构成投资建议，不承诺收益，不推荐任何产品。';
export const SERVICE_DISCLAIMER_EN = 'Financial information and data service: delivers public-source data and summaries only. Not investment advice, no promised returns, no product recommendations.';
