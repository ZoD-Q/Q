import type { PaymentCapabilities, PaymentQuote, PaymentOrder, PaymentWallet, PaymentOrdersPage, PaymentDetachResponse, PaymentLedgerPage } from './types';
export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) { super(code); this.name = 'PaymentError'; this.code = code; this.status = status; }
}
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const str = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max;
const date = (v: unknown): v is string => str(v, 64) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const minor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const textOrNull = (v: unknown) => v === null || str(v);
const bool = (v: unknown) => typeof v === 'boolean';
const channel = (v: unknown) => v === 'wechat' || v === 'alipay';
export const invalid = (): never => { throw new PaymentError('INVALID_RESPONSE'); };
export function safeCheckout(value: unknown): value is string {
  if (!str(value, 4096)) return false;
  try { const u = new URL(value); return u.origin === 'https://api.payqixiang.cn' && !u.username && !u.password; } catch { return false; }
}
const https = (v: unknown) => { try { const u = new URL(String(v)); return str(v) && u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
export function amountMinor(input: string): number | null {
  if (input.length > 24 || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(input)) return null;
  const [whole, decimal = ''] = input.split('.');
  const value = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
export function money(v: number, currency: 'HKD' | 'CNY'): string {
  if (!Number.isSafeInteger(v)) throw new PaymentError('INVALID_AMOUNT');
  const minor = BigInt(v); const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${currency === 'HKD' ? 'HK$' : '¥'}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
export function decodeCapabilities(v: unknown): PaymentCapabilities {
  if (!object(v) || !bool(v.enabled) || !textOrNull(v.unavailable_reason) || v.credit_currency !== 'HKD' || v.pay_currency !== 'CNY' ||
    !Array.isArray(v.channels) || v.channels.length > 2 || !v.channels.every(c => object(c) && channel(c.id) && bool(c.enabled) && textOrNull(c.unavailable_reason)) ||
    new Set(v.channels.map(c => c.id)).size !== v.channels.length ||
    !['min_credit_amount_minor_hkd', 'max_credit_amount_minor_hkd', 'fee_basis_points', 'quote_ttl_seconds'].every(k => v[k] === null || minor(v[k])) ||
    !bool(v.checkout_detach_supported) || !bool(v.payment_history_supported) || !bool(v.independent_orders_supported) ||
    v.approval_mode !== 'governance_maker_checker_v1' || !date(v.server_time)) return invalid();
  if (v.enabled && (!minor(v.min_credit_amount_minor_hkd) || !minor(v.max_credit_amount_minor_hkd) || v.min_credit_amount_minor_hkd < 1 || v.max_credit_amount_minor_hkd < v.min_credit_amount_minor_hkd || !minor(v.fee_basis_points) || !minor(v.quote_ttl_seconds) || v.quote_ttl_seconds < 1)) return invalid();
  return v as PaymentCapabilities;
}
export function decodeQuote(v: unknown): PaymentQuote {
  if (!object(v) || !uuid(v.quote_id) || !uuid(v.account_id) || !channel(v.channel) || v.credit_currency !== 'HKD' || v.pay_currency !== 'CNY' ||
    !['credit_amount_minor_hkd', 'base_amount_minor_cny', 'fee_minor_cny', 'pay_amount_minor_cny', 'fee_basis_points'].every(k => minor(v[k])) ||
    v.credit_amount_minor_hkd === 0 || v.pay_amount_minor_cny === 0 ||
    !str(v.rate_cny_per_100_hkd, 64) || !/^(0|[1-9]\d*)(\.\d+)?$/.test(v.rate_cny_per_100_hkd) || !/[1-9]/.test(v.rate_cny_per_100_hkd) ||
    !str(v.rate_source, 256) || !v.rate_source || !https(v.rate_source_url) || !str(v.rate_source_date, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(v.rate_source_date) ||
    !['rate_at', 'rate_fetched_at', 'expires_at', 'server_time'].every(k => date(v[k])) || !str(v.rate_evidence_sha256, 64) || !/^[a-f0-9]{64}$/i.test(v.rate_evidence_sha256) ||
    v.rounding_policy !== 'total_ceiling_minor_v1') return invalid();
  const q = v as PaymentQuote;
  if (BigInt(q.base_amount_minor_cny) + BigInt(q.fee_minor_cny) !== BigInt(q.pay_amount_minor_cny)) return invalid();
  return q;
}
const statuses = ['creating', 'awaiting_payment', 'confirming', 'awaiting_credit_approval', 'crediting', 'credited', 'expired', 'failed', 'review_required'];
/** This proves only this particular command never created a provider payment.
 * Availability of the owner's checkout slot is a separate server-owned decision. */
export const trustedUnsubmittedProof = (order: PaymentOrder): boolean => order.status === 'failed' && order.error_code === 'not_created' && order.terminal && order.evidence_version === 0 && order.credited_transaction_id === null && order.checkout_url === null;
export const trustedRefundedProof = (order: PaymentOrder): boolean => order.refund_status === 'refunded' && uuid(order.refund_id) && date(order.refunded_at) && minor(order.refund_version) && order.refund_version > 0 && order.terminal && order.evidence_version > 0;
export function decodeOrder(v: unknown): PaymentOrder {
  decodeQuote(v);
  if (!object(v) || !uuid(v.payment_id) || !uuid(v.client_request_id) || !str(v.status, 40) || !statuses.includes(v.status) ||
    !(v.checkout_url === null || safeCheckout(v.checkout_url)) || !date(v.checkout_expires_at) ||
    !['checkout_detached', 'terminal', 'safe_to_start_new', 'can_detach_checkout'].every(k => bool(v[k])) || !minor(v.poll_after_seconds) ||
    !date(v.created_at) || !date(v.updated_at) || !textOrNull(v.error_code) || !(v.credited_transaction_id === null || uuid(v.credited_transaction_id)) || !minor(v.evidence_version)) return invalid();
  if (v.status === 'credited' && (!uuid(v.credited_transaction_id) || v.evidence_version < 1 || !v.terminal)) return invalid();
  const refundFields = ['refund_id', 'refund_status', 'refunded_at', 'refund_version'];
  if (refundFields.some(k => Object.hasOwn(v, k))) {
    if (!refundFields.every(k => Object.hasOwn(v, k)) || !(v.refund_id === null || uuid(v.refund_id)) ||
      !(v.refund_status === null || ['requested', 'approved_external', 'evidence_pending', 'evidence_rejected', 'unknown', 'refunded'].includes(String(v.refund_status))) ||
      !(v.refund_version === null || (minor(v.refund_version) && v.refund_version > 0)) || ((v.refund_id === null) !== (v.refund_version === null)) ||
      !(v.refunded_at === null || date(v.refunded_at)) || ((v.refund_id === null) !== (v.refund_status === null)) ||
      ((v.refund_status === 'refunded') !== (v.refunded_at !== null))) return invalid();
  }
  return v as PaymentOrder;
}
export function decodeWallet(v: unknown): PaymentWallet {
  if (!object(v) || v.currency !== 'HKD' || !minor(v.balance_minor) || !date(v.updated_at)) return invalid();
  if (Object.hasOwn(v, 'frozen_minor') || Object.hasOwn(v, 'available_minor')) {
    if (!minor(v.frozen_minor) || !minor(v.available_minor) || v.frozen_minor > v.balance_minor ||
      BigInt(v.frozen_minor) + BigInt(v.available_minor) !== BigInt(v.balance_minor)) return invalid();
  }
  return v as PaymentWallet;
}
export function decodeOrders(v: unknown): PaymentOrdersPage {
  if (!object(v) || !Array.isArray(v.items) || v.items.length > 100 || !(v.next_cursor === null || str(v.next_cursor, 4096))) return invalid();
  return { items: v.items.map(decodeOrder), next_cursor: v.next_cursor };
}
export function decodeActive(v: unknown): PaymentOrder | null { if (!object(v)) return invalid(); return v.payment === null ? null : decodeOrder(v.payment); }
export function decodeDetach(v: unknown): PaymentDetachResponse {
  if (!object(v) || !bool(v.can_start_new_checkout)) return invalid();
  return { payment: decodeOrder(v.payment), active_payment: v.active_payment === null ? null : decodeOrder(v.active_payment), can_start_new_checkout: v.can_start_new_checkout };
}
export function decodeLedger(v: unknown): PaymentLedgerPage {
  if (!object(v) || !Array.isArray(v.items) || v.items.length > 100 || !(v.next_cursor === null || str(v.next_cursor, 4096))) return invalid();
  const items = v.items.map(item => {
    if (!object(item) || !uuid(item.transaction_id) || !uuid(item.payment_id) || typeof item.amount_minor !== 'number' || !Number.isSafeInteger(item.amount_minor) || item.amount_minor === 0 || !minor(item.balance_after_minor) || !date(item.created_at)) return invalid();
    if (item.amount_minor < 0 && (item.kind !== 'refund_reversal' || !uuid(item.refund_id))) return invalid();
    if (item.kind !== undefined && !['credit', 'refund_reversal'].includes(String(item.kind))) return invalid();
    if (item.amount_minor > 0 && (item.kind === 'refund_reversal' || (item.refund_id !== undefined && item.refund_id !== null))) return invalid();
    return { transaction_id: item.transaction_id, payment_id: item.payment_id, amount_minor: item.amount_minor, balance_after_minor: item.balance_after_minor, created_at: item.created_at,
      ...(item.kind !== undefined ? { kind: item.kind as 'credit' | 'refund_reversal', refund_id: item.refund_id as string | null } : {}) };
  });
  return { items, next_cursor: v.next_cursor };
}
