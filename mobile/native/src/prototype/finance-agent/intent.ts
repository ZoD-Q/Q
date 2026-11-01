import { FINANCE_KNOWLEDGE } from './knowledge';
import { createFinanceTurn } from './copy';
import type { LocalFinanceTurn } from './conversation';

type Locale = 'zh' | 'en';
const topics: readonly [string, RegExp][] = [
  ['apr', /\bapr\b|年化|年利率/i],
  ['deposits-and-funds', /(?:存款.*基金|基金.*存款)|deposits?.*funds?|funds?.*deposits?/i],
  ['deductibles', /免赔|自付额|垫底费|deductible/i],
  ['waiting-periods', /等待期|waiting period/i],
  ['compound-interest', /复利|compound interest/i],
  ['cash-flow', /现金流|cash flow/i],
  ['savings-goals', /储蓄.*(?:方法|知识|是什么)|saving.*(?:basics|what|goal)/i],
  ['early-repayment', /提前还款|提前结清|early repay|early settlement/i],
];

const legacyTask = /账单|分期|储蓄|存钱|借款|还款|\bbills?\b|\binstallments?\b|\bsavings?\b/i;
const financialInput = /账单|分期|储蓄|存钱|收入|支出|保险|基金|投资|理财|借款|还款|本金|手续费|总费用|年利率|现金流|金融|市场|美股|加密货币|\bbills?\b|\binstallments?\b|\bsavings?\b|\bincome\b|\bexpenses?\b|\bapr\b|\bfinance\b|\bmarkets?\b|\bstocks?\b|\bcrypto\b/i;

/** Product questions are not retired personal calculation requests. This only
 * chooses the normal assistant path; it never grants access to any module. */
function appCapabilityQuestion(value: string): boolean {
  if (value.length > 200 || /[\d\n\r]|账单|收入|支出|本金|目标|\bbills?\b|\bincome\b|\bexpenses?\b/i.test(value)) return false;
  const zh = value.replace(/\s+/g, '').replace(/[？?。.!！]+$/, '');
  // Only a complete product question/navigation phrase is exempt. Appending a
  // private calculation, even with spelled-out amounts, stays on the local path.
  const chinese = /^(?:(?:请|帮我|给我|我想|想|可以|能否)?(?:(?:介绍|了解|解释|说明|查看|打开|进入)(?:一下)?)?)?(?:(?:小[qQ]|[Qq]|这个app|应用)的?)?(?:分期|储蓄)(?:模块|功能|入口)(?:的)?(?:(?:能|可以)(?:帮我|帮助我)?(?:做|干)什么|是干什么的|有什么功能|有什么用|怎么用|如何使用|在哪里|在哪|功能|用途|介绍|说明|用法|是什么)?$/i;
  if (chinese.test(zh)) return true;
  const en = value.trim().replace(/[?.!]+$/, '').replace(/\s+/g, ' ');
  const feature = '(?:the )?(?:q |app )?(?:installments?|savings?) (?:module|feature|page)';
  return new RegExp(`^(?:what can ${feature} (?:do|help with)|what does ${feature} do|how (?:do|can) I use ${feature}|(?:please )?(?:open|show|explain|describe|tell me about) ${feature}|${feature}(?: overview)?)$`, 'i').test(en);
}

function unavailableTask(prompt: string, locale: Locale): LocalFinanceTurn {
  return {
    prompt,
    answer: locale === 'zh'
      ? '账单整理、分期成本和储蓄目标工具已从首页移除，当前不再处理这些任务。已有结果仍可查看。\n\n这段输入仅留在本次本机会话，没有上传，也没有生成新计算结果。可以打开“金融知识”阅读基础概念；市场资料请从“金融数据”查看公开来源。'
      : 'Bill organization, installment costs and savings goals have been removed from the home page and are no longer processed here. Existing results remain available.\n\nThis input stays on this device for this session. Nothing was uploaded and no new calculation was generated. Open Financial knowledge for basic concepts or Financial data for public market sources.',
  };
}

/** Keep retired financial tasks local; removing an entry point must never forward its private input. */
export function respondToFinanceText(prompt: string, locale: Locale): LocalFinanceTurn | null {
  const value = prompt.trim();
  if (!value) return null;
  if (value.length > 24000) {
    return financialInput.test(value)
      ? { prompt, answer: locale === 'zh' ? '这份财务输入过长，已在本机停止处理，没有上传内容。账单、分期与储蓄工具当前不可用；请勿重新提交财务原文到 AI 对话。' : 'This financial input is too long and was stopped on this device. Nothing was uploaded. Bill, installment and savings tools are unavailable; do not resubmit private financial notes to AI chat.' }
      : null;
  }
  // Financial records take priority over a knowledge keyword elsewhere in the same input.
  if (/账单|\bbills?\b/i.test(value)
    || /(?:^|\n)\s*(?:收入|支出|income|expenses?)\s+.+\s+\S+/i.test(value)
    || (/(?:我的|本人|个人|工资|房租|my\s)/i.test(value) && /收入|支出|\bincome\b|\bexpenses?\b/i.test(value))
    || /分(?:成)?\s*\d+\s*期/u.test(value)
    || (/(?:本金|手续费|总费用)/u.test(value) && /\d/u.test(value))
    || (legacyTask.test(value) && /\d/u.test(value))) return unavailableTask(prompt, locale);
  if (appCapabilityQuestion(value)) return null;
  // Public-company and market research must not be mistaken for a personal budget task.
  if (/美股|A股|港股|财报|公告|宏观|新闻|热点|行情|股价|币价|加密货币|比特币|英伟达|苹果公司|微软|\bstocks?\b|\bcrypto\b|\bfilings?\b|\bearnings\b|\bnews\b|\bNVDA\b|\bAAPL\b|\bMSFT\b/i.test(value)) return null;
  const topic = topics.find(([, pattern]) => pattern.test(value));
  const entry = topic ? FINANCE_KNOWLEDGE.find(item => item.id === topic[0]) : undefined;
  if (entry) return { ...createFinanceTurn({ kind: 'knowledge', entry }, locale), prompt };
  if (legacyTask.test(value)) return unavailableTask(prompt, locale);
  return null;
}

/** Public task guidance only. It contains no local financial notes or advertising data. */
export const FINANCIAL_AI_GUIDANCE = 'You are Q, a source-based market research and financial knowledge assistant. Explain in the user\'s language and distinguish sourced facts, inferences and scenarios. Current prices, market moves and news conclusions require relevant tool results or evidence explicitly supplied by the user; memory alone is not current evidence. Cite the actual source and link when available, state the data or publication timestamp with timezone, and distinguish it from retrieval time. Report known delays, missing timestamps and freshness limits; never label data real-time unless the evidence establishes that. If evidence is missing, say what is unknown and ask for a source or a data lookup without inventing quotes or news. A provider name or public website is not proof of a connected API, subscription or live feed. Do not claim connections to Jin10, Tonghuashun or any other vendor unless a tool result establishes the specific access. Do not use advertising as evidence, promise returns or trade outcomes, or claim to submit applications or execute transactions. You have no access to this device\'s local bills or calculations. Bill organization, installment-cost and savings-goal tools are unavailable from the home page; do not tell users to open them or to upload private records.';
