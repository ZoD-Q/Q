export type Category = 'installments' | 'insurance' | 'finance';
export type Copy = readonly [string, string];
export type Listing = {
  id: string; category: Category; company: Copy; title: Copy; kind: Copy;
  summary: Copy; eligibility: Copy; costs: Copy; risk: Copy; preparation: Copy[];
  url: string; sourceTitle: string; evidence: 'page' | 'search';
};
export const reviewedOn = '2026-10-19';
// Editorial snapshots of public information. No live quote, partnership or API authorization implied.
export const listings: readonly Listing[] = [
  {
    id: 'ccb-bill', category: 'installments', company: ['中国建设银行', 'China Construction Bank'],
    title: ['龙卡信用卡账单分期', 'Long Card bill installments'], kind: ['信用卡账单', 'Credit card bill'],
    summary: ['通过建行官方渠道了解信用卡账单分期；官网办理入口引导至手机银行。', 'Explore bill installments through CCB; the official entry directs users to mobile banking.'],
    eligibility: ['面向符合银行条件的持卡人；可分金额、期数和资格由银行确定。', 'For eligible cardholders; the bank determines the amount, term and eligibility.'],
    costs: ['官网不同历史页面存在门槛差异，不在小Q固化金额或费率；以本次官方报价和条款为准。', 'Historical pages differ. Amount limits and rates must be checked in the current official quote and terms.'],
    risk: ['分期属于信用卡还款安排；须核对总成本、提前结清和逾期责任。', 'Check total cost, early settlement and overdue obligations.'],
    preparation: [['查看本期账单及可分交易', 'Review the bill and eligible transactions'], ['核对总成本、期数和还款日期', 'Check total cost, term and due dates'], ['阅读官方业务条款', 'Read the official terms']],
    url: 'https://creditcard.ccb.com/chn/home/creditcard/installment/check/index.shtml', sourceTitle: '中国建设银行 · 账单分期', evidence: 'page',
  },
  {
    id: 'cmb-bill', category: 'installments', company: ['招商银行', 'China Merchants Bank'],
    title: ['信用卡账单分期', 'Credit card bill installments'], kind: ['信用卡账单', 'Credit card bill'],
    summary: ['招商银行官方提供账单分期介绍及业务条款。', 'CMB publishes a bill installment introduction and terms.'],
    eligibility: ['持卡人及交易须符合银行规定，具体以官方实时评估为准。', 'Cardholders and transactions must meet the bank’s criteria and current assessment.'],
    costs: ['实际利率取决于官方评估；单期利率不能直接当作年化利率。', 'The actual rate depends on the bank’s assessment; a per-period rate is not an annual rate.'],
    risk: ['需阅读提前结清、违约及剩余债务处理条款。', 'Review early repayment, default and outstanding debt provisions.'],
    preparation: [['查看官方账单及可分金额', 'Check the official bill and eligible amount'], ['核对还款方式及年化成本', 'Check repayment method and annualized cost'], ['确认提前结清规则', 'Review early settlement rules']],
    url: 'https://cc.cmbchina.com/content/loan/zdfqtk.htm', sourceTitle: '招商银行 · 账单分期条款及细则', evidence: 'search',
  },
  {
    id: 'pingan-insurance', category: 'insurance', company: ['中国平安', 'Ping An'],
    title: ['平安保险商城', 'Ping An insurance catalog'], kind: ['综合保险目录', 'Insurance catalog'],
    summary: ['官方商城提供意外、旅游、健康、家财等保险分类。本条为目录入口，不是单一保险产品。', 'The official catalog lists accident, travel, health and home insurance. This entry is a catalog, not one policy.'],
    eligibility: ['年龄、职业、健康告知、保障地区及承保主体需在具体产品中核对。', 'Check age, occupation, health disclosures, territory and insurer for the selected policy.'],
    costs: ['保费依方案、保障期限和投保资料计算；不以宣传起价代替个人报价。', 'Premiums depend on plan, duration and applicant details; advertised starting prices are not personal quotes.'],
    risk: ['核对责任免除、等待期、免赔额、赔付比例与理赔资料。', 'Check exclusions, waiting periods, deductibles, payout ratios and claim documents.'],
    preparation: [['选择具体产品及承保公司', 'Select the policy and insurer'], ['阅读条款和责任免除', 'Read terms and exclusions'], ['核对生效时间与保障地区', 'Check effective date and territory']],
    url: 'https://baoxian.pingan.com/product/', sourceTitle: '平安保险商城 · 保险产品', evidence: 'page',
  },
  {
    id: 'picc-insurance', category: 'insurance', company: ['中国人民财产保险', 'PICC Property and Casualty'],
    title: ['人保财险服务大厅', 'PICC service portal'], kind: ['综合保险目录', 'Insurance catalog'],
    summary: ['官方服务大厅提供保险产品和服务入口，可继续查看旅游、意外等分类。', 'The official portal provides product and service entries including travel and accident categories.'],
    eligibility: ['本条为机构服务入口；具体产品条件和是否在售须在官方页面确认。', 'This is a provider portal. Confirm eligibility and availability on the selected product’s official page.'],
    costs: ['小Q未获取核保或报价接口，保费和保额在官方渠道查询。', 'Q has no underwriting or quoting API; check premiums and limits with the provider.'],
    risk: ['不同产品责任不同，目录分类不能代表已经获得保障。', 'Coverage varies by policy; browsing a category does not provide insurance.'],
    preparation: [['确定出行或保障场景', 'Identify the coverage scenario'], ['查看投保须知和具体条款', 'Read application guidance and policy terms'], ['向官方确认承保及理赔条件', 'Confirm underwriting and claims conditions']],
    url: 'https://property.picc.com/piccinternal/', sourceTitle: '中国人保财险 · 服务大厅', evidence: 'search',
  },
  {
    id: 'efund-000009', category: 'finance', company: ['易方达基金', 'E Fund'],
    title: ['易方达天天理财货币A', 'E Fund Daily Money Market A'], kind: ['货币基金 · 000009', 'Money market fund · 000009'],
    summary: ['基金代码000009，官方详情提供基本信息、费用、公告及风险揭示。', 'Fund 000009; the official page provides fund information, fees, disclosures and risks.'],
    eligibility: ['通过具备相应资格的销售渠道办理，账户、适当性及申赎状态由渠道确认。', 'Use an authorized distribution channel; account, suitability and trading status are confirmed there.'],
    costs: ['需核对管理费、托管费、销售服务费及相关优惠公告；小Q不提供实时收益报价。', 'Check management, custody and service fees and any current discounts. Q does not provide live yield quotes.'],
    risk: ['货币基金不是银行存款，不保证盈利或最低收益；赎回可能受流动性等条件影响。', 'Money market funds are not deposits or guaranteed returns. Liquidity may affect redemption.'],
    preparation: [['阅读产品资料概要和招募说明书', 'Read the product summary and prospectus'], ['核对风险匹配与费用', 'Check suitability and fees'], ['查看最新申赎公告', 'Check current subscription and redemption notices']],
    url: 'https://www.efunds.com.cn/fund/000009_org.shtml', sourceTitle: '易方达基金 · 000009基金详情', evidence: 'page',
  },
  {
    id: 'chinaamc-003003', category: 'finance', company: ['华夏基金', 'China Asset Management'],
    title: ['华夏现金增利货币A/E', 'ChinaAMC Cash Income Money Market A/E'], kind: ['货币基金 · 003003', 'Money market fund · 003003'],
    summary: ['官方页面展示华夏现金增利货币A/E及代码003003，提供基金资料和公告入口。', 'The official page lists the A/E share class, code 003003, with fund information and announcements.'],
    eligibility: ['须核对所选份额、销售渠道、账户及适当性要求，不能用目录浏览代替开户。', 'Check share class, distributor, account and suitability requirements; browsing is not account opening.'],
    costs: ['费率及交易规则以最新产品资料和销售渠道为准；历史收益不作为未来报价。', 'Current disclosures and the distributor determine fees and trading rules; historical returns are not forecasts.'],
    risk: ['基金投资存在风险，七日年化收益率不是承诺收益，也不代表存款利率。', 'Funds involve risk. Seven-day annualized yield is not a guaranteed return or deposit rate.'],
    preparation: [['核对基金代码及份额类别', 'Check fund code and share class'], ['查看费用和产品资料概要', 'Read fees and the product summary'], ['确认申赎状态及到账规则', 'Check trading status and settlement rules']],
    url: 'https://www.chinaamc.com/fund/003003/index.shtml', sourceTitle: '华夏基金 · 003003基金详情', evidence: 'page',
  },
];

export function trustedSource(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && listings.some(item => item.url === url); }
  catch { return false; }
}
export function findListings(category: Category, query: string): Listing[] {
  const term = query.trim().toLocaleLowerCase();
  return listings.filter(item => item.category === category && [item.title, item.company, item.kind].flat().join(' ').toLocaleLowerCase().includes(term));
}
