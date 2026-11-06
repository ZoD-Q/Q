import type { PaymentClient } from './client';
import type { PaymentJournal } from './journal-core';
import type { FundingState, PaymentChannel, PaymentIdentity, PaymentOrder, PendingPayment } from './types';
import { amountMinor, decodeOrder, PaymentError, safeCheckout, trustedRefundedProof, trustedUnsubmittedProof } from './validation';

const frozenFields = ['quote_id', 'account_id', 'channel', 'credit_currency', 'pay_currency', 'credit_amount_minor_hkd', 'base_amount_minor_cny', 'fee_minor_cny', 'pay_amount_minor_cny', 'fee_basis_points', 'rate_cny_per_100_hkd', 'rate_source', 'rate_source_url', 'rate_source_date', 'rate_at', 'rate_fetched_at', 'rate_evidence_sha256', 'expires_at', 'rounding_policy'] as const;
const refundPending = (order: PaymentOrder | null) => !!order?.refund_status && order.refund_status !== 'refunded';
const refundRevision = (order: PaymentOrder) => `${order.refund_id ?? ''}:${order.refund_version ?? ''}:${order.refund_status ?? ''}`;
const refundRegressed = (previous: PaymentOrder, next: PaymentOrder) =>
  (!!previous.refund_id && previous.refund_id !== next.refund_id) ||
  (previous.refund_version != null && (next.refund_version == null || next.refund_version < previous.refund_version)) ||
  (previous.refund_status === 'refunded' && next.refund_status !== 'refunded');

export const initialFundingState = (): FundingState => ({ phase: 'loading', capabilities: null, quote: null, order: null, pending: null, busy: false, error: '', retryAt: null, serverOffset: 0, orders: { view: 'pending', items: [], cursor: null, busy: false, error: '' } });
export function createFundingController(deps: {
  client: PaymentClient; journal: PaymentJournal; identity: PaymentIdentity;
  isCurrent(identity: PaymentIdentity): boolean; newId(): string;
  onCredited?(order: PaymentOrder): void | Promise<void>; onRefundChanged?(order: PaymentOrder): void | Promise<void>; now?: () => number;
}) {
  let state = initialFundingState(); let disposed = false; let active = false; let checkoutFresh = false; let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null; let polls = 0; let windowStart = 0; let historyVersion = 0;
  let activeBlock: PaymentOrder | null = null;
  let historyRequest: AbortController | null = null;
  const now = deps.now ?? Date.now; const credited = new Set<string>(); const listeners = new Set<() => void>();
  const refunds = new Map<string, string>();
  const current = () => !disposed && deps.isCurrent(deps.identity);
  const check = () => { if (!current() || request?.signal.aborted) throw new PaymentError('PAYMENT_IDENTITY_CHANGED'); };
  const emit = (patch: Partial<FundingState>) => { if (current()) { state = { ...state, ...patch }; for (const f of listeners) f(); } };
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const cancelHistory = () => {
    historyVersion++; historyRequest?.abort(); historyRequest = null;
    if (state.orders.busy) emit({ orders: { ...state.orders, busy: false } });
  };
  const canStart = () => !state.pending && !activeBlock && (!state.order || state.order.safe_to_start_new);
  function fail(code: string): never { throw new PaymentError(code); }
  const accept = async (value: PaymentOrder, expectedId?: string): Promise<PaymentOrder> => {
    check(); const order = decodeOrder(value);
    if (order.account_id !== deps.identity.ownerId || (expectedId && order.client_request_id !== expectedId)) fail('PAYMENT_RESPONSE_MISMATCH');
    if (state.pending && order.client_request_id === state.pending.request.client_request_id && (order.quote_id !== state.pending.request.quote_id || order.credit_amount_minor_hkd !== state.pending.creditAmount || order.channel !== state.pending.channel)) fail('PAYMENT_RESPONSE_MISMATCH');
    const frozen = state.order?.payment_id === order.payment_id ? state.order : state.quote?.quote_id === order.quote_id ? state.quote : null;
    if (frozen && frozenFields.some(field => frozen[field] !== order[field])) fail('PAYMENT_RESPONSE_MISMATCH');
    if (state.order?.payment_id === order.payment_id && (order.evidence_version < state.order.evidence_version || (state.order.status === 'credited' && order.status !== 'credited') || refundRegressed(state.order, order))) fail('PAYMENT_RESPONSE_MISMATCH');
    const previousRefund = refunds.get(order.payment_id); const previousCredit = credited.has(order.payment_id);
    refunds.set(order.payment_id, refundRevision(order));
    if (!order.safe_to_start_new) activeBlock = order;
    else if (activeBlock?.payment_id === order.payment_id) activeBlock = null;
    emit({ order, phase: 'result', serverOffset: Date.parse(order.server_time) - now() });
    const resolvedIntent = trustedUnsubmittedProof(order) || trustedRefundedProof(order);
    if ((order.safe_to_start_new || resolvedIntent) && state.pending?.request.client_request_id === order.client_request_id) {
      await deps.journal.clear(order.client_request_id); check(); emit({ pending: null });
    }
    if (resolvedIntent && !order.safe_to_start_new) {
      const activeOrder = await deps.client.active(request?.signal); check();
      if (activeOrder) {
        if (activeOrder.payment_id === order.payment_id || activeOrder.account_id !== deps.identity.ownerId) fail('PAYMENT_RESPONSE_MISMATCH');
        activeBlock = null;
        return accept(activeOrder);
      }
      // A false slot flag is never promoted to permission by an empty lookup.
      emit({ error: 'PAYMENT_OPERATION_PENDING' });
    }
    if (order.status === 'credited' && !credited.has(order.payment_id)) {
      credited.add(order.payment_id); check();
      try { await deps.onCredited?.(order); } catch { /* Account refresh failure must not reverse confirmed credit. */ }
    }
    if (order.refund_status && previousRefund !== refundRevision(order) && (previousRefund !== undefined || previousCredit || order.status !== 'credited')) {
      check();
      try { await deps.onRefundChanged?.(order); } catch { /* A balance-read failure never rolls back refund evidence. */ }
    }
    checkoutFresh = active && current() && !request?.signal.aborted;
    return order;
  };
  const schedule = () => {
    stopTimer(); if (!active || !current() || state.busy || (!state.pending && (!state.order || (state.order.terminal && !refundPending(state.order))))) return;
    if (now() - windowStart > 20 * 60_000) { windowStart = now(); polls = 0; }
    if (polls >= 20 || (state.error === 'UNAUTHORIZED')) return;
    const delay = Math.max(5000, Math.min(60000, (state.order?.poll_after_seconds ?? 5) * 1000));
    timer = setTimeout(() => { polls++; void refresh(); }, Math.max(delay, (state.retryAt ?? 0) - now()));
  };
  const run = async (job: (signal: AbortSignal) => Promise<void>) => {
    if (!current() || state.busy || (state.retryAt !== null && now() < state.retryAt)) return;
    checkoutFresh = false; request = new AbortController(); const local = request; emit({ busy: true, error: '', retryAt: null }); stopTimer();
    try { await job(local.signal); check(); }
    catch (error) {
      if (current() && !local.signal.aborted) {
        const code = error instanceof PaymentError ? error.code : 'NETWORK_ERROR';
        emit({ error: code, ...(error instanceof PaymentError && error.status === 429 ? { retryAt: now() + 60_000 } : {}), ...(state.pending ? { phase: 'result' as const } : {}) });
      }
    } finally { if (request === local) request = null; emit({ busy: false }); schedule(); }
  };
  const recoverPending = async (signal: AbortSignal) => {
    const pending = state.pending; if (!pending) return;
    try { await accept(await deps.client.byKey(pending.request.client_request_id, signal), pending.request.client_request_id); }
    catch (error) {
      check();
      // Only this structured response from Q proves that Q has not reserved the key.
      // Replaying Q's same idempotent command never authorizes repeating a vendor write.
      if (!(error instanceof PaymentError && error.status === 404 && error.code === 'PAYMENT_NOT_FOUND')) throw error;
      if (!state.capabilities?.enabled || !state.capabilities.channels.some(c => c.id === pending.channel && c.enabled)) fail('PAYMENTS_UNAVAILABLE');
      const marked = await deps.journal.save({ ...pending, possiblySent: true }); check(); emit({ pending: marked });
      await accept(await deps.client.create(marked.request, signal), marked.request.client_request_id);
    }
  };
  const refresh = () => run(async signal => {
    if (!state.capabilities?.enabled) {
      const caps = await deps.client.capabilities(signal); check();
      emit({ capabilities: caps, serverOffset: Date.parse(caps.server_time) - now(), ...(!state.pending && !state.order ? { phase: caps.enabled ? 'amount' as const : 'unavailable' as const } : {}) });
    }
    if (state.pending) await recoverPending(signal);
    else if (state.order) {
      const id = state.order.payment_id; const order = await deps.client.get(id, signal); check();
      if (order.payment_id !== id) fail('PAYMENT_RESPONSE_MISMATCH'); await accept(order);
    }
    else { const order = await deps.client.active(signal); check(); if (order) await accept(order); }
  });
  return {
    getSnapshot: () => state,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    load: () => run(async signal => {
      const pending = await deps.journal.read(); check(); emit({ pending });
      const caps = await deps.client.capabilities(signal); check();
      emit({ capabilities: caps, phase: pending ? 'result' : caps.enabled ? 'amount' : 'unavailable', serverOffset: Date.parse(caps.server_time) - now() });
      if (pending) await recoverPending(signal);
      else { const order = await deps.client.active(signal); check(); if (order) await accept(order); }
    }),
    quote: (amount: string, channel: PaymentChannel) => run(async signal => {
      const caps = state.capabilities; const minor = amountMinor(amount);
      if (!canStart()) fail('PAYMENT_OPERATION_PENDING');
      if (!caps?.enabled || !caps.channels.some(c => c.id === channel && c.enabled)) fail('PAYMENTS_UNAVAILABLE');
      if (minor === null || caps.min_credit_amount_minor_hkd === null || caps.max_credit_amount_minor_hkd === null || minor < caps.min_credit_amount_minor_hkd || minor > caps.max_credit_amount_minor_hkd) fail('INVALID_AMOUNT');
      emit({ quote: null });
      const quote = await deps.client.quote({ channel, credit_amount_minor_hkd: minor }, signal); check();
      if (quote.account_id !== deps.identity.ownerId || quote.channel !== channel || quote.credit_amount_minor_hkd !== minor || Date.parse(quote.expires_at) <= Date.parse(quote.server_time)) fail('PAYMENT_RESPONSE_MISMATCH');
      emit({ quote, phase: 'review', order: null, serverOffset: Date.parse(quote.server_time) - now() });
    }),
    confirm: () => run(async signal => {
      const quote = state.quote; if (!quote || state.phase !== 'review' || !canStart()) fail('PAYMENT_QUOTE_REQUIRED');
      if (!state.capabilities?.enabled || !state.capabilities.channels.some(c => c.id === quote.channel && c.enabled)) fail('PAYMENTS_UNAVAILABLE');
      if (Date.parse(quote.expires_at) <= now() + state.serverOffset) fail('PAYMENT_QUOTE_EXPIRED');
      const pending: PendingPayment = { version: 1, origin: deps.client.origin, ownerId: deps.identity.ownerId, request: { quote_id: quote.quote_id, client_request_id: deps.newId() }, creditAmount: quote.credit_amount_minor_hkd, channel: quote.channel, possiblySent: false };
      await deps.journal.save(pending); check(); emit({ pending, phase: 'submitting' });
      const marked = await deps.journal.save({ ...pending, possiblySent: true }); check(); emit({ pending: marked });
      // Recovery first queries the original key and only replays this exact Q command on Q's explicit not-found response.
      await accept(await deps.client.create(marked.request, signal), marked.request.client_request_id);
    }),
    refresh,
    edit: () => { if (!state.busy && canStart()) emit({ phase: 'amount', quote: null, order: null, error: '' }); },
    detach: () => run(async signal => {
      const order = state.order; if (!order?.can_detach_checkout || !state.capabilities?.checkout_detach_supported) fail('PAYMENT_DETACH_UNAVAILABLE');
      const result = await deps.client.detach(order.payment_id, signal); check();
      if (result.payment.payment_id !== order.payment_id || !result.payment.checkout_detached) fail('PAYMENT_RESPONSE_MISMATCH');
      await accept(result.payment);
      if (result.active_payment) await accept(result.active_payment);
      if (!result.can_start_new_checkout || !result.payment.safe_to_start_new) fail('PAYMENT_OPERATION_PENDING');
    }),
    select: (order: PaymentOrder) => run(async signal => {
      const result = await deps.client.get(order.payment_id, signal); check();
      if (result.payment_id !== order.payment_id) fail('PAYMENT_RESPONSE_MISMATCH'); await accept(result);
    }),
    loadOrders: async (view: 'pending' | 'history', more = false) => {
      if (!current() || (state.orders.busy && state.orders.view === view)) return; const version = ++historyVersion;
      const cursor = more && state.orders.view === view ? state.orders.cursor : null;
      if (more && !cursor) return;
      historyRequest?.abort(); const local = new AbortController(); historyRequest = local;
      emit({ orders: { view, items: more ? state.orders.items : [], cursor, busy: true, error: '' } });
      try {
        const page = await deps.client.orders(view, cursor, local.signal); if (!current() || local.signal.aborted || version !== historyVersion) return;
        if (page.items.some(order => order.account_id !== deps.identity.ownerId)) fail('PAYMENT_RESPONSE_MISMATCH');
        const items = new Map((more ? state.orders.items : []).map(order => [order.payment_id, order])); for (const order of page.items) items.set(order.payment_id, order);
        emit({ orders: { view, items: [...items.values()].slice(-500), cursor: page.next_cursor, busy: false, error: '' } });
      } catch { if (current() && version === historyVersion) emit({ orders: { ...state.orders, busy: false, error: local.signal.aborted ? '' : 'PAYMENT_HISTORY_UNAVAILABLE' } }); }
      finally { if (historyRequest === local) historyRequest = null; }
    },
    openCheckout: async (open: (url: string) => Promise<unknown>) => {
      const order = state.order; if (!current() || !active || state.busy || !checkoutFresh || !order || order.status !== 'awaiting_payment' || order.checkout_detached || order.terminal || !safeCheckout(order.checkout_url) || Date.parse(order.checkout_expires_at) <= now() + state.serverOffset) return;
      // Explicit user action only; browser return is never credit evidence.
      try { check(); await open(order.checkout_url); } catch { emit({ error: 'PAYMENT_CHECKOUT_UNAVAILABLE' }); }
    },
    setActive: (value: boolean) => {
      if (!value || !active) checkoutFresh = false;
      if (value && !active) { polls = 0; windowStart = now(); } active = value;
      if (!value) { stopTimer(); request?.abort(); cancelHistory(); } else { schedule(); void refresh(); }
    },
    dispose: () => { cancelHistory(); disposed = true; active = false; request?.abort(); stopTimer(); listeners.clear(); },
  };
}
export type FundingController = ReturnType<typeof createFundingController>;

/** Independent selected-order reads never replace the primary funding/recovery state. */
export function createPaymentDetailController(deps: {
  client: PaymentClient; ownerId: string; isCurrent(): boolean; canDetach(): boolean;
  onChanged?(): void | Promise<void>; onCredited?(order: PaymentOrder): void | Promise<void>; onRefundChanged?(order: PaymentOrder): void | Promise<void>;
}) {
  let state: { paymentId: string | null; order: PaymentOrder | null; busy: boolean; error: string; serverOffset: number } = { paymentId: null, order: null, busy: false, error: '', serverOffset: 0 };
  let active = false; let disposed = false; let checkoutFresh = false; let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null; let polls = 0; let retryAt = 0;
  const listeners = new Set<() => void>(); const credited = new Set<string>();
  const refunds = new Map<string, string>();
  const current = () => !disposed && deps.isCurrent();
  const emit = (patch: Partial<typeof state>) => { if (current()) { state = { ...state, ...patch }; for (const listener of listeners) listener(); } };
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  const cancel = () => {
    checkoutFresh = false; stop(); request?.abort(); request = null;
    // A synchronous disconnect fences publication, but a reconnect may reuse this
    // reader. Always release its internal request state without notifying that identity.
    if (current()) emit({ busy: false }); else state = { ...state, busy: false };
  };
  const schedule = () => {
    stop();
    if (!current() || !active || state.busy || !state.paymentId || (state.order?.terminal && !refundPending(state.order)) || (state.order?.status === 'review_required' && !refundPending(state.order)) || state.error === 'UNAUTHORIZED' || polls >= 20) return;
    const delay = Math.max(5000, Math.min(60000, (state.order?.poll_after_seconds ?? 10) * 1000));
    timer = setTimeout(() => { polls++; void refresh(); }, Math.max(delay, retryAt - Date.now()));
  };
  const accept = async (value: PaymentOrder, id: string) => {
    const order = decodeOrder(value); const previous = state.order;
    if (order.payment_id !== id || order.account_id !== deps.ownerId || (previous && (frozenFields.some(field => previous[field] !== order[field]) || previous.client_request_id !== order.client_request_id || order.evidence_version < previous.evidence_version || (previous.status === 'credited' && order.status !== 'credited') || refundRegressed(previous, order)))) throw new PaymentError('PAYMENT_RESPONSE_MISMATCH');
    const previousRefund = refunds.get(id); const previousCredit = credited.has(id);
    refunds.set(id, refundRevision(order));
    emit({ order, error: '', serverOffset: Date.parse(order.server_time) - Date.now() }); checkoutFresh = true;
    if (order.status === 'credited' && !credited.has(id)) { credited.add(id); try { await deps.onCredited?.(order); } catch { /* Balance refresh cannot reverse confirmed credit. */ } }
    if (!current() || !active || state.paymentId !== id || request?.signal.aborted) return;
    if (order.refund_status && previousRefund !== refundRevision(order) && (previousRefund !== undefined || previousCredit || order.status !== 'credited')) {
      try { await deps.onRefundChanged?.(order); } catch { /* Keep the acknowledged refund if its balance read failed. */ }
    }
  };
  const run = async (job: (id: string, signal: AbortSignal) => Promise<PaymentOrder>, changed = false) => {
    const id = state.paymentId;
    if (!current() || !active || !id || state.busy || Date.now() < retryAt) return;
    checkoutFresh = false; stop(); const local = new AbortController(); request = local; emit({ busy: true, error: '' });
    try {
      const order = await job(id, local.signal);
      if (!current() || !active || local.signal.aborted || request !== local || state.paymentId !== id) return;
      await accept(order, id);
      if (changed && current() && !local.signal.aborted) await deps.onChanged?.();
    } catch (error) {
      if (current() && !local.signal.aborted && request === local) {
        if (error instanceof PaymentError && error.status === 429) retryAt = Date.now() + 60_000;
        emit({ error: error instanceof PaymentError ? error.code : 'NETWORK_ERROR' });
      }
    } finally { if (request === local) { request = null; emit({ busy: false }); schedule(); } }
  };
  function refresh() { return run((id, signal) => deps.client.get(id, signal)); }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id: string) { cancel(); polls = 0; retryAt = 0; emit({ paymentId: id, order: null, error: '', serverOffset: 0 }); void refresh(); },
    refresh,
    detach: () => run(async (id, signal) => {
      if (!state.order?.can_detach_checkout || !deps.canDetach()) throw new PaymentError('PAYMENT_DETACH_UNAVAILABLE');
      const result = await deps.client.detach(id, signal);
      if (result.payment.payment_id !== id || !result.payment.checkout_detached) throw new PaymentError('PAYMENT_RESPONSE_MISMATCH');
      return result.payment;
    }, true),
    async openCheckout(open: (url: string) => Promise<unknown>) {
      if (!current() || !active || state.busy) return;
      const selected = state.paymentId;
      await refresh();
      const order = state.order;
      if (!current() || !active || state.busy || !checkoutFresh || !order || order.payment_id !== selected || order.status !== 'awaiting_payment' || order.checkout_detached || order.terminal || !safeCheckout(order.checkout_url) || Date.parse(order.checkout_expires_at) <= Date.now() + state.serverOffset) return;
      try { await open(order.checkout_url); } catch { if (current() && active && state.paymentId === order.payment_id) emit({ error: 'PAYMENT_CHECKOUT_UNAVAILABLE' }); }
    },
    setActive(value: boolean) { if (!value) { active = false; cancel(); } else if (!active) { active = true; polls = 0; void refresh(); } },
    dispose() { cancel(); disposed = true; active = false; listeners.clear(); },
  };
}
