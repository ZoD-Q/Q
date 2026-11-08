// Wealth center (simulated portfolio ledger + public fund directory). All portfolio figures are
// demo data, explicitly separated from the real HKD wallet and simulated bank funds. The fund
// directory lists public disclosures only — never recommendations, rankings or fixed returns.
export type Copy = readonly [string, string];
export type RiskLevel = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export const DEMO_NOTE: Copy = ['模拟账本：全部持仓与收益为演示数据，与港币钱包、模拟银行资金完全分开，不构成真实资产。', 'Demo ledger: all holdings and returns are simulated demo data, fully separate from the HKD wallet and bank demo funds.'];
export const DISCLAIMER: Copy = ['只做信息与数据整理，不构成投资建议，不承诺收益，不推荐产品。实际投资在持牌销售机构办理。', 'Information only: not investment advice, no promised returns, no product recommendations. Invest via licensed distributors.'];
export type WealthHolding = { id: string; name: string; code: string; type: Copy; risk: RiskLevel; hold: number; mv: number; pnl: number; term: string; status: Copy; official: string | null };
export const holdings: readonly WealthHolding[] = [
  { id: 'hf-000009', name: '易方达天天理财货币A', code: '000009', type: ['货币基金', 'Money market fund'], risk: 'R1', hold: 40000, mv: 40312.5, pnl: 312.5, term: '活期', status: ['持有中', 'Holding'], official: 'https://www.efunds.com.cn/fund/000009_org.shtml' },
  { id: 'hf-003003', name: '华夏现金增利货币A/E', code: '003003', type: ['货币基金', 'Money market fund'], risk: 'R1', hold: 30000, mv: 30236.8, pnl: 236.8, term: '活期', status: ['持有中', 'Holding'], official: 'https://www.chinaamc.com/fund/003003/index.shtml' },
  { id: 'hs-shortbond', name: '稳健短债（示例）', code: '—', type: ['债券基金', 'Bond fund'], risk: 'R2', hold: 20000, mv: 20256.4, pnl: 256.4, term: '90 天持有期', status: ['持有中', 'Holding'], official: null },
  { id: 'hs-mixed', name: '均衡混合（示例）', code: '—', type: ['混合基金', 'Mixed fund'], risk: 'R3', hold: 15000, mv: 15186.2, pnl: 186.2, term: '开放式', status: ['持有中', 'Holding'], official: null },
  { id: 'dp-3m', name: '3 个月定存（演示）', code: '—', type: ['银行存款', 'Bank deposit'], risk: 'R1', hold: 35000, mv: 35000, pnl: 0, term: '到期 2027-02-14', status: ['存续中', 'Active'], official: null },
];
export const HOLD_COST = holdings.reduce((sum, h) => sum + h.hold, 0);
export const HOLD_MV = holdings.reduce((sum, h) => sum + h.mv, 0);
export const HOLD_PNL = holdings.reduce((sum, h) => sum + h.pnl, 0);
export const DEPOSIT_MV = 35000;
export const FUND_MV = HOLD_MV - DEPOSIT_MV;
/** Live deviation of the simulated equity curve is applied to the fund part only. */
export const SIM_BASE_MV = HOLD_MV - FUND_MV - 0;
export const EQUITY_UNITS = FUND_MV;
/** Baseline of the simulated net-value curve; today's open is seeded near it. */
export const SIM_START_NAV = 1.039;
export type MarketFund = { code: string; name: string; org: string; type: Copy; risk: RiskLevel; feat: string; host: string; cat: 'money' | 'bond' | 'mix' | 'index' | 'qdii' };
export const fundCats: readonly { id: MarketFund['cat'] | 'all'; title: Copy }[] = [
  { id: 'all', title: ['全部', 'All'] }, { id: 'money', title: ['货币型', 'Money market'] }, { id: 'bond', title: ['债券型', 'Bond'] },
  { id: 'mix', title: ['混合型', 'Mixed'] }, { id: 'index', title: ['指数 · 股票型', 'Index & equity'] }, { id: 'qdii', title: ['QDII', 'QDII'] },
];
export const marketFunds: readonly MarketFund[] = [
  { code: '000198', name: '天弘余额宝货币', org: '天弘基金', type: ['货币型', 'Money market'], risk: 'R1', feat: '对接余额宝，1 元起购，申赎灵活', host: 'www.thfund.com', cat: 'money' },
  { code: '000009', name: '易方达天天理财货币A', org: '易方达基金', type: ['货币型', 'Money market'], risk: 'R1', feat: '老牌场外货币基金，适合现金管理', host: 'www.efunds.com.cn', cat: 'money' },
  { code: '003003', name: '华夏现金增利货币A/E', org: '华夏基金', type: ['货币型', 'Money market'], risk: 'R1', feat: '规模居前的场外货币基金', host: 'www.chinaamc.com', cat: 'money' },
  { code: '217022', name: '招商产业债券A', org: '招商基金', type: ['债券型', 'Bond'], risk: 'R2', feat: '主投高等级信用债与利率债', host: 'www.cmfchina.com', cat: 'bond' },
  { code: '110027', name: '易方达安心回报债券A', org: '易方达基金', type: ['债券型', 'Bond'], risk: 'R2', feat: '可参与转债的稳健债券基金', host: 'www.efunds.com.cn', cat: 'bond' },
  { code: '000051', name: '华夏沪深300ETF联接A', org: '华夏基金', type: ['指数 · 股票型', 'Index & equity'], risk: 'R4', feat: '跟踪沪深300宽基指数，费率低', host: 'www.chinaamc.com', cat: 'index' },
  { code: '110003', name: '易方达上证50增强', org: '易方达基金', type: ['指数 · 股票型', 'Index & equity'], risk: 'R4', feat: '上证50成分内增强策略', host: 'www.efunds.com.cn', cat: 'index' },
  { code: '005827', name: '易方达蓝筹精选混合', org: '易方达基金', type: ['混合型', 'Mixed'], risk: 'R4', feat: '大盘蓝筹风格主动管理', host: 'www.efunds.com.cn', cat: 'mix' },
  { code: '001938', name: '中欧时代先锋混合A', org: '中欧基金', type: ['混合型', 'Mixed'], risk: 'R4', feat: '成长风格行业精选', host: 'www.zofund.com', cat: 'mix' },
  { code: '000071', name: '华夏恒生ETF联接A', org: '华夏基金', type: ['QDII', 'QDII'], risk: 'R4', feat: '投资港股恒生指数成分，含汇率风险', host: 'www.chinaamc.com', cat: 'qdii' },
];
export type ShelfItem = { name: string; risk: RiskLevel; term: string; termCat: 'live' | 'short' | 'long'; bench: string; min: string };
export const shelfItems: readonly ShelfItem[] = [
  { name: '货币基金（示例）', risk: 'R1', term: '活期', termCat: 'live', bench: '业绩基准 1.5%–2.0%', min: '¥1' },
  { name: '同业存单指数（示例）', risk: 'R1', term: '短期 · 7 天持有', termCat: 'short', bench: '业绩基准 1.8%–2.2%', min: '¥1' },
  { name: '短债基金（示例）', risk: 'R2', term: '短期 · 90 天持有', termCat: 'short', bench: '业绩基准 2.0%–2.8%', min: '¥10' },
  { name: '固收+（示例）', risk: 'R3', term: '长期 · 开放式', termCat: 'long', bench: '业绩基准 3.0%–4.5%', min: '¥10' },
  { name: '偏股混合（示例）', risk: 'R4', term: '长期 · 开放式', termCat: 'long', bench: '业绩基准 5%–12%（波动较大）', min: '¥100' },
  { name: '指数增强（示例）', risk: 'R5', term: '长期 · 开放式', termCat: 'long', bench: '业绩基准：跟踪目标指数', min: '¥100' },
];
export const shelfRiskGroups = { stable: ['R1', 'R2'], balanced: ['R3'], aggressive: ['R4', 'R5'] } as const;
export type ShelfRiskGroup = keyof typeof shelfRiskGroups;
// Four-pocket allocation view (money-market / stable / long-term / protection), aligned with the
// mainstream "four pockets" framework. Protection mirrors the insurance catalogue — it is a
// planning view only and never an application channel.
export type Pocket = { id: string; title: Copy; hint: Copy };
export const pockets: readonly Pocket[] = [
  { id: 'liquid', title: ['活钱管理', 'Liquid cash'], hint: ['货币基金 · 随取随用', 'Money funds · liquid'] },
  { id: 'stable', title: ['稳健理财', 'Stable'], hint: ['短债与存款 · 底仓', 'Short bonds & deposits'] },
  { id: 'growth', title: ['长期投资', 'Long-term'], hint: ['均衡混合 · 波动中枢', 'Balanced funds · growth'] },
  { id: 'protection', title: ['保险保障', 'Protection'], hint: ['第四笔钱 · 先核对再投保', 'The fourth pocket · verify first'] },
];
export const savingsGoal = { title: ['目标 · 旅行基金', 'Goal · travel fund'], progress: 0.68, monthly: 2000, note: ['演示目标 · 每月定投 ¥2,000', 'Demo goal · ¥2,000 monthly'] };
export const marketMood = { temperature: 62, label: ['中性偏暖', 'Neutral-warm'], note: ['模拟指标 · 非投资建议 · 不代表任何官方指数', 'Simulated indicator · not investment advice'] };
export function trustedExternalUrl(url: string, allowed: readonly string[]): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && allowed.includes(url); }
  catch { return false; }
}
// Featured product list for the wealth home (Futu-style cards). Benchmark ranges are disclosed
// ranges, never promised returns; demo entries carry no official channel. Applications happen on
// the manager's or a licensed distributor's official channel — Q never places orders.
export type FeaturedProduct = { name: string; code: string; org: string; cat: 'stable' | 'growth'; risk: RiskLevel; bench: string; term: string; min: string; official: string | null; simStart?: number };
export const featuredProducts: readonly FeaturedProduct[] = [
  { name: '货币现金宝（示例）', code: '—', org: '示例组合', cat: 'stable', risk: 'R1', bench: '1.50%–2.00%', term: '活期', min: '¥1', official: null, simStart: 1.0 },
  { name: '易方达天天理财货币A', code: '000009', org: '易方达基金', cat: 'stable', risk: 'R1', bench: '1.60%–2.10%', term: '活期', min: '¥1', official: 'https://www.efunds.com.cn/fund/000009_org.shtml', simStart: 1.0002 },
  { name: '短债基金（示例）', code: '—', org: '示例类别', cat: 'stable', risk: 'R2', bench: '2.00%–2.80%', term: '90 天持有期', min: '¥10', official: null, simStart: 1.0312 },
  { name: '固收+（示例）', code: '—', org: '示例类别', cat: 'growth', risk: 'R3', bench: '3.00%–4.50%', term: '开放式', min: '¥10', official: null, simStart: 1.0846 },
  { name: '华夏沪深300ETF联接A', code: '000051', org: '华夏基金', cat: 'growth', risk: 'R4', bench: '跟踪沪深300', term: '开放式', min: '¥100', official: 'https://www.chinaamc.com/', simStart: 1.2418 },
  { name: '偏股混合（示例）', code: '—', org: '示例类别', cat: 'growth', risk: 'R4', bench: '5.00%–12.0%', term: '开放式', min: '¥100', official: null, simStart: 1.1563 },
];
