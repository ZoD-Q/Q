import type { KnowledgeResult } from './knowledge';

export type Currency = 'CNY' | 'HKD';
export type FinanceText = { zh: string; en: string };
export type FinanceInputError = {
  code: string;
  field?: string;
  line?: number;
  message: FinanceText;
};
export type FinanceOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FinanceInputError[] };

export const MAX_MONEY_MINOR = Number.MAX_SAFE_INTEGER;
export const MAX_BILL_ENTRIES = 500;
export const MAX_INSTALLMENT_MONTHS = 60;
const MAX_MONEY_DIGITS = String(MAX_MONEY_MINOR);
const MAX_BILL_TEXT_LENGTH = 50_000;

export type BillDirection = 'income' | 'expense';
export type BillEntry = {
  line: number;
  direction: BillDirection;
  category: string;
  amountMinor: number;
};
export type BillCategory = {
  direction: BillDirection;
  category: string;
  amountMinor: number;
  count: number;
};
export type BillSummary = {
  kind: 'bills';
  currency: Currency;
  entries: BillEntry[];
  totalIncomeMinor: number;
  totalExpenseMinor: number;
  netMinor: number;
  categories: BillCategory[];
  warnings: { code: 'duplicate'; lines: number[] }[];
};
export type InstallmentInput = {
  currency: Currency;
  principal: string;
  feeTotal: string;
  months: number | string;
};
export type InstallmentPayment = { month: number; amountMinor: number };
export type InstallmentResult = {
  kind: 'installments';
  currency: Currency;
  principalMinor: number;
  feeTotalMinor: number;
  totalRepaymentMinor: number;
  months: number;
  payments: InstallmentPayment[];
  minPaymentMinor: number;
  maxPaymentMinor: number;
  /** Decimal rate, not a percentage. Payment one is one month after drawdown. */
  monthlyRate: number;
  /** Effective annual IRR estimate: (1 + monthlyRate)^12 - 1, not a lender quote. */
  effectiveAnnualRate: number;
};
export type SavingsInput = {
  currency: Currency;
  target: string;
  current: string;
  monthly: string;
};
export type SavingsResult = {
  kind: 'savings';
  currency: Currency;
  targetMinor: number;
  currentMinor: number;
  monthlyMinor: number;
  remainingMinor: number;
  monthsToTarget: number | null;
  alreadyReached: boolean;
  reachable: boolean;
};
export type FinanceResult = BillSummary | InstallmentResult | SavingsResult | KnowledgeResult;

function error(code: string, zh: string, en: string, field?: string, line?: number): FinanceInputError {
  return {
    code,
    message: { zh, en },
    ...(field === undefined ? {} : { field }),
    ...(line === undefined ? {} : { line }),
  };
}

function currencyError(currency: Currency): FinanceInputError[] {
  return currency === 'CNY' || currency === 'HKD' ? [] : [error(
    'invalid_currency', '请选择人民币或港币，整份输入使用同一币种。',
    'Choose CNY or HKD and use that currency throughout.', 'currency',
  )];
}

/** Strict decimal input; no floating-point multiplication, rounding or currency inference. */
export function parseMoneyToMinor(input: string): FinanceOutcome<number> {
  if (typeof input !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(input.trim())) {
    return { ok: false, errors: [error(
      'invalid_money', '金额须为非负数字，最多两位小数，不含货币符号、逗号或指数。',
      'Use a non-negative amount with at most two decimal places, without currency symbols, commas or exponents.',
    )] };
  }
  const [whole, fraction = ''] = input.trim().split('.');
  const digits = `${whole}${fraction.padEnd(2, '0')}`.replace(/^0+/, '') || '0';
  if (digits.length > MAX_MONEY_DIGITS.length
    || (digits.length === MAX_MONEY_DIGITS.length && digits > MAX_MONEY_DIGITS)) {
    return { ok: false, errors: [error(
      'money_overflow', '金额超出可精确计算的范围。', 'This amount exceeds the exact calculation range.',
    )] };
  }
  return { ok: true, value: Number(digits) };
}

function moneyField(input: string, field: string): FinanceOutcome<number> {
  const result = parseMoneyToMinor(input);
  return result.ok ? result : {
    ok: false, errors: result.errors.map((item) => ({ ...item, field })),
  };
}

/** Every non-empty line must be valid before a summary can be returned. */
export function summarizeBills(input: string, currency: Currency): FinanceOutcome<BillSummary> {
  const errors = currencyError(currency);
  if (typeof input !== 'string' || input.length > MAX_BILL_TEXT_LENGTH) {
    return { ok: false, errors: [...errors, error(
      'bill_input_limit', '一次最多输入 50,000 个字符和 500 条账单。',
      'Enter at most 50,000 characters and 500 bill entries at a time.', 'bills',
    )] };
  }
  const lines = input.split(/\r\n|\n|\r/);
  const entries: BillEntry[] = [];
  let nonEmptyCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text) continue;
    nonEmptyCount += 1;
    const line = index + 1;
    if (nonEmptyCount > MAX_BILL_ENTRIES) {
      errors.push(error('bill_entry_limit', '一次最多整理 500 条账单，请拆分后重试。',
        'Process at most 500 bill entries at a time; split the input and retry.', 'bills', line));
      break;
    }
    const match = /^(\S+)\s+(.+?)\s+(\S+)$/.exec(text);
    if (!match) {
      errors.push(error('bill_format', '请按“收入/支出 分类 金额”填写，例如“支出 餐饮 38.50”。',
        'Use “income/expense category amount”, for example “expense Food 38.50”.', 'bills', line));
      continue;
    }
    const keyword = match[1].toLowerCase();
    const direction = keyword === '收入' || keyword === 'income' ? 'income'
      : keyword === '支出' || keyword === 'expense' ? 'expense' : undefined;
    if (!direction) {
      errors.push(error('bill_direction', '每行须明确标明“收入”或“支出”。',
        'Start each line with “income” or “expense”.', 'bills', line));
      continue;
    }
    const category = match[2].replace(/\s+/g, ' ').trim();
    if (category.length > 64 || /[\u0000-\u001f\u007f]/.test(category)) {
      errors.push(error('bill_category', '分类须为 1–64 个可显示字符。',
        'Use 1–64 visible characters for the category.', 'bills', line));
      continue;
    }
    // Currency tokens cannot silently become part of a category and hide mixed input.
    if (/[$¥￥€£]|\b(?:CNY|HKD|USD|RMB|EUR|GBP|JPY|QDC)\b|人民币|人民幣|港币|港幣|美元/i.test(category)) {
      errors.push(error('bill_currency', '请在上方统一选择币种，行内仅填写分类与纯数字金额，不混合币种或演示钱包。',
        'Select one currency above; use a category and plain amount on each line, without mixed currencies or demo wallets.', 'bills', line));
      continue;
    }
    const amount = parseMoneyToMinor(match[3]);
    if (!amount.ok) {
      errors.push(...amount.errors.map((item) => ({ ...item, field: 'bills', line })));
      continue;
    }
    entries.push({ line, direction, category, amountMinor: amount.value });
  }
  if (nonEmptyCount === 0) {
    errors.push(error('empty_bills', '请至少输入一条账单。', 'Enter at least one bill entry.', 'bills'));
  }
  let totalIncomeMinor = 0;
  let totalExpenseMinor = 0;
  const categories = new Map<string, BillCategory>();
  const duplicateLines = new Map<string, number[]>();
  for (const entry of entries) {
    const subtotal = entry.direction === 'income' ? totalIncomeMinor : totalExpenseMinor;
    if (entry.amountMinor > MAX_MONEY_MINOR - subtotal) {
      errors.push(error('bill_total_overflow', '收入或支出合计超出可精确计算的范围。',
        'The income or expense total exceeds the exact calculation range.', 'bills', entry.line));
      continue;
    }
    if (entry.direction === 'income') totalIncomeMinor += entry.amountMinor;
    else totalExpenseMinor += entry.amountMinor;
    const key = JSON.stringify([entry.direction, entry.category]);
    const category = categories.get(key) ?? { direction: entry.direction, category: entry.category, amountMinor: 0, count: 0 };
    category.amountMinor += entry.amountMinor;
    category.count += 1;
    categories.set(key, category);
    const duplicateKey = JSON.stringify([entry.direction, entry.category, entry.amountMinor]);
    duplicateLines.set(duplicateKey, [...(duplicateLines.get(duplicateKey) ?? []), entry.line]);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: {
    kind: 'bills', currency, entries, totalIncomeMinor, totalExpenseMinor,
    netMinor: totalIncomeMinor - totalExpenseMinor,
    categories: [...categories.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    warnings: [...duplicateLines.values()].filter((group) => group.length > 1)
      .map((group) => ({ code: 'duplicate', lines: group })),
  } };
}

function installmentMonths(input: number | string): FinanceOutcome<number> {
  const months = typeof input === 'number' ? input
    : typeof input === 'string' && /^\d{1,3}$/.test(input.trim()) ? Number(input.trim()) : NaN;
  if (!Number.isInteger(months) || months < 1 || months > MAX_INSTALLMENT_MONTHS) {
    return { ok: false, errors: [error('invalid_months', '分期期数须为 1–60 的整数。',
      'Enter a whole number of months from 1 to 60.', 'months')] };
  }
  return { ok: true, value: months };
}

function monthlyIrr(principalMinor: number, feeTotalMinor: number, payments: InstallmentPayment[]): number {
  if (feeTotalMinor === 0) return 0;
  if (payments.length === 1) return feeTotalMinor / principalMinor;
  let low = 0;
  let high = feeTotalMinor / principalMinor;
  // The discount-loss form avoids cancellation for one-cent fees on large loans.
  const useDiscountLoss = feeTotalMinor / principalMinor < 0.1;
  for (let iteration = 0; iteration < 180; iteration += 1) {
    const rate = low + (high - low) / 2;
    const logGrowth = Math.log1p(rate);
    const value = payments.reduce((sum, payment) => sum + payment.amountMinor * (
      useDiscountLoss ? -Math.expm1(-payment.month * logGrowth) : Math.exp(-payment.month * logGrowth)
    ), 0);
    const tooHigh = useDiscountLoss ? value > feeTotalMinor : value < principalMinor;
    if (tooHigh) high = rate;
    else low = rate;
  }
  return low + (high - low) / 2;
}

/** All recorded fees are paid in installments; no up-front deduction or irregular dates. */
export function calculateInstallments(input: InstallmentInput): FinanceOutcome<InstallmentResult> {
  const principal = moneyField(input.principal, 'principal');
  const fees = moneyField(input.feeTotal, 'feeTotal');
  const term = installmentMonths(input.months);
  const errors = currencyError(input.currency);
  if (!principal.ok) errors.push(...principal.errors);
  else if (principal.value === 0) errors.push(error('zero_principal', '本金须大于零。', 'Principal must be greater than zero.', 'principal'));
  if (!fees.ok) errors.push(...fees.errors);
  if (!term.ok) errors.push(...term.errors);
  if (errors.length || !principal.ok || !fees.ok || !term.ok) return { ok: false, errors };
  if (principal.value > MAX_MONEY_MINOR - fees.value) {
    return { ok: false, errors: [error('repayment_overflow', '本金加总费用超出可精确计算的范围。',
      'Principal plus total fees exceeds the exact calculation range.', 'feeTotal')] };
  }
  const totalRepaymentMinor = principal.value + fees.value;
  const base = Math.floor(totalRepaymentMinor / term.value);
  const remainder = totalRepaymentMinor % term.value;
  const payments = Array.from({ length: term.value }, (_, index) => ({
    month: index + 1, amountMinor: base + (index < remainder ? 1 : 0),
  }));
  const monthlyRate = monthlyIrr(principal.value, fees.value, payments);
  return { ok: true, value: {
    kind: 'installments', currency: input.currency, principalMinor: principal.value,
    feeTotalMinor: fees.value, totalRepaymentMinor, months: term.value, payments,
    minPaymentMinor: base, maxPaymentMinor: base + (remainder > 0 ? 1 : 0),
    monthlyRate, effectiveAnnualRate: Math.expm1(12 * Math.log1p(monthlyRate)),
  } };
}

/** Fixed monthly additions only; assumes no interest, investment returns, fees or withdrawals. */
export function calculateSavings(input: SavingsInput): FinanceOutcome<SavingsResult> {
  const target = moneyField(input.target, 'target');
  const current = moneyField(input.current, 'current');
  const monthly = moneyField(input.monthly, 'monthly');
  const errors = currencyError(input.currency);
  if (!target.ok) errors.push(...target.errors);
  if (!current.ok) errors.push(...current.errors);
  if (!monthly.ok) errors.push(...monthly.errors);
  if (errors.length || !target.ok || !current.ok || !monthly.ok) return { ok: false, errors };
  const remainingMinor = Math.max(0, target.value - current.value);
  const alreadyReached = remainingMinor === 0;
  const reachable = alreadyReached || monthly.value > 0;
  const monthsToTarget = alreadyReached ? 0 : monthly.value === 0 ? null
    : Math.floor(remainingMinor / monthly.value) + (remainingMinor % monthly.value > 0 ? 1 : 0);
  return { ok: true, value: {
    kind: 'savings', currency: input.currency, targetMinor: target.value,
    currentMinor: current.value, monthlyMinor: monthly.value, remainingMinor,
    monthsToTarget, alreadyReached, reachable,
  } };
}
