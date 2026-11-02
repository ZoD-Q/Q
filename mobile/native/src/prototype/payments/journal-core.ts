import { object, uuid, PaymentError } from './validation';
import type { PendingPayment } from './types';
export type PaymentStorage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
const tails = new Map<string, Promise<void>>();
export function decodePending(v: unknown, origin: string, ownerId: string): PendingPayment {
  if (!object(v) || v.version !== 1 || v.origin !== origin || v.ownerId !== ownerId || !uuid(ownerId) || !object(v.request) || !uuid(v.request.quote_id) || !uuid(v.request.client_request_id) ||
    typeof v.creditAmount !== 'number' || !Number.isSafeInteger(v.creditAmount) || v.creditAmount < 1 || (v.channel !== 'wechat' && v.channel !== 'alipay') || typeof v.possiblySent !== 'boolean') throw new PaymentError('PAYMENT_STORAGE_ERROR');
  // Construct a token-free allowlisted value even when unexpected fields are supplied.
  return { version: 1, origin, ownerId, request: { quote_id: v.request.quote_id, client_request_id: v.request.client_request_id }, creditAmount: v.creditAmount, channel: v.channel, possiblySent: v.possiblySent };
}
export function createPaymentJournal(storage: PaymentStorage, origin: string, ownerId: string) {
  if (!uuid(ownerId) || new URL(origin).origin !== origin) throw new PaymentError('PAYMENT_SCOPE_MISMATCH');
  // SecureStore keys allow alphanumeric, dot, dash and underscore, but not URL escapes.
  const encodedOrigin = Array.from(origin).map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const key = `xiaoq.payments.pending.v1.${encodedOrigin}.${ownerId}`;
  const queue = <T,>(run: () => Promise<T>) => {
    const result = (tails.get(key) ?? Promise.resolve()).then(run);
    const tail = result.then(() => undefined, () => undefined); tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result.catch(() => { throw new PaymentError('PAYMENT_STORAGE_ERROR'); });
  };
  const read = async () => { const raw = await storage.get(key); return raw === null ? null : decodePending(JSON.parse(raw), origin, ownerId); };
  return {
    read: () => queue(read),
    save: (value: PendingPayment) => queue(async () => {
      const safe = decodePending(value, origin, ownerId); const previous = await read();
      if (previous && (JSON.stringify(previous.request) !== JSON.stringify(safe.request) || previous.creditAmount !== safe.creditAmount || previous.channel !== safe.channel || (previous.possiblySent && !safe.possiblySent))) throw new PaymentError('PAYMENT_OPERATION_PENDING');
      const raw = JSON.stringify(safe); if (raw.length > 1800) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      await storage.set(key, raw); if (await storage.get(key) !== raw) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return safe;
    }),
    clear: (requestId: string) => queue(async () => { const previous = await read(); if (previous?.request.client_request_id === requestId) { await storage.remove(key); if (await storage.get(key) !== null) throw new PaymentError('PAYMENT_STORAGE_ERROR'); } }),
  };
}
export type PaymentJournal = ReturnType<typeof createPaymentJournal>;
