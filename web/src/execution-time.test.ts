import assert from 'node:assert/strict';
import test from 'node:test';
import { localExecutionTime } from './payments/execution-time';
test('manual device-local execution time preserves milliseconds and rejects calendar overflow', () => {
  const time = localExecutionTime('2024-02-29T12:34:56.123');
  assert.equal(new Date(time).getMilliseconds(), 123);
  assert.equal(time, new Date(2024, 1, 29, 12, 34, 56, 123).getTime());
  assert.equal(localExecutionTime('2026-11-02T12:00'), new Date(2026, 10, 2, 12).getTime());
  for (const invalid of ['2026-02-29T12:00', '2026-13-01T12:00', '2026-11-02T24:00', '2026-11-02T12:00Z', '2026/11/02', '']) assert(Number.isNaN(localExecutionTime(invalid)), invalid);
});
