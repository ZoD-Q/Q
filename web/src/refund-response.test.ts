import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PaymentApi, PaymentError, paymentRecoveryStorageKey } from './payments/api';
import { parseRefund, type Refund } from './payments/types';
import { validateRefundWriteResult, matchesRefundUnknown, matchesRefundVerification, type RefundWriteExpectation } from './payments/refund-response';

const payment = '44444444-4444-4444-8444-444444444444';
const refundId = '66666666-6666-4666-8666-666666666666';
const key = '88888888-8888-4888-8888-888888888888';
const maker = '22222222-2222-4222-8222-222222222222';
const checker = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-01T02:00:00.000Z';
const proof = createHash('sha256').update('original receipt').digest('hex');
const baseline: Refund = {
  refund_id: refundId, payment_id: payment, client_request_id: key, status: 'requested', version: 1,
  reason: 'Original reason', notes: null, approved_at: null, pay_amount_minor_cny: 9300,
  credit_amount_minor_hkd: 10000, frozen_minor_hkd: 10000, maker_id: maker, checker_id: null,
  external_reference: null, executed_at: null, evidence_sha256: null, evidence_version: null,
  rejection_reason: null, verified_by: null, created_at: at, updated_at: at,
};
const approved: Refund = { ...baseline, status: 'approved_external', version: 2, checker_id: checker, approved_at: at };
const evidenced: Refund = { ...approved, status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: proof, external_reference: 'ORIGINAL-EXTERNAL', executed_at: at };
const completed: Refund = { ...evidenced, status: 'refunded', version: 4, verified_by: checker, frozen_minor_hkd: 0 };
function expected(kind: RefundWriteExpectation['kind'], body: RefundWriteExpectation['body'], actor = checker): RefundWriteExpectation {
  return { kind, path: kind === 'create' ? `/v1/payments/operator/orders/${payment}/refunds` : `/v1/payments/operator/refunds/${refundId}/${kind === 'reject' ? 'evidence-rejections' : kind}`,
    paymentId: payment, actor, body, payMinor: 9300, creditMinor: 10000 };
}
const create = expected('create', { client_request_id: key, reason: baseline.reason }, maker);
const approve = expected('approve', { version: 1 });
const verify = { ...expected('verify', { version: 3, evidence_sha256: proof }), evidenceVersion: 1 };

test('refund receipts bind original creation identity, target, actor, amounts and action outcome', () => {
  for (const changed of [{ client_request_id: payment }, { maker_id: checker }, { reason: 'Different reason' }, { pay_amount_minor_cny: 9301 }, { payment_id: refundId }] satisfies Partial<Refund>[]) {
    assert.throws(() => validateRefundWriteResult({ ...baseline, ...changed }, create), /REFUND_RESPONSE_MISMATCH/);
  }
  for (const changed of [{ refund_id: payment }, { status: 'evidence_pending' }, { evidence_sha256: 'b'.repeat(64) }, { verified_by: maker }, { checker_id: maker }, { frozen_minor_hkd: 10000 }, { version: 3 }] satisfies Partial<Refund>[]) {
    assert.throws(() => validateRefundWriteResult({ ...completed, ...changed }, verify), /REFUND_RESPONSE_MISMATCH/);
  }
  assert.throws(() => validateRefundWriteResult(baseline, approve), /REFUND_RESPONSE_MISMATCH/);
});

test('matching idempotent receipts may contain later states without accepting a different action', () => {
  for (const receipt of [baseline, approved, evidenced, completed]) assert.equal(validateRefundWriteResult(receipt, create), receipt);
  for (const receipt of [approved, evidenced, completed]) assert.equal(validateRefundWriteResult(receipt, approve), receipt);
  assert.equal(validateRefundWriteResult(completed, verify), completed);
  const unknown = { ...expected('unknown', { version: 2, notes: 'Later note' }, maker), makerId: maker, checkerId: checker };
  assert.equal(validateRefundWriteResult({ ...approved, status: 'unknown', version: 3, notes: 'Original note' }, unknown).status, 'unknown');
  assert.throws(() => validateRefundWriteResult(approved, unknown), /REFUND_RESPONSE_MISMATCH/);
});

test('evidence and rejection receipts bind precomputed bytes, execution identity and original evidence version', () => {
  const evidence = { ...expected('evidence', { version: 2, external_reference: 'ORIGINAL-EXTERNAL', executed_at: at }, maker), evidenceHash: proof };
  for (const receipt of [evidenced, completed]) assert.equal(validateRefundWriteResult(receipt, evidence), receipt);
  for (const changed of [{ evidence_sha256: 'c'.repeat(64) }, { external_reference: 'ANOTHER-EXECUTION' }, { executed_at: '2026-11-02T02:00:00.000Z' }, { status: 'approved_external' }, { version: 2 }, { maker_id: checker }] satisfies Partial<Refund>[]) {
    assert.throws(() => validateRefundWriteResult({ ...evidenced, ...changed }, evidence), /REFUND_RESPONSE_MISMATCH/);
  }
  assert.throws(() => validateRefundWriteResult(evidenced, { ...evidence, evidenceHash: undefined }), /REFUND_RESPONSE_MISMATCH/);
  const rejection = { ...expected('reject', { version: 3, evidence_sha256: proof, reason: 'Unreadable receipt' }), evidenceVersion: 1 };
  const rejected: Refund = { ...evidenced, version: 4, status: 'evidence_rejected', rejection_reason: 'Unreadable receipt' };
  assert.equal(validateRefundWriteResult(rejected, rejection), rejected);
  for (const changed of [{ evidence_version: 2 }, { rejection_reason: 'Different reason' }, { evidence_sha256: 'c'.repeat(64) }, { status: 'evidence_pending' }] satisfies Partial<Refund>[]) {
    assert.throws(() => validateRefundWriteResult({ ...rejected, ...changed }, rejection), /REFUND_RESPONSE_MISMATCH/);
  }
});

test('mismatched 200 refund responses retain recovery until an original-request retry is verified', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value) } });
  const origin = 'http://127.0.0.1:18789';
  const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const posted: unknown[] = [];
  let returned: Refund = { ...approved, refund_id: payment };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return response(returned); }
    return response(baseline);
  };
  const api = new PaymentApi('fixture-token', checker, () => {}, origin);
  const pendingKey = `refund-approve:${payment}`;
  const parse = (value: unknown) => validateRefundWriteResult(parseRefund(value), approve);
  try {
    await assert.rejects(api.mutate(pendingKey, approve.path, approve.body, parse, `/v1/payments/operator/refunds/${refundId}`), (error: unknown) => error instanceof PaymentError && error.unknown);
    assert.equal(JSON.parse(storage.get(paymentRecoveryStorageKey(origin, checker))!).items.length, 1);
    await assert.rejects(api.mutate(pendingKey, approve.path, approve.body, parse, `/v1/payments/operator/refunds/${refundId}`), /PENDING_REQUIRES_QUERY/);
    await api.recover(pendingKey, parseRefund);
    returned = { ...approved, status: 'requested' };
    await assert.rejects(api.retry(pendingKey, parse), (error: unknown) => error instanceof PaymentError && error.unknown);
    assert(api.pending(pendingKey));
    await api.recover(pendingKey, parseRefund);
    returned = completed;
    assert.equal((await api.retry(pendingKey, parse)).status, 'refunded');
    assert.equal(api.pending(pendingKey), undefined);
    assert.deepEqual(posted, [approve.body, approve.body, approve.body]);
  } finally {
    api.invalidate(); globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});


test('unknown recovery requires the original approved participants and a newer refund version', () => {
  const identity = { version: 2, maker_id: maker, checker_id: checker };
  const unknown: Refund = { ...approved, status: 'unknown', version: 3 };
  assert(matchesRefundUnknown(unknown, identity, maker));
  assert(matchesRefundUnknown(unknown, identity, checker));
  for (const changed of [{ maker_id: payment }, { checker_id: payment }, { approved_at: null }, { version: 2 }] satisfies Partial<Refund>[]) {
    assert.equal(matchesRefundUnknown({ ...unknown, ...changed }, identity, maker), false);
  }
  assert.equal(matchesRefundUnknown(unknown, { version: 2 }, maker), false);
  assert.equal(matchesRefundUnknown(unknown, identity, payment), false);
});

test('verification receipts and recovery require the original evidence version even when hashes match', () => {
  const identity = { version: 3, evidence_version: 1, evidence_sha256: proof };
  assert(matchesRefundVerification(completed, identity, checker));
  assert.equal(matchesRefundVerification({ ...completed, evidence_version: 2 }, identity, checker), false);
  assert.equal(matchesRefundVerification(completed, { version: 3, evidence_sha256: proof }, checker), false);
  assert.throws(() => validateRefundWriteResult({ ...completed, evidence_version: 2 }, verify), /REFUND_RESPONSE_MISMATCH/);
  assert.throws(() => validateRefundWriteResult(completed, { ...verify, evidenceVersion: undefined }), /REFUND_RESPONSE_MISMATCH/);
});

test('unknown participant and verification evidence proofs survive reload without entering the POST body', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value) } });
  const origin = 'http://127.0.0.1:18789';
  const posted: unknown[] = [];
  globalThis.fetch = async (_url, init) => { posted.push(JSON.parse(String(init?.body))); throw Error('fixture transport lost'); };
  const api = new PaymentApi('fixture-token', checker, () => {}, origin);
  try {
    for (const [kind, body, identity] of [
      ['unknown', { version: 2, notes: 'Private reason' }, { maker_id: maker, checker_id: checker }],
      ['verify', { version: 3, evidence_sha256: proof }, { evidence_version: 1 }],
    ] as const) {
      await assert.rejects(api.mutate(`refund-${kind}:${payment}`, `/v1/payments/operator/refunds/${refundId}/${kind}`, body, parseRefund, `/v1/payments/operator/refunds/${refundId}`, identity));
    }
    assert.deepEqual(posted, [{ version: 2, notes: 'Private reason' }, { version: 3, evidence_sha256: proof }]);
    api.invalidate();
    const restored = new PaymentApi('new-fixture-token', checker, () => {}, origin);
    assert.deepEqual(restored.pending(`refund-unknown:${payment}`)?.body, { version: 2, maker_id: maker, checker_id: checker });
    assert.deepEqual(restored.pending(`refund-verify:${payment}`)?.body, { version: 3, evidence_sha256: proof, evidence_version: 1 });
    assert(!JSON.stringify([...storage.values()]).includes('Private reason'));
    restored.invalidate();
  } finally {
    api.invalidate(); globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
