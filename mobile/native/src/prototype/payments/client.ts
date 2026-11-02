import { workbenchRequest, WorkbenchError } from '../api-workbench/core';
import { decodeActive, decodeCapabilities, decodeDetach, decodeLedger, decodeOrder, decodeOrders, decodeQuote, decodeWallet, PaymentError, uuid } from './validation';
import type { PaymentCreateRequest, PaymentQuoteRequest } from './types';
export function createPaymentClient(options: { baseUrl: string; getToken: () => string | null; transport?: typeof fetch; timeoutMs?: number }) {
  const origin = new URL(options.baseUrl).origin;
  const request = async <T,>(path: string, decode: (value: unknown) => T, signal?: AbortSignal, body?: unknown) => {
    const token = options.getToken();
    if (!token) throw new PaymentError('UNAUTHORIZED', 401);
    // Race the transport itself too: cancellation must settle even for an uncooperative adapter.
    const controller = new AbortController(); const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, options.timeoutMs ?? 30000);
    let aborted: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => { aborted = () => reject(new PaymentError(signal?.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT')); controller.signal.addEventListener('abort', aborted, { once: true }); });
    if (signal?.aborted) controller.abort();
    try { return await Promise.race([workbenchRequest({ ...options, token, path: `/v1/payments${path}`, decode, signal: controller.signal, method: body === undefined ? 'GET' : 'POST', body }), cancellation]); }
    catch (error) {
      if (error instanceof WorkbenchError) throw new PaymentError([404, 501].includes(error.status) && ['NOT_FOUND', 'NOT_IMPLEMENTED', 'REQUEST_FAILED'].includes(error.code) ? 'PAYMENTS_UNAVAILABLE' : error.code, error.status);
      throw error;
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', cancel); if (aborted) controller.signal.removeEventListener('abort', aborted); }
  };
  const id = (value: string) => { if (!uuid(value)) throw new PaymentError('INVALID_REQUEST'); return value; };
  return {
    origin,
    capabilities: (signal?: AbortSignal) => request('/capabilities', decodeCapabilities, signal),
    wallet: (signal?: AbortSignal) => request('/wallet', decodeWallet, signal),
    ledger: (cursor: string | null = null, signal?: AbortSignal) => request(`/ledger?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`, decodeLedger, signal),
    quote: (body: PaymentQuoteRequest, signal?: AbortSignal) => {
      if (!['wechat', 'alipay'].includes(body.channel) || !Number.isSafeInteger(body.credit_amount_minor_hkd) || body.credit_amount_minor_hkd < 1) throw new PaymentError('INVALID_AMOUNT');
      return request('/quotes', decodeQuote, signal, body);
    },
    create: (body: PaymentCreateRequest, signal?: AbortSignal) => request('/orders', decodeOrder, signal, { quote_id: id(body.quote_id), client_request_id: id(body.client_request_id) }),
    get: (paymentId: string, signal?: AbortSignal) => request(`/orders/${id(paymentId)}`, decodeOrder, signal),
    byKey: (key: string, signal?: AbortSignal) => request(`/orders/by-client-key/${id(key)}`, decodeOrder, signal),
    active: (signal?: AbortSignal) => request('/orders/active', decodeActive, signal),
    orders: (view: 'pending' | 'history', cursor: string | null, signal?: AbortSignal) => request(`/orders?${new URLSearchParams({ view, limit: '20', ...(cursor ? { cursor } : {}) })}`, decodeOrders, signal),
    detach: (paymentId: string, signal?: AbortSignal) => request(`/orders/${id(paymentId)}/detach`, decodeDetach, signal, { acknowledge_old_payment_may_complete: true }),
  };
}
export type PaymentClient = ReturnType<typeof createPaymentClient>;
