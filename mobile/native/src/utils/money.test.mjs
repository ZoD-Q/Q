import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount } from './money.ts';
test('money preserves minor units and rejects ambiguous/unsafe inputs', () => {
  assert.equal(parseAmount('0.29'), 29);
  assert.equal(parseAmount(' 12.3 '), 1230);
  assert.equal(parseAmount('1000000.00'), 100000000);
  for (const value of ['', '0', '-1', '1e3', '1,000', '1.001', '1000000.01', 'Infinity', 'NaN', '.5']) assert.equal(parseAmount(value), null);
  assert.equal(formatAmount(100029), '1,000.29');
});
