import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateInstallments, calculateSavings, MAX_BILL_ENTRIES, MAX_MONEY_MINOR,
  parseMoneyToMinor, summarizeBills,
} from './core.ts';

function value(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value;
}

function failure(outcome, code) {
  assert.equal(outcome.ok, false);
  assert.equal('value' in outcome, false, 'an invalid input must never expose a partial result');
  assert.ok(outcome.errors.some((item) => item.code === code), JSON.stringify(outcome));
  return outcome.errors;
}

function money(minor) {
  const digits = BigInt(minor).toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

test('money parsing uses exact decimal cents including the safe-integer boundary', () => {
  for (const [input, expected] of [
    ['0', 0], ['0.01', 1], ['00001.20', 120], [' 12.3 ', 1230], ['1.01', 101],
    ['90071992547409.91', MAX_MONEY_MINOR], ['90071992547409.90', MAX_MONEY_MINOR - 1],
  ]) assert.equal(value(parseMoneyToMinor(input)), expected);
  for (const input of ['90071992547409.92', '90071992547410', '999999999999999999999']) {
    failure(parseMoneyToMinor(input), 'money_overflow');
  }
});

test('money parsing rejects signs, exponents, excess precision, non-finite and currency input', () => {
  for (const input of ['', ' ', '-1', '-0', '+1', '1e2', '1E+2', '1.001', '1.', '.5',
    '1,000', '1 000', '￥12', 'HK$12', '12元', 'NaN', 'Infinity', '0x10', '１２', 12, null, undefined]) {
    failure(parseMoneyToMinor(input), 'invalid_money');
  }
});

test('bills sum in cents and keep income, expense and category identities separate', () => {
  const summary = value(summarizeBills('收入 工资 12000\n支出 房租 3000\n支出 餐饮 980.50\n收入 餐饮 10.05', 'CNY'));
  assert.equal(summary.kind, 'bills');
  assert.equal(summary.totalIncomeMinor, 1201005);
  assert.equal(summary.totalExpenseMinor, 398050);
  assert.equal(summary.netMinor, 802955);
  assert.equal(summary.categories.length, 4);
  assert.deepEqual(summary.warnings, []);
  const small = value(summarizeBills('expense Food 0.1\nexpense Food 0.2', 'HKD'));
  assert.equal(small.totalExpenseMinor, 30);
  assert.equal(small.netMinor, -30);
  assert.equal(small.categories[0].amountMinor, 30);
});

test('English labels, category spaces, empty lines and all newline styles retain original line numbers', () => {
  const summary = value(summarizeBills('\nINCOME Part time work 100\r\n\rExpense Public transport 12.50\r', 'HKD'));
  assert.deepEqual(summary.entries.map((entry) => entry.line), [2, 4]);
  assert.equal(summary.entries[0].category, 'Part time work');
  assert.equal(summary.currency, 'HKD');
});

test('invalid bills report all bad line numbers and never silently return valid lines', () => {
  const outcome = summarizeBills('收入 工资 12000\n坏行\n支出 房租 -3\n收入 奖金 1e2\n转账 存款 20\n支出 餐饮 1.001', 'CNY');
  const errors = failure(outcome, 'bill_format');
  assert.deepEqual(errors.map((item) => item.line), [2, 3, 4, 5, 6]);
  assert.ok(errors.every((item) => item.message.zh && item.message.en));
});

test('duplicate rows are retained in totals and are only flagged for review', () => {
  const summary = value(summarizeBills('支出 餐饮 20\n\n支出 餐饮 20.00\n支出 餐饮 20\n收入 餐饮 20', 'CNY'));
  assert.equal(summary.entries.length, 4);
  assert.equal(summary.totalExpenseMinor, 6000);
  assert.equal(summary.totalIncomeMinor, 2000);
  assert.deepEqual(summary.warnings, [{ code: 'duplicate', lines: [1, 3, 4] }]);
});

test('bill input rejects empty data, overflow, currency inference and oversized batches', () => {
  failure(summarizeBills('\n  \r', 'CNY'), 'empty_bills');
  const errors = failure(summarizeBills('收入 工资 90071992547409.91\n收入 奖金 0.01', 'CNY'), 'bill_total_overflow');
  assert.equal(errors[0].line, 2);
  const largest = value(summarizeBills('收入 工资 90071992547409.91\n支出 房租 90071992547409.91', 'CNY'));
  assert.equal(largest.netMinor, 0);
  failure(summarizeBills('income salary 1', 'USD'), 'invalid_currency');
  for (const text of ['expense HKD Food 20', '支出 港币餐饮 30', 'expense QDC wallet 10']) {
    failure(summarizeBills(text, 'CNY'), 'bill_currency');
  }
  failure(summarizeBills('expense Food 20 USD', 'HKD'), 'invalid_money');
  const lines = Array(MAX_BILL_ENTRIES).fill('支出 餐饮 1');
  assert.equal(value(summarizeBills(lines.join('\n'), 'CNY')).entries.length, MAX_BILL_ENTRIES);
  failure(summarizeBills([...lines, '支出 餐饮 1'].join('\n'), 'CNY'), 'bill_entry_limit');
  failure(summarizeBills('x'.repeat(50_001), 'CNY'), 'bill_input_limit');
});

test('installments allocate integer remainder to earliest months without losing any cents', () => {
  const result = value(calculateInstallments({ currency: 'CNY', principal: '1', feeTotal: '0', months: 3 }));
  assert.deepEqual(result.payments, [
    { month: 1, amountMinor: 34 }, { month: 2, amountMinor: 33 }, { month: 3, amountMinor: 33 },
  ]);
  assert.equal(result.minPaymentMinor, 33);
  assert.equal(result.maxPaymentMinor, 34);
  assert.equal(result.monthlyRate, 0);
  assert.equal(result.effectiveAnnualRate, 0);
  for (let months = 1; months <= 60; months += 1) {
    for (const total of [1, 7, 101, 12345, MAX_MONEY_MINOR - 1, MAX_MONEY_MINOR]) {
      const calculated = value(calculateInstallments({ currency: 'HKD', principal: money(total), feeTotal: '0', months }));
      assert.equal(calculated.payments.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n), BigInt(total));
      assert.ok(calculated.payments.every((item) => Number.isSafeInteger(item.amountMinor) && item.amountMinor >= 0));
      assert.ok(calculated.maxPaymentMinor - calculated.minPaymentMinor <= 1);
      assert.equal(calculated.minPaymentMinor, Number(BigInt(total) / BigInt(months)));
    }
  }
});

test('IRR discounts the exact monthly payment schedule back to the full principal', () => {
  for (const [principal, feeTotal, months] of [
    ['10000', '600', 12], ['9999.99', '777.77', 24], ['30000', '5000', 60], ['0.01', '0.01', 60],
    ['0.01', '90071992547409.90', 2], ['90071992547409.90', '0.01', 60],
  ]) {
    const result = value(calculateInstallments({ currency: 'HKD', principal, feeTotal, months }));
    const presentValue = result.payments.reduce((sum, payment) => sum + payment.amountMinor / ((1 + result.monthlyRate) ** payment.month), 0);
    assert.ok(Math.abs(presentValue - result.principalMinor) <= Math.max(1e-7, result.principalMinor * 1e-13), `${principal}, ${feeTotal}, ${months}: ${presentValue}`);
    assert.ok(result.monthlyRate > 0);
    assert.ok(Number.isFinite(result.effectiveAnnualRate));
    assert.ok(result.effectiveAnnualRate > 0);
    const discountedFee = result.payments.reduce((sum, payment) => sum + payment.amountMinor * -Math.expm1(-payment.month * Math.log1p(result.monthlyRate)), 0);
    assert.ok(Math.abs(discountedFee - result.feeTotalMinor) <= Math.max(1e-7, result.feeTotalMinor * 1e-13));
  }
});

test('single-month IRR annualises the known one-period return and zero fees remain exactly zero', () => {
  const single = value(calculateInstallments({ currency: 'CNY', principal: '100', feeTotal: '10', months: '1' }));
  assert.equal(single.monthlyRate, 0.1);
  assert.ok(Math.abs(single.effectiveAnnualRate - (1.1 ** 12 - 1)) < 1e-12);
  assert.equal(single.totalRepaymentMinor, 11000);
  for (const months of [1, 12, 60]) {
    const noFee = value(calculateInstallments({ currency: 'CNY', principal: '123.45', feeTotal: '0', months }));
    assert.equal(noFee.monthlyRate, 0);
    assert.equal(noFee.effectiveAnnualRate, 0);
  }
});

test('installments validate all fields, supported currency, term bounds and total overflow', () => {
  const base = { currency: 'CNY', principal: '100', feeTotal: '0', months: 12 };
  for (const months of [0, -1, 61, 1.5, NaN, Infinity, '', '1e1', '1.0', '12 months']) {
    failure(calculateInstallments({ ...base, months }), 'invalid_months');
  }
  failure(calculateInstallments({ ...base, principal: '0' }), 'zero_principal');
  failure(calculateInstallments({ ...base, feeTotal: '-1' }), 'invalid_money');
  failure(calculateInstallments({ ...base, principal: '90071992547409.91', feeTotal: '0.01' }), 'repayment_overflow');
  failure(calculateInstallments({ ...base, currency: 'QDC' }), 'invalid_currency');
  const errors = failure(calculateInstallments({ ...base, principal: '-1', feeTotal: '1.234', months: 100 }), 'invalid_money');
  assert.deepEqual(errors.map((item) => item.field), ['principal', 'feeTotal', 'months']);
});

test('savings rounds up months using a fixed contribution without predicting returns', () => {
  const base = { currency: 'CNY', target: '10000', current: '1000', monthly: '2000' };
  const result = value(calculateSavings(base));
  assert.equal(result.remainingMinor, 900000);
  assert.equal(result.monthsToTarget, 5);
  assert.equal(result.reachable, true);
  assert.equal(result.alreadyReached, false);
  assert.equal(value(calculateSavings({ ...base, current: '2000' })).monthsToTarget, 4);
  assert.equal(value(calculateSavings({ ...base, target: '0.03', current: '0.01', monthly: '0.01' })).monthsToTarget, 2);
});

test('savings distinguishes already achieved and unreachable goals, including exact safe boundaries', () => {
  for (const current of ['100', '200']) {
    const result = value(calculateSavings({ currency: 'HKD', target: '100', current, monthly: '0' }));
    assert.equal(result.monthsToTarget, 0);
    assert.equal(result.alreadyReached, true);
    assert.equal(result.reachable, true);
    assert.equal(result.remainingMinor, 0);
  }
  const unreachable = value(calculateSavings({ currency: 'HKD', target: '100', current: '0', monthly: '0' }));
  assert.equal(unreachable.monthsToTarget, null);
  assert.equal(unreachable.reachable, false);
  const largest = value(calculateSavings({ currency: 'HKD', target: '90071992547409.91', current: '0', monthly: '0.01' }));
  assert.equal(largest.monthsToTarget, MAX_MONEY_MINOR);
  for (const monthly of [2, 3, 7, 60, 10000]) {
    const result = value(calculateSavings({ currency: 'CNY', target: money(MAX_MONEY_MINOR), current: '0', monthly: money(monthly) }));
    assert.equal(result.monthsToTarget, Number((BigInt(MAX_MONEY_MINOR) + BigInt(monthly) - 1n) / BigInt(monthly)));
  }
  failure(calculateSavings({ currency: 'CNY', target: '-1', current: '0', monthly: '0' }), 'invalid_money');
});

test('successful results contain only JSON-serializable values and calculations have no mutable shared state', () => {
  const outcomes = [
    summarizeBills('收入 工资 10\n支出 餐饮 3.5', 'CNY'),
    calculateInstallments({ currency: 'HKD', principal: '100', feeTotal: '10', months: 12 }),
    calculateSavings({ currency: 'CNY', target: '10', current: '0', monthly: '0' }),
  ];
  for (const outcome of outcomes) assert.deepEqual(JSON.parse(JSON.stringify(value(outcome))), value(outcome));
  value(outcomes[0]).entries[0].amountMinor = 999;
  assert.equal(value(summarizeBills('收入 工资 10\n支出 餐饮 3.5', 'CNY')).entries[0].amountMinor, 1000);
});
