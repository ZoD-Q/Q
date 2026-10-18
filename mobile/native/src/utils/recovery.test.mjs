import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue } from './serial-queue.ts';
import { parsePendingTransfer } from '../services/pending-transfer-data.ts';
import { canDiscardFailedTransfer } from '../services/transfer-outcome.ts';

test('serialized profile writes preserve submission order even across rejected work', async () => {
  const enqueue = createSerialQueue();
  const seen = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = enqueue(async () => { seen.push('A:start'); await gate; seen.push('A:end'); });
  const failing = enqueue(async () => { seen.push('failed'); throw new Error('expected'); }).catch(() => undefined);
  const second = enqueue(async () => { seen.push('B:start'); seen.push('B:end'); });
  await Promise.resolve();
  assert.deepEqual(seen, ['A:start']);
  release();
  await Promise.all([first, failing, second]);
  assert.deepEqual(seen, ['A:start', 'A:end', 'failed', 'B:start', 'B:end']);
});

test('session storage cleanup cannot complete after a later credential write', async () => {
  const enqueue = createSerialQueue();
  let saved = 'token-A';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const clearA = enqueue(async () => { await gate; saved = null; });
  const loginB = enqueue(async () => { saved = 'token-B'; });
  release();
  await Promise.all([clearA, loginB]);
  assert.equal(saved, 'token-B');
});

test('a persisted transfer restores the identical key and payload only for its sender', () => {
  const sender = '12345678-1234-4234-8234-123456789abc';
  const intent = { sender_id: sender, request: { recipient_handle: 'lin', amount_minor: 29, memo: 'test', idempotency_key: '23456789-1234-4234-8234-123456789abc' }, recipient: { id: '34567890-1234-4234-8234-123456789abc', handle: 'lin', display_name: 'Lin', avatar: 'leaf' } };
  const raw = JSON.stringify(intent);
  assert.deepEqual(parsePendingTransfer(raw, sender), intent);
  assert.equal(parsePendingTransfer(null, sender), null);
  assert.throws(() => parsePendingTransfer(raw, '45678901-1234-4234-8234-123456789abc'));
  assert.throws(() => parsePendingTransfer(JSON.stringify({ ...intent, request: { ...intent.request, amount_minor: 1.1 } }), sender));
  assert.throws(() => parsePendingTransfer('{invalid', sender));
  assert.equal(Object.hasOwn(JSON.parse(raw), 'token'), false);
});

test('expired or throttled retries cannot discard a potentially committed transfer', () => {
  for (const [code, status] of [['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['RATE_LIMITED', 429], ['IDEMPOTENCY_CONFLICT', 409], ['INTERNAL_ERROR', 500], ['NETWORK_ERROR', 0]]) {
    assert.equal(canDiscardFailedTransfer(code, status, false), false);
    assert.equal(canDiscardFailedTransfer(code, status, true), false);
  }
  assert.equal(canDiscardFailedTransfer('INSUFFICIENT_FUNDS', 409, false), true);
  assert.equal(canDiscardFailedTransfer('VALIDATION_ERROR', 400, false), true);
  assert.equal(canDiscardFailedTransfer('INSUFFICIENT_FUNDS', 409, true), false);
  assert.equal(canDiscardFailedTransfer('VALIDATION_ERROR', 400, true), false);
});
