import type { components } from '../../../mobile/shared/src/generated';
import { object, string } from './types';

export type PaymentAuditPage = components['schemas']['PaymentOperatorAuditPage'];
export type PaymentAuditEvent = components['schemas']['PaymentOperatorAuditEvent'];
export const isPaymentId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function paymentAuditPath(paymentId: string, cursor: string | null): string {
  if (paymentId && !isPaymentId(paymentId)) throw Error('INVALID_PAYMENT_ID');
  if (cursor !== null && (cursor.length === 0 || cursor.length > 2048)) throw Error('INVALID_CURSOR');
  const params = new URLSearchParams({ limit: '20' });
  if (paymentId) params.set('payment_id', paymentId.toLowerCase());
  if (cursor) params.set('cursor', cursor);
  return `/v1/payments/operator/audit?${params}`;
}

export function parsePaymentAuditPage(value: unknown, paymentId = ''): PaymentAuditPage {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 20) throw Error('INVALID_RESPONSE');
  const next = data.next_cursor === null ? null : string(data.next_cursor);
  if (next !== null && (next.length === 0 || next.length > 2048 || data.items.length === 0)) throw Error('INVALID_RESPONSE');
  const items = data.items.map((value): PaymentAuditEvent => {
    const item = object(value);
    const auditId = string(item.audit_id), actorId = string(item.actor_id);
    const target = item.payment_id === null ? null : string(item.payment_id);
    const action = string(item.action), createdAt = string(item.created_at);
    if (!isPaymentId(auditId) || !isPaymentId(actorId) || (target !== null && !isPaymentId(target))
      || (paymentId && target?.toLowerCase() !== paymentId.toLowerCase())
      || !action.length || action.length > 120 || /\p{Cc}/u.test(action)
      || !Number.isFinite(Date.parse(createdAt))) throw Error('INVALID_RESPONSE');
    return { audit_id: auditId, actor_id: actorId, payment_id: target, action, created_at: createdAt, details: object(item.details) };
  });
  if (new Set(items.map((item) => item.audit_id)).size !== items.length) throw Error('INVALID_RESPONSE');
  return { items, next_cursor: next };
}

/** Render only bounded, typed audit references rather than arbitrary free-text metadata. */
export function paymentAuditReferences(event: PaymentAuditEvent): [string, string][] {
  const result: [string, string][] = [];
  for (const key of ['refund_id', 'settlement_id', 'activation_id', 'snapshot_id', 'proposal_id', 'transaction_id']) {
    const value = event.details[key];
    if (typeof value === 'string' && isPaymentId(value)) result.push([key, value]);
  }
  for (const key of ['evidence_sha256', 'mapping_sha256']) {
    const value = event.details[key];
    if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) result.push([key, value]);
  }
  for (const key of ['evidence_version', 'check_version', 'generation', 'reviewed_generation']) {
    const value = event.details[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result.push([key, String(value)]);
  }
  return result;
}
