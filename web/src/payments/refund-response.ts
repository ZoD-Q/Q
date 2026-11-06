import type { Refund } from './types';

export type RefundAction = 'create' | 'approve' | 'evidence' | 'verify' | 'unknown' | 'reject';
export type RefundWriteExpectation = {
  kind: RefundAction;
  path: string;
  paymentId: string;
  actor: string;
  body: Readonly<Record<string, string | number>>;
  payMinor: number;
  creditMinor: number;
  evidenceHash?: string;
  evidenceVersion?: number;
  makerId?: string;
  checkerId?: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positiveVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Missing legacy proof stays unconfirmed; present server fields cannot invent its original identity. */
export function matchesRefundUnknown(result: Refund, identity: Readonly<Record<string, unknown>>, actor: string): boolean {
  return result.status === 'unknown' && result.approved_at !== null
    && typeof identity.maker_id === 'string' && uuid.test(identity.maker_id)
    && typeof identity.checker_id === 'string' && uuid.test(identity.checker_id)
    && identity.maker_id !== identity.checker_id && result.maker_id === identity.maker_id
    && result.checker_id === identity.checker_id && (actor === identity.maker_id || actor === identity.checker_id)
    && positiveVersion(identity.version) && result.version > identity.version;
}

export function matchesRefundVerification(result: Refund, identity: Readonly<Record<string, unknown>>, actor: string): boolean {
  return result.status === 'refunded' && result.approved_at !== null && result.checker_id === actor
    && result.maker_id !== actor && result.verified_by === actor && result.frozen_minor_hkd === 0
    && result.evidence_sha256 === identity.evidence_sha256
    && positiveVersion(identity.evidence_version) && result.evidence_version === identity.evidence_version
    && positiveVersion(identity.version) && result.version > identity.version;
}

/** Runs inside the response parser, before PaymentApi can remove recovery metadata. */
export function validateRefundWriteResult(result: Refund, expected: RefundWriteExpectation): Refund {
  const { kind, body, actor } = expected;
  const requireMatch = (matches: boolean) => { if (!matches) throw Error('REFUND_RESPONSE_MISMATCH'); };
  requireMatch(result.payment_id === expected.paymentId && result.pay_amount_minor_cny === expected.payMinor
    && result.credit_amount_minor_hkd === expected.creditMinor);
  if (kind === 'create') {
    requireMatch(expected.path === `/v1/payments/operator/orders/${expected.paymentId}/refunds`
      && result.client_request_id === body.client_request_id && result.maker_id === actor && result.reason === body.reason);
    // An idempotent create may return the same refund after later operations.
    return result;
  }
  const action = kind === 'reject' ? 'evidence-rejections' : kind;
  requireMatch(expected.path === `/v1/payments/operator/refunds/${result.refund_id}/${action}`
    && typeof body.version === 'number' && result.version > body.version);
  const independentChecker = result.checker_id === actor && result.maker_id !== actor && result.approved_at !== null;
  if (kind === 'approve') {
    // The backend also returns later states when this checker repeats the original approval.
    requireMatch(independentChecker && result.status !== 'requested');
  } else if (kind === 'unknown') {
    // This operation confirms an unknown state; an idempotent response need not replace earlier notes.
    requireMatch(matchesRefundUnknown(result, { ...body, maker_id: expected.makerId, checker_id: expected.checkerId }, actor));
  } else if (kind === 'evidence') {
    requireMatch(result.maker_id === actor && result.approved_at !== null
      && ['evidence_pending', 'refunded'].includes(result.status)
      && typeof expected.evidenceHash === 'string' && result.evidence_sha256 === expected.evidenceHash
      && result.external_reference === body.external_reference && result.executed_at !== null
      && typeof body.executed_at === 'string' && Date.parse(result.executed_at) === Date.parse(body.executed_at));
  } else if (kind === 'verify') {
    requireMatch(matchesRefundVerification(result, { ...body, evidence_version: expected.evidenceVersion }, actor));
  } else {
    requireMatch(independentChecker && result.status === 'evidence_rejected'
      && result.evidence_sha256 === body.evidence_sha256 && result.rejection_reason === body.reason
      && typeof expected.evidenceVersion === 'number' && result.evidence_version === expected.evidenceVersion);
  }
  return result;
}
