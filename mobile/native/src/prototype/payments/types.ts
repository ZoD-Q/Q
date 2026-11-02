import type { components } from '../../../../shared/src/generated';
export type PaymentCapabilities = components['schemas']['PaymentCapabilities'];
export type PaymentQuote = components['schemas']['PaymentQuote'];
export type PaymentOrder = components['schemas']['PaymentOrder'];
export type PaymentWallet = components['schemas']['PaymentWallet'];
export type PaymentChannel = components['schemas']['PaymentChannel'];
export type PaymentCreateRequest = components['schemas']['PaymentCreateRequest'];
export type PaymentQuoteRequest = components['schemas']['PaymentQuoteRequest'];
export type PaymentOrdersPage = components['schemas']['PaymentOrdersPage'];
export type PaymentDetachResponse = components['schemas']['PaymentDetachResponse'];
export type PaymentLedgerPage = components['schemas']['PaymentLedgerPage'];
export type PaymentIdentity = { ownerId: string; generation: number };
export type PendingPayment = { version: 1; origin: string; ownerId: string; request: PaymentCreateRequest; creditAmount: number; channel: PaymentChannel; possiblySent: boolean };
export type FundingState = {
  phase: 'loading' | 'amount' | 'review' | 'submitting' | 'result' | 'unavailable';
  capabilities: PaymentCapabilities | null; quote: PaymentQuote | null; order: PaymentOrder | null;
  pending: PendingPayment | null; busy: boolean; error: string; retryAt: number | null; serverOffset: number;
  orders: { view: 'pending' | 'history'; items: PaymentOrder[]; cursor: string | null; busy: boolean; error: string };
};
