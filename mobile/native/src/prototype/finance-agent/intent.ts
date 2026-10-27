import { calculateInstallments, calculateSavings, summarizeBills, type Currency, type FinanceOutcome, type FinanceResult } from './core';
import { FINANCE_KNOWLEDGE } from './knowledge';
import { createFinanceTurn } from './copy';
import { localFinanceHelp, type LocalFinanceTurn } from './conversation';

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

function resultTurn(prompt: string, result: FinanceOutcome<FinanceResult>, locale: Locale): LocalFinanceTurn {
  if (result.ok) return { ...createFinanceTurn(result.value, locale), prompt };
  return {
    prompt,
    answer: (locale === 'zh' ? '还不能完成计算，请核对输入：\n' : 'Please correct the input before calculating:\n')
      + result.errors.slice(0, 8).map(error => `${error.line ? (locale === 'zh' ? `第 ${error.line} 行：` : `Line ${error.line}: `) : ''}${error.message[locale]}`).join('\n')
      + (locale === 'zh' ? '\n\n也可以打开“财务工具”逐项填写。本次没有生成汇总或发送内容。' : '\n\nYou can also use Financial tools. No summary was generated and nothing was sent.'),
  };
}

/** Bounded, explicit input formats. Unrecognized financial text asks for fields; it is never guessed. */
export function respondToFinanceText(prompt: string, locale: Locale): LocalFinanceTurn | null {
  const value = prompt.trim();
  if (!value) return null;
  if (value.length > 24000) {
    return /账单|分期|储蓄|收入|支出|保险|基金|理财|\bbills?\b|\binstallments?\b|\bsavings?\b|\bincome\b|\bexpense\b|\bapr\b/i.test(value)
      ? { prompt, answer: locale === 'zh' ? '这份财务输入过长，请拆分后在本地财务工具中处理。没有上传内容。' : 'Split this financial input into smaller local tasks. Nothing was uploaded.' }
      : null;
  }
  const canonicalInstallment = /^(?:分期|installments?)\s+(CNY|HKD)\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(value);
  if (canonicalInstallment) {
    const [, currency, principal, months, feeTotal] = canonicalInstallment;
    return resultTurn(prompt, calculateInstallments({ currency: currency.toUpperCase() as Currency, principal, months, feeTotal }), locale);
  }
  const naturalInstallment = /^(?:(?:请|帮我)?(?:算一下|计算|算)\s*)?(?:分期[：:]?\s*)?(CNY|HKD|人民币|港币)?\s*(\d+(?:\.\d+)?)\s*元?\s*[,，]?\s*分(?:成)?\s*(\d+)\s*期\s*[,，]?\s*(?:总费用|总手续费|手续费)\s*(?:为|是|[:：])?\s*(\d+(?:\.\d+)?)\s*元?[。]?$/i.exec(value);
  if (naturalInstallment) {
    const [, unit, principal, months, feeTotal] = naturalInstallment;
    const currency: Currency = unit?.toUpperCase() === 'HKD' || unit === '港币' ? 'HKD' : 'CNY';
    return resultTurn(prompt, calculateInstallments({ currency, principal, months, feeTotal }), locale);
  }
  const saving = /^(?:储蓄|savings?)\s+(CNY|HKD)\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(value);
  if (saving) {
    const [, currency, target, current, monthly] = saving;
    return resultTurn(prompt, calculateSavings({ currency: currency.toUpperCase() as Currency, target, current, monthly }), locale);
  }
  const bills = /^(?:账单|bills?)\s+(CNY|HKD)\s*\r?\n([\s\S]+)$/i.exec(value);
  if (bills) return resultTurn(prompt, summarizeBills(bills[2], bills[1].toUpperCase() as Currency), locale);
  if (/(?:收入|支出|\bincome\b|\bexpense\b)/i.test(value)) {
    return {
      prompt,
      answer: locale === 'zh'
        ? '我看到你输入了账单记录。请先明确币种：在第一行写“账单 CNY”或“账单 HKD”，每条记录另起一行，例如“支出 餐饮 38.50”。也可以打开“财务工具”整理。不会把不同币种合并，也不会上传这些记录。'
        : 'Please specify the currency with “bills CNY” or “bills HKD” on the first line, followed by one entry per line, for example “expense Food 38.50”. You can also open Financial tools. These entries are not uploaded or combined across currencies.',
    };
  }
  const topic = topics.find(([, pattern]) => pattern.test(value));
  const entry = topic ? FINANCE_KNOWLEDGE.find(item => item.id === topic[0]) : undefined;
  if (entry) return { ...createFinanceTurn({ kind: 'knowledge', entry }, locale), prompt };
  if (/账单|分期|储蓄|存钱|免赔|还款|借款|保险|基金|投资|理财|\bbills?\b|\binstallments?\b|\bsavings?\b|\binsurance\b/i.test(value)) {
    const help = localFinanceHelp(locale, prompt);
    return { ...help, answer: (locale === 'zh'
      ? '我可以帮你整理账单、解释通用知识和做确定性计算，不会猜测机构报价或推荐具体在售产品。\n\n快速输入示例：\n分期 CNY 8000 12 240\n（本金 8000、12 期、全部费用合计 240）\n储蓄 CNY 50000 10000 2000\n（目标 50000、现有 10000、每月存入 2000）\n\n'
      : 'I can organize bills, explain general concepts and calculate from explicit inputs. I do not invent quotes or recommend specific products.\n\nExamples:\ninstallment CNY 8000 12 240\n(principal 8000, 12 payments, total fees 240)\nsavings CNY 50000 10000 2000\n(target 50000, current 10000, monthly 2000)\n\n') + help.answer };
  }
  return null;
}

/** Public task guidance only. It contains no local financial notes or advertising data. */
export const FINANCIAL_AI_GUIDANCE = 'You are Q, a financial literacy assistant. Explain general financial concepts in the user\'s language, distinguish facts from assumptions, and ask for missing inputs. Do not invent account balances, live rates, quotes, approvals, insurance coverage or guaranteed returns. Do not recommend a specific financial product or use advertising as evidence. You have no access to this device\'s local bills or calculations. For numeric cost or savings calculations, direct the user to Q\'s on-device Financial tools, which use explicit inputs and assumptions. Do not claim to submit applications, buy products or execute financial transactions.';
