import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { requestMarketReport } from './client';
import { MarketDataError, marketQueryKey, type MarketQuery, type MarketReport } from './core';

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'cancelled' | 'cooldown';
export type MarketDataState = {
  key: string;
  phase: Phase;
  report: MarketReport | null;
  error: unknown;
  fromCache: boolean;
  expiresAt: number | null;
  nextAllowedAt: number | null;
};
type Request = (query: MarketQuery, signal: AbortSignal) => Promise<MarketReport>;
type Entry = { report: MarketReport; expiresAt: number };
type MarketDataMemory = { cache: Map<string, Entry>; cooldowns: Map<string, number> };
export const createMarketDataMemory = (): MarketDataMemory => ({ cache: new Map(), cooldowns: new Map() });
// Public data only. Navigation/remounting must not bypass provider cooldowns.
const publicMemory = createMarketDataMemory();

const idle = (key: string): MarketDataState => ({ key, phase: 'idle', report: null, error: null, fromCache: false, expiresAt: null, nextAllowedAt: null });
const sourceKey = (query: MarketQuery) => query.kind === 'news' ? query.topic === 'fed' ? 'federal-reserve' : 'gdelt' : query.kind === 'filings' ? 'sec' : 'chainlink';
const lifetime = (query: MarketQuery) => query.kind === 'news' && query.topic !== 'fed' ? 15 * 60_000 : 5 * 60_000;
const minimumInterval = (query: MarketQuery) => query.kind === 'filings' ? 1_000 : query.kind === 'news' && query.topic !== 'fed' ? 5_000 : 2_000;

/** An in-memory request owner; no account, persistence, automatic request, or retry. */
export class MarketDataSession {
  private query: MarketQuery;
  private enabled = false;
  private configured = false;
  private epoch = 0;
  private controller: AbortController | null = null;
  private readonly cache: Map<string, Entry>;
  private readonly cooldowns: Map<string, number>;
  state: MarketDataState;

  constructor(query: MarketQuery, private readonly options: {
    request: Request;
    onChange: (state: MarketDataState) => void;
    isCurrent: (key: string) => boolean;
    now?: () => number;
    memory?: MarketDataMemory;
  }) {
    this.query = query;
    const memory = options.memory ?? createMarketDataMemory();
    this.cache = memory.cache;
    this.cooldowns = memory.cooldowns;
    this.state = { ...idle(marketQueryKey(query)), nextAllowedAt: this.cooldowns.get(sourceKey(query)) ?? null };
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private publish(next: MarketDataState) { this.state = next; this.options.onChange(next); }

  configure(query: MarketQuery, enabled: boolean) {
    const key = marketQueryKey(query);
    const initial = !this.configured;
    this.configured = true;
    const changed = key !== this.state.key;
    this.query = query;
    this.enabled = enabled;
    if (changed || !enabled) this.cancel(!changed);
    const entry = this.cache.get(key);
    if (initial || changed || (!this.state.report && entry)) {
      this.publish({ ...idle(key), report: entry?.report ?? null, expiresAt: entry?.expiresAt ?? null, fromCache: Boolean(entry), phase: entry ? 'ready' : 'idle', nextAllowedAt: Math.max(entry?.expiresAt ?? 0, this.cooldowns.get(sourceKey(query)) ?? 0) || null });
    }
  }

  cancel(announce = true) {
    const wasPending = this.controller !== null || this.state.phase === 'loading';
    this.epoch += 1;
    this.controller?.abort();
    this.controller = null;
    if (wasPending) this.publish({ ...this.state, phase: announce ? 'cancelled' : this.state.report ? 'ready' : 'idle', error: null });
  }

  dispose() {
    this.enabled = false;
    this.epoch += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async run() {
    const key = marketQueryKey(this.query);
    if (!this.enabled || !this.options.isCurrent(key) || this.controller) return false;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && now < cached.expiresAt) {
      this.publish({ ...idle(key), phase: 'ready', report: cached.report, expiresAt: cached.expiresAt, fromCache: true, nextAllowedAt: cached.expiresAt });
      return true;
    }
    const source = sourceKey(this.query);
    const nextAllowedAt = this.cooldowns.get(source) ?? 0;
    if (now < nextAllowedAt) {
      this.publish({ ...this.state, phase: 'cooldown', nextAllowedAt, error: null });
      return false;
    }
    const query = this.query;
    const controller = new AbortController();
    this.controller = controller;
    const epoch = ++this.epoch;
    this.cooldowns.set(source, now + minimumInterval(query));
    this.publish({ ...this.state, phase: 'loading', error: null, fromCache: false, nextAllowedAt: now + minimumInterval(query) });
    const current = () => epoch === this.epoch && this.controller === controller && this.enabled && this.options.isCurrent(key) && !controller.signal.aborted;
    try {
      const report = await this.options.request(query, controller.signal);
      if (!current()) return false;
      if (marketQueryKey(report.query) !== key) throw new MarketDataError('invalid_data');
      const expiresAt = this.now() + lifetime(query);
      if (this.cache.size >= 20 && !this.cache.has(key)) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, { report, expiresAt });
      this.publish({ ...idle(key), phase: 'ready', report, expiresAt, nextAllowedAt: Math.max(expiresAt, this.cooldowns.get(source) ?? 0) });
      return true;
    } catch (error) {
      if (!current()) return false;
      const rateLimited = error instanceof MarketDataError && error.code === 'rate_limited';
      const retryAfter = error instanceof MarketDataError ? error.retryAfterMs ?? 0 : 0;
      const cooldown = this.now() + (rateLimited ? Math.max(retryAfter, 60_000) : 15_000);
      this.cooldowns.set(source, cooldown);
      this.publish({ ...this.state, phase: 'error', error, nextAllowedAt: cooldown });
      return false;
    } finally {
      if (epoch === this.epoch && this.controller === controller) this.controller = null;
    }
  }
}

export function useMarketData(query: MarketQuery, active: boolean) {
  const key = marketQueryKey(query);
  const [state, setState] = useState<MarketDataState>(() => idle(key));
  const [clock, setClock] = useState(Date.now);
  const foreground = useRef(AppState.currentState === 'active');
  const current = useRef({ query, key, active });
  const session = useRef<MarketDataSession | null>(null);
  useLayoutEffect(() => {
    current.current = { query, key, active };
    if (!session.current) {
      session.current = new MarketDataSession(query, {
        request: (selected, signal) => requestMarketReport(selected, { transport: expoFetch, signal }),
        onChange: next => { setState(next); setClock(Date.now()); },
        isCurrent: selectedKey => current.current.active && foreground.current && current.current.key === selectedKey,
        memory: publicMemory,
      });
    }
    session.current.configure(query, active && foreground.current);
  }, [query, key, active]);
  useEffect(() => {
    const syncForeground = (next: string | null | undefined) => {
      foreground.current = next === 'active';
      session.current?.configure(current.current.query, current.current.active && foreground.current);
      setClock(Date.now());
    };
    const subscription = AppState.addEventListener('change', syncForeground);
    syncForeground(AppState.currentState);
    return () => { subscription.remove(); session.current?.dispose(); };
  }, []);
  useEffect(() => {
    const next = [state.expiresAt, state.nextAllowedAt].filter((value): value is number => value !== null && value > clock).sort((a, b) => a - b)[0];
    if (!next || !active) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(1, next - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [active, state.expiresAt, state.nextAllowedAt, clock]);
  const visible = state.key === key ? state : idle(key);
  return {
    ...visible,
    stale: Boolean(visible.report && (visible.report.freshness === 'stale' || (visible.expiresAt !== null && clock >= visible.expiresAt))),
    coolingDown: visible.nextAllowedAt !== null && clock < visible.nextAllowedAt,
    run: () => {
      foreground.current = AppState.currentState === 'active';
      session.current?.configure(current.current.query, current.current.active && foreground.current);
      void session.current?.run();
    },
    cancel: () => session.current?.cancel(),
  };
}
