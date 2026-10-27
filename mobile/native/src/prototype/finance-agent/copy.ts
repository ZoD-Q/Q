import type { LocaleId } from '../design';
import type { Currency, FinanceResult, FinanceText } from './core';
import type { LocalFinanceTurn } from './conversation';

export type FinanceTask = 'bills' | 'installments' | 'savings' | 'knowledge';

export const TASK_LABELS: Record<FinanceTask, FinanceText> = {
  bills: { zh: '整理账单', en: 'Organize bills' },
  installments: { zh: '分期成本', en: 'Installment cost' },
  savings: { zh: '储蓄目标', en: 'Savings goal' },
  knowledge: { zh: '金融知识', en: 'Financial basics' },
};

export const FINANCE_PRIVACY: FinanceText = {
  zh: '仅在本次本地会话中使用。登录、退出、切换账号或刷新后清除；不会自动发送给 AI。关闭表单会清除未提交的输入。',
  en: 'For this local session only. Cleared on sign-in, sign-out, account changes or refresh; never sent to AI automatically. Closing the form clears unsubmitted input.',
};

export const INSTALLMENT_ASSUMPTIONS: FinanceText = {
  zh: '假设现在一次收到全部本金，1 个月后开始还款，此后每月一次。本金与已填费用一起均摊，分币余数优先计入前几期。年化按实际月度现金流测算，不是机构报价；未填入的费用不计入。',
  en: 'Assumes the full principal is received now, with the first payment one month later and monthly payments thereafter. Principal and entered fees are spread evenly; extra cents go to earlier payments. The annual rate is calculated from these cash flows, not a lender quote. Unentered fees are excluded.',
};

export const BILL_EXAMPLE: FinanceText = {
  zh: '收入 工资 12000\n支出 房租 3000\n支出 餐饮 1250.50\n支出 交通 300\n支出 餐饮 180',
  en: 'income Salary 12000\nexpense Rent 3000\nexpense Food 1250.50\nexpense Transport 300\nexpense Food 180',
};

export function financeText(value: FinanceText, locale: LocaleId): string {
  return value[locale];
}

export function formatFinanceMoney(minor: number, currency: Currency, locale: LocaleId): string {
  const magnitude = Math.abs(minor);
  const whole = Math.floor(magnitude / 100).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  const cents = String(magnitude % 100).padStart(2, '0');
  return `${currency} ${minor < 0 ? '-' : ''}${whole}.${cents}`;
}

export function formatFinanceRate(rate: number): string {
  return `${(rate * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function createFinanceTurn(result: FinanceResult, locale: LocaleId): LocalFinanceTurn {
  const zh = locale === 'zh';
  const money = (value: number, currency: Currency) => formatFinanceMoney(value, currency, locale);
  switch (result.kind) {
    case 'bills':
      return {
        prompt: zh ? `整理这 ${result.entries.length} 笔 ${result.currency} 账单。` : `Organize these ${result.entries.length} ${result.currency} bill entries.`,
        answer: zh
          ? `已按收入与支出整理。结余为 ${money(result.netMinor, result.currency)}，仅依据你输入的记录。`
          : `Organized by income and expense. The net is ${money(result.netMinor, result.currency)}, based only on the entries you provided.`,
        result,
      };
    case 'installments':
      return {
        prompt: zh
          ? `计算 ${money(result.principalMinor, result.currency)} 本金、总费用 ${money(result.feeTotalMinor, result.currency)}、${result.months} 期的成本。`
          : `Calculate ${result.months} payments on ${money(result.principalMinor, result.currency)}, with ${money(result.feeTotalMinor, result.currency)} in total fees.`,
        answer: zh ? '已按填写的本金、费用和期数计算，下面列出总还款额、测算年化与还款明细。' : 'Calculated from your principal, fees and term. Total repayment, estimated annual rate and the payment schedule are below.',
        result,
      };
    case 'savings':
      return {
        prompt: zh
          ? `储蓄目标 ${money(result.targetMinor, result.currency)}，现有 ${money(result.currentMinor, result.currency)}，每月存入 ${money(result.monthlyMinor, result.currency)}。`
          : `Plan a ${money(result.targetMinor, result.currency)} savings goal, starting with ${money(result.currentMinor, result.currency)} and saving ${money(result.monthlyMinor, result.currency)} monthly.`,
        answer: zh ? '已按固定月存入金额测算，不计利息、投资收益或物价变化。' : 'Calculated using a fixed monthly contribution, without interest, investment returns or price changes.',
        result,
      };
    case 'knowledge':
      return {
        prompt: financeText(result.entry.title, locale),
        answer: financeText(result.entry.summary, locale),
        result,
      };
  }
}
