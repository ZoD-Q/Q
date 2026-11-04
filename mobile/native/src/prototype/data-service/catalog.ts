// Paid financial data services (Machine Pay: pay-per-use). Prices are fixed list prices in CNY fen.
// Public sources only; every service names its source and review date. This is an information and
// data service — never investment advice, return promises, product recommendations or brokerage.
export type Copy = readonly [string, string];
export type DataServiceId = 'crypto-quote' | 'company-filings' | 'fund-profile' | 'pro-qa';
export type DataServiceDelivery = 'market-report' | 'fund-profile' | 'qa-credit';
export type DataService = {
  id: DataServiceId;
  title: Copy;
  kind: Copy;
  priceMinorCny: number;
  summary: Copy;
  deliverable: Copy;
  sourceName: string;
  sourceUrl: string;
  delivery: DataServiceDelivery;
  // Market query executed on delivery (market-report only).
  query: ({ kind: 'crypto'; asset: 'BTC' | 'ETH' | 'SOL' } | { kind: 'filings'; company: 'AAPL' | 'MSFT' | 'NVDA' } | { kind: 'news'; topic: 'fed' | 'markets' | 'crypto' | 'technology' } | null);
};
export const DATA_SERVICE_REVIEWED_ON = '2026-11-03';
// Real Alipay pay-per-use channel is not connected yet; the ledger below is an explicit demo meter.
export const REAL_CHANNEL_CONNECTED = false;
// Public fund disclosures only. Q is not a licensed fund distributor: subscriptions happen on the
// manager's official direct channel or a licensed distributor. Rates are never fixed here.
export type FundOption = { id: string; name: Copy; code: string; typeName: Copy; org: string; feeNote: Copy; risk: Copy; url: string };
export const fundOptions: readonly FundOption[] = [
  {
    id: 'efund-000009', name: ['易方达天天理财货币A', 'E Fund Daily Money Market A'], code: '000009',
    typeName: ['货币基金', 'Money market fund'], org: '易方达基金',
    feeNote: ['管理费、托管费与销售服务费以基金公司官方最新公告为准，小Q不固化费率。', 'Management, custody and service fees follow current official disclosures; Q does not fix rates.'],
    risk: ['货币基金不是银行存款，不保证盈利或最低收益；赎回可能受流动性条件影响。', 'Money market funds are not deposits, guarantee no returns and may face liquidity terms.'],
    url: 'https://www.efunds.com.cn/fund/000009_org.shtml',
  },
  {
    id: 'chinaamc-003003', name: ['华夏现金增利货币A/E', 'ChinaAMC Cash Income Money A/E'], code: '003003',
    typeName: ['货币基金', 'Money market fund'], org: '华夏基金',
    feeNote: ['费率及交易规则以最新产品资料与销售渠道为准，历史收益不作为未来报价。', 'Fees and trading rules follow current disclosures; historical returns are not forecasts.'],
    risk: ['基金投资有风险，七日年化收益率不是承诺收益，也不代表存款利率。', 'Funds involve risk; seven-day annualized yield is not a guaranteed return or deposit rate.'],
    url: 'https://www.chinaamc.com/fund/003003/index.shtml',
  },
];
export function fundById(id: string): FundOption | null {
  return fundOptions.find(fund => fund.id === id) ?? null;
}
export function trustedFundUrl(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && fundOptions.some(fund => fund.url === url); }
  catch { return false; }
}
export const dataServices: readonly DataService[] = [
  {
    id: 'crypto-quote', title: ['币种快照', 'Crypto snapshot'], kind: ['市场数据 · 按次', 'Market data · per use'], priceMinorCny: 5,
    summary: ['读取所选币种的链上美元参考价与更新时间，返回单条快照。', 'Reads the on-chain USD reference price and update time for one asset.'],
    deliverable: ['一次快照读取：参考价、24 小时变化与源方更新时间。', 'One snapshot: reference price, 24h change and provider update time.'],
    sourceName: 'Chainlink · Ethereum', sourceUrl: 'https://docs.chain.link/data-feeds/using-data-feeds',
    delivery: 'market-report', query: { kind: 'crypto', asset: 'BTC' },
  },
  {
    id: 'company-filings', title: ['公司公告检索', 'Company filings lookup'], kind: ['公开申报 · 按次', 'Public filings · per use'], priceMinorCny: 30,
    summary: ['查询所选美国公司的近期公开申报文件列表（公告日、报告期、文件编号）。', 'Lists recent public filings for one US company with dates and accession numbers.'],
    deliverable: ['一次申报列表读取：最多展示 20 条近期申报及 SEC 原文链接。', 'One filings read: up to 20 recent filings with links to SEC documents.'],
    sourceName: 'SEC EDGAR', sourceUrl: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',
    delivery: 'market-report', query: { kind: 'filings', company: 'AAPL' },
  },
  {
    id: 'fund-profile', title: ['基金资料快照', 'Fund profile snapshot'], kind: ['公开基金资料 · 按次', 'Fund disclosures · per use'], priceMinorCny: 30,
    summary: ['查询所选公开募集基金的公开资料：代码、类型、费用说明要点与风险提示。', 'Public disclosures for one selected fund: code, type, fee notes and risk warnings.'],
    deliverable: ['一次资料快照：基金公开资料摘要与官方详情页、申购入口链接。', 'One snapshot: fund disclosure summary with official page and subscription entry.'],
    sourceName: '基金管理人公开披露', sourceUrl: 'https://www.efunds.com.cn/',
    delivery: 'fund-profile', query: null,
  },
  {
    id: 'pro-qa', title: ['Pro 理财问答', 'Pro Q&A credit'], kind: ['问答额度 · 按次', 'Q&A credit · per use'], priceMinorCny: 50,
    summary: ['解锁一次深度理财问答额度，可在与小Q的对话中发起深度问题。', 'Unlocks one deep financial Q&A credit usable in your chat with Q.'],
    deliverable: ['一次问答额度：在对话中发起深度理财问题时消耗。', 'One Q&A credit, consumed when you ask a deep financial question in chat.'],
    sourceName: '小Q · Pro 问答', sourceUrl: 'https://q.kaicloudpay.com',
    delivery: 'qa-credit', query: null,
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
export const SERVICE_DISCLAIMER_ZH = '金融信息与数据服务：只交付公开来源的数据与整理结果，不构成投资建议，不承诺收益，不推荐任何产品。基金申购请在基金管理人官方直销渠道或持牌销售机构办理；基金投资有风险。';
export const SERVICE_DISCLAIMER_EN = 'Financial information and data service: delivers public-source data and summaries only. Not investment advice, no promised returns, no product recommendations. Fund subscriptions happen via the manager\'s official channel or a licensed distributor; funds involve risk.';
