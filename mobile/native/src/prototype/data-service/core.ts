// Pure pay-per-use metering core: demo ledger, orders with automatic refunds, usage events and
// Pro Q&A credits. No network, storage or identity access here; the page layer owns those.
import { dataServiceById, type DataServiceId } from './catalog';

export type ServiceOrder = {
  id: string;
  serviceId: DataServiceId;
  /** List price in CNY fen, charged up front. */
  priceMinorCny: number;
  at: string;
  status: 'delivered' | 'refunded' | 'awaiting_delivery';
  /** Delivery reference, e.g. provider name or the credited Q&A credit. */
  detail: string;
};
export type UsageEvent = {
  id: string;
  orderId: string;
  serviceId: DataServiceId | 'account-topup';
  at: string;
  /** Negative charge or positive refund, in CNY fen. */
  deltaMinorCny: number;
  kind: 'charge' | 'refund' | 'topup';
};
export type ServiceLedger = {
  balanceMinorCny: number;
  orders: ServiceOrder[];
  events: UsageEvent[];
  proQaCredits: number;
};
export const DEMO_INITIAL_TOPUP_MINOR_CNY = 1000;
export type PurchaseError = 'unknown_service' | 'insufficient_balance' | 'no_credit_to_redeem';

export function createServiceLedger(): ServiceLedger {
  return { balanceMinorCny: 0, orders: [], events: [], proQaCredits: 0 };
}
export function topUpDemoCredit(state: ServiceLedger, amountMinorCny: number, at: string, newId: () => string): ServiceLedger {
  if (!Number.isInteger(amountMinorCny) || amountMinorCny <= 0) return state;
  const event: UsageEvent = { id: newId(), orderId: '', serviceId: 'account-topup', at, deltaMinorCny: amountMinorCny, kind: 'topup' };
  return { ...state, balanceMinorCny: state.balanceMinorCny + amountMinorCny, events: [event, ...state.events].slice(0, 200) };
}
/** Charges up front, records the order as awaiting_delivery and returns it for the page to fulfil.
 * Delivery failures must call refundOrder — a failed read never keeps a charge. */
export function chargeService(state: ServiceLedger, serviceId: DataServiceId, at: string, newId: () => string):
  { ok: true; state: ServiceLedger; order: ServiceOrder } | { ok: false; error: PurchaseError } {
  const service = dataServiceById(serviceId);
  if (!service) return { ok: false, error: 'unknown_service' };
  if (state.balanceMinorCny < service.priceMinorCny) return { ok: false, error: 'insufficient_balance' };
  const order: ServiceOrder = { id: newId(), serviceId, priceMinorCny: service.priceMinorCny, at, status: 'awaiting_delivery', detail: '' };
  const charge: UsageEvent = { id: newId(), orderId: order.id, serviceId: service.id, at, deltaMinorCny: -service.priceMinorCny, kind: 'charge' };
  const next: ServiceLedger = {
    ...state,
    balanceMinorCny: state.balanceMinorCny - service.priceMinorCny,
    orders: [order, ...state.orders].slice(0, 200),
    events: [charge, ...state.events].slice(0, 200),
    proQaCredits: serviceId === 'pro-qa' ? state.proQaCredits + 1 : state.proQaCredits,
  };
  return { ok: true, state: next, order };
}
export function markDelivered(state: ServiceLedger, orderId: string, detail: string): ServiceLedger {
  if (!state.orders.some(order => order.id === orderId && order.status === 'awaiting_delivery')) return state;
  return { ...state, orders: state.orders.map(order => order.id === orderId && order.status === 'awaiting_delivery' ? { ...order, status: 'delivered', detail } : order) };
}
/** Full refund for an unfulfilled order; the paired refund event keeps the ledger auditable. */
export function refundOrder(state: ServiceLedger, orderId: string, at: string, newId: () => string): ServiceLedger {
  const order = state.orders.find(item => item.id === orderId);
  if (!order || order.status !== 'awaiting_delivery') return state;
  const refund: UsageEvent = { id: newId(), orderId, serviceId: order.serviceId, at, deltaMinorCny: order.priceMinorCny, kind: 'refund' };
  return {
    ...state,
    balanceMinorCny: state.balanceMinorCny + order.priceMinorCny,
    orders: state.orders.map(item => item.id === orderId ? { ...item, status: 'refunded', detail: 'refunded' } : item),
    events: [refund, ...state.events].slice(0, 200),
    proQaCredits: order.serviceId === 'pro-qa' ? Math.max(0, state.proQaCredits - 1) : state.proQaCredits,
  };
}
export function redeemProQaCredit(state: ServiceLedger): { ok: true; state: ServiceLedger } | { ok: false; error: PurchaseError } {
  if (state.proQaCredits < 1) return { ok: false, error: 'no_credit_to_redeem' };
  return { ok: true, state: { ...state, proQaCredits: state.proQaCredits - 1 } };
}
export function eventsOfService(state: ServiceLedger, serviceId?: DataServiceId): UsageEvent[] {
  return serviceId ? state.events.filter(event => event.serviceId === serviceId) : state.events;
}
