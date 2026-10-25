import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPayments, parseDemoAmount, scenarioReturn } from '../prototype/services/preview-math.ts';

test('payment amounts conserve cents across uneven plans', () => {
  for (const total of [1, 10001, 120000, 168001]) {
    for (const count of [1, 3, 6, 12]) {
      const amounts = splitPayments(total, count);
      assert.equal(amounts.reduce((a, b) => a + b, 0), total);
      assert.ok(Math.max(...amounts) - Math.min(...amounts) <= 1);
    }
  }
  assert.throws(() => splitPayments(100, 0));
});
test('amount input rejects negative, exponent, fractional cents and out of bounds', () => {
  for (const input of ['', '-100', '1e5', '100.001', '99.99', '1000000.01', 'NaN']) assert.equal(parseDemoAmount(input), null);
  assert.equal(parseDemoAmount('100.01'), 10001);
  assert.equal(parseDemoAmount('1000000'), 100000000);
});
test('scenario shows loss, flat and gain with no implicit guaranteed return', () => {
  assert.equal(scenarioReturn(100000, 365, -300), -3000);
  assert.equal(scenarioReturn(100000, 365, 0), 0);
  assert.equal(scenarioReturn(100000, 365, 300), 3000);
});
