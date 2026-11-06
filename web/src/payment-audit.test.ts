import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentAuditPath, parsePaymentAuditPage, paymentAuditReferences, type PaymentAuditEvent } from './payments/audit-data';

const event: PaymentAuditEvent = {
  audit_id: '11111111-1111-4111-8111-111111111111', actor_id: '22222222-2222-4222-8222-222222222222',
  payment_id: '44444444-4444-4444-8444-444444444444', action: 'credit_proposed',
  created_at: '2026-11-06T12:30:00.000Z', details: { evidence_version: 2 },
};

test('audit query keeps payment scope and the opaque server cursor as independent URL parameters', () => {
  const cursor = '2026-11-06T12:30:00+08:00|11111111-1111-4111-8111-111111111111&payment_id=wrong';
  const url = new URL(paymentAuditPath(event.payment_id!, cursor), 'https://q.kaicloudpay.com');
  assert.equal(url.pathname, '/v1/payments/operator/audit');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.deepEqual(url.searchParams.getAll('payment_id'), [event.payment_id]);
  assert.equal(url.searchParams.get('cursor'), cursor);
  assert.equal(new URL(paymentAuditPath('', null), url.origin).searchParams.has('payment_id'), false);
  assert.throws(() => paymentAuditPath('not-a-payment', null));
});

test('audit results preserve server event times and distinguish payment-only scope from domain-wide events', () => {
  assert.equal(parsePaymentAuditPage({ items: [event], next_cursor: null }, event.payment_id!).items[0].created_at, event.created_at);
  const fx = { ...event, action: 'fx_candidate_activated', payment_id: null };
  assert.equal(parsePaymentAuditPage({ items: [fx], next_cursor: null }).items[0].payment_id, null);
  assert.throws(() => parsePaymentAuditPage({ items: [fx], next_cursor: null }, event.payment_id!));
  assert.throws(() => parsePaymentAuditPage({ items: [{ ...event, payment_id: event.actor_id }], next_cursor: null }, event.payment_id!));
  assert.deepEqual(parsePaymentAuditPage({ items: [], next_cursor: null }), { items: [], next_cursor: null });
});

test('malformed audit pages fail instead of becoming empty or fabricated successful results', () => {
  for (const value of [{}, { items: null, next_cursor: null }, { items: [], next_cursor: 'cursor' },
    { items: [event, event], next_cursor: null }, { items: Array(21).fill(event), next_cursor: null },
    { items: [{ ...event, created_at: 'unknown' }], next_cursor: null },
    { items: [{ ...event, actor_id: 'operator' }], next_cursor: null },
    { items: [{ ...event, details: 'not-an-object' }], next_cursor: null }]) assert.throws(() => parsePaymentAuditPage(value));
});

test('audit reference rendering exposes only validated IDs, hashes and integer versions from server metadata', () => {
  const hash = 'a'.repeat(64);
  const result = paymentAuditReferences({ ...event, details: { refund_id: event.audit_id, evidence_sha256: hash, check_version: 3,
    arbitrary_note: 'private free text', raw_html: '<script>do not render</script>', bank_account: 'not-a-public-reference',
    mapping_sha256: 'invalid hash', snapshot_id: 'not-a-uuid', generation: 1.5 } });
  assert.deepEqual(result, [['refund_id', event.audit_id], ['evidence_sha256', hash], ['check_version', '3']]);
});
