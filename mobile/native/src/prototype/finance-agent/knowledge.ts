import type { FinanceText } from './core';

export type FinanceKnowledgeSource = { title: FinanceText; url: string };
export type FinanceKnowledgeEntry = {
  id: string;
  title: FinanceText;
  summary: FinanceText;
  detail: FinanceText;
  sources: FinanceKnowledgeSource[];
  checkedAt: string;
};
export type KnowledgeResult = { kind: 'knowledge'; entry: FinanceKnowledgeEntry };

const checkedAt = '2026-10-27';
const savingsSource: FinanceKnowledgeSource = {
  title: { zh: '香港投委会：为未来储蓄', en: 'IFEC: Saving for the future' },
  url: 'https://www.ifec.org.hk/web/en/moneyessentials/savings.page',
};

/** Short educational explanations; no live prices, product ranking or individual advice. */
export const FINANCE_KNOWLEDGE: readonly FinanceKnowledgeEntry[] = [
  {
    id: 'apr',
    title: { zh: '年化成本与 APR', en: 'Annual borrowing cost and APR' },
    summary: {
      zh: '低月费不一定代表低成本。比较借款时，要同时看费用、还款时间与年化口径。',
      en: 'A low monthly fee does not always mean low cost. Compare charges, payment timing and the annual-rate convention.',
    },
    detail: {
      zh: 'APR 把利息和相关费用折算成年化参考率，具体计入口径依当地规则和条款。这里的分期工具按你录入的全部费用和逐月现金流估算有效年化成本；它不是机构报价，也不包含未录入费用。',
      en: 'APR expresses interest and relevant charges as an annual reference rate under applicable rules and terms. This calculator estimates an effective annual cost from the fees you enter and the monthly cash flows. It is not a lender quote and cannot include omitted fees.',
    },
    sources: [{
      title: { zh: '香港金管局：银行服务常见问题', en: 'HKMA: Banking FAQs' },
      url: 'https://www.hkma.gov.hk/eng/smart-consumers/frequently-asked-questions/',
    }], checkedAt,
  },
  {
    id: 'deposits-and-funds',
    title: { zh: '存款与基金的区别', en: 'Deposits and funds' },
    summary: {
      zh: '基金不是存款；购买渠道相同，也不代表本金保障和风险相同。',
      en: 'A fund is not a deposit. Buying through the same bank does not make their risks or protections identical.',
    },
    detail: {
      zh: '存款按账户约定计息；基金持有一组投资，其净值可能上涨或下跌，并可能收取管理等费用。决定前核对资金用途、取用限制和风险。存款保障有地区与产品条件，不能自动套用于基金。',
      en: 'Deposits pay interest under account terms. Funds hold investments whose values can rise or fall and may charge management and other fees. Check purpose, access restrictions and risks. Deposit protection has local and product conditions and does not automatically cover funds.',
    },
    sources: [{
      title: { zh: '香港投委会：债券与其他投资比较', en: 'IFEC: Bonds and other investments' },
      url: 'https://www.ifec.org.hk/web/tc/investment/investment-products/bonds/proxy-of-bonds.page',
    }], checkedAt,
  },
  {
    id: 'deductibles',
    title: { zh: '保险免赔额', en: 'Insurance deductibles' },
    summary: {
      zh: '免赔额通常是符合保单条件的费用中，需要自己先承担的部分。',
      en: 'A deductible is generally the part of an eligible expense you must pay before cover applies.',
    },
    detail: {
      zh: '免赔额也可能称自付额或垫底费。它可能按次、按年或按其他约定计算；超过免赔额仍须符合保障范围、赔偿上限和其他条款，不能理解为剩余账单一定全赔。',
      en: 'A deductible may apply per claim, per year or on another contractual basis. Expenses above it still need to satisfy coverage terms, benefit limits and other conditions; the entire remaining bill is not necessarily reimbursed.',
    },
    sources: [{
      title: { zh: '香港保险业监管局：医疗保险的作用', en: 'Insurance Authority: Medical insurance' },
      url: 'https://www.ia.org.hk/tc/medical_insurance/',
    }], checkedAt,
  },
  {
    id: 'waiting-periods',
    title: { zh: '保险等待期', en: 'Insurance waiting periods' },
    summary: {
      zh: '保单生效不一定意味着所有保障立即开始；某些保障设有等待期。',
      en: 'A policy start date does not mean every benefit starts immediately; some cover has a waiting period.',
    },
    detail: {
      zh: '等待期内的疾病或症状是否受保，要按具体条款判断。不同保障和疾病的期限、例外可能不同；更换保单可能重新计算。核对开始日、适用项目和除外责任，不能用一个通用天数替代合同。',
      en: 'Whether an illness or symptom during a waiting period is covered depends on the contract. Periods and exceptions can differ across benefits or conditions, and a replacement policy may restart them. Check start dates, affected benefits and exclusions instead of assuming one universal duration.',
    },
    sources: [{
      title: { zh: '香港保险业监管局：投保注意事项', en: 'Insurance Authority: Applying for medical insurance' },
      url: 'https://www.ia.org.hk/tc/medical_insurance/tips_on_applying_for_insurance.html',
    }], checkedAt,
  },
  {
    id: 'compound-interest',
    title: { zh: '复利如何工作', en: 'How compound interest works' },
    summary: {
      zh: '已获得的利息继续参与下一期计息，就是复利。',
      en: 'Compounding means previously earned interest also earns interest in later periods.',
    },
    detail: {
      zh: '假设利率和计息周期固定且利息留存，复利会随时间积累。实际结果还受利率变化、费用、税费和取款影响；投资回报可能为负，示例复利不能当作收益承诺。',
      en: 'With a fixed rate and compounding schedule, retained interest accumulates over time. Actual outcomes also depend on rate changes, fees, taxes and withdrawals. Investment returns can be negative; a compounding illustration is not a promise of returns.',
    }, sources: [savingsSource], checkedAt,
  },
  {
    id: 'cash-flow',
    title: { zh: '看清现金流', en: 'Understanding cash flow' },
    summary: {
      zh: '同一期间内，收入减去支出得到收支结余；它不等同于账户余额。',
      en: 'Income minus expenses over the same period gives a cash-flow surplus or shortfall, not an account balance.',
    },
    detail: {
      zh: '先完整记录同一期间的收支，再按分类检查。年度费用可在预算中分摊，但实际付款日仍会影响可用资金。避免把账户间互转重复当作新增收入，也要留意漏项和重复记录。',
      en: 'Record the full income and spending for one period before reviewing categories. Annual costs can be spread across a budget, but payment dates still affect available cash. Avoid treating transfers between your accounts as new income, and check missing or duplicate entries.',
    },
    sources: [{
      title: { zh: '香港投委会：开始制定预算', en: 'IFEC: Getting started with a budget' },
      url: 'https://www.ifec.org.hk/web/en/moneyessentials/budgeting.page',
    }], checkedAt,
  },
  {
    id: 'savings-goals',
    title: { zh: '把储蓄目标拆成每月行动', en: 'Turning a savings goal into monthly steps' },
    summary: {
      zh: '先确定目标、已有储蓄和每月可存金额，再估算所需时间。',
      en: 'Start with your target, existing savings and affordable monthly contribution to estimate the time needed.',
    },
    detail: {
      zh: '这里的工具仅用目标缺口除以固定月存金额，并向上取整到整月。它不预测收益、物价变化或收入增长；零月存且尚未达标时，按这些条件无法达到目标。',
      en: 'This tool divides the remaining gap by a fixed monthly contribution and rounds up to whole months. It predicts no returns, price changes or income growth. With no monthly contribution and a remaining gap, the target cannot be reached under these assumptions.',
    }, sources: [savingsSource], checkedAt,
  },
  {
    id: 'early-repayment',
    title: { zh: '提前还款先核对哪些数', en: 'What to check before repaying early' },
    summary: {
      zh: '提前还款是否省钱，要把可节省的未来费用与提前结清所需费用放在一起比较。',
      en: 'Compare the future charges you would avoid with the costs of settling the loan early.',
    },
    detail: {
      zh: '向机构索取指定日期的结清金额、费用明细和剩余还款计划。部分合同可能收提前还款费或不退部分费用；同时考虑结清后可用资金。这里的等额分期估算不代表真实合同的提前结清结果。',
      en: 'Ask the lender for a dated settlement amount, itemised charges and the remaining payment schedule. Some contracts charge for early repayment or retain certain fees. Consider the cash left afterward. This equal-installment estimate does not calculate a real contract’s settlement amount.',
    },
    sources: [{
      title: { zh: '香港投委会：负责任借贷', en: 'IFEC: Responsible borrowing' },
      url: 'https://www.ifec.org.hk/web/en/moneyessentials/debts-and-borrowing/before-you-borrow.page',
    }, {
      title: { zh: '香港消费者委员会：信用卡贷款费用', en: 'Consumer Council: Credit card loan charges' },
      url: 'https://www.consumer.org.hk/tc/article/542-credit-card-loan/542-credit-card-loan-charges',
    }], checkedAt,
  },
];

export function getFinanceKnowledge(id: string): FinanceKnowledgeEntry | undefined {
  return FINANCE_KNOWLEDGE.find((entry) => entry.id === id);
}

export function searchFinanceKnowledge(query: string): FinanceKnowledgeEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return FINANCE_KNOWLEDGE.filter((entry) => {
    const text = [entry.id, entry.title.zh, entry.title.en, entry.summary.zh, entry.summary.en,
      entry.detail.zh, entry.detail.en].join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
