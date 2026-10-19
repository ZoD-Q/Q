import { createContext, use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import type { AuthResponse } from '@xiaoq/shared';
import { useQAccount } from '../account/account-state';
import { API_URL } from '../../services/api';
import { getSessionRevision, removeToken, subscribeSession } from '../../services/session-store';
import { decodeSnapshot, socialRequest, type SocialSnapshot } from './api';
import { sameStamp, SocialError, type RequestStamp } from './core';

type Call = <T>(path: string, decode: (value: unknown) => T, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal) => Promise<T>;
type SocialState = {
  metadata: SocialSnapshot | null; unreadCount: number; loading: boolean; error: string; ownerId: string | null;
  refresh: () => Promise<void>; call: Call; stamp: () => RequestStamp | null; current: (stamp: RequestStamp | null) => boolean;
  subscribeReset: (listener: () => void) => () => void;
};
const Context = createContext<SocialState | null>(null);
export const socialErrorCode = (error: unknown) => error instanceof SocialError ? error.code : 'REQUEST_FAILED';

export function SocialProvider({ children }: { children: ReactNode }) {
  const { session } = useQAccount();
  const [snapshot, setSnapshot] = useState<{ ownerId: string; token: string; data: SocialSnapshot } | null>(null);
  const metadata = snapshot?.ownerId === session?.user.id && snapshot?.token === session?.token ? snapshot?.data ?? null : null;
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const auth = useRef<AuthResponse | null>(session);
  const epoch = useRef(0), active = useRef(AppState.currentState === 'active'), mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>()), listeners = useRef(new Set<() => void>());
  const polling = useRef(false);
  const stamp = useCallback((): RequestStamp | null => auth.current && active.current && mounted.current ? {
    ownerId: auth.current.user.id, token: auth.current.token, revision: getSessionRevision(), epoch: epoch.current,
  } : null, []);
  const current = useCallback((value: RequestStamp | null) => sameStamp(value, stamp()), [stamp]);
  const invalidate = useCallback(() => {
    epoch.current++;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear(); polling.current = false;
    for (const listener of listeners.current) listener();
    setSnapshot(null); setLoading(false); setError('');
  }, []);
  const call: Call = useCallback(async (path, decode, method = 'GET', body, signal) => {
    const ticket = stamp();
    if (!ticket) throw new SocialError('UNAUTHORIZED');
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) throw new SocialError('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    controllers.current.add(controller);
    try {
      const result = await socialRequest({ baseUrl: API_URL, path, token: ticket.token, decode, method, body, signal: controller.signal, transport: expoFetch });
      if (!current(ticket)) throw new SocialError('CANCELLED');
      return result;
    } catch (failure) {
      if (current(ticket) && failure instanceof SocialError && failure.status === 401) await removeToken(ticket.token);
      throw failure;
    } finally { controllers.current.delete(controller); signal?.removeEventListener('abort', abort); }
  }, [current, stamp]);
  const refresh = useCallback(async () => {
    const ticket = stamp();
    if (!ticket || polling.current) return;
    polling.current = true; setLoading(true);
    try {
      const result = await call('/v1/social/snapshot', decodeSnapshot);
      if (current(ticket)) { setSnapshot({ ownerId: ticket.ownerId, token: ticket.token, data: result }); setError(''); }
    } catch (failure) { if (current(ticket)) setError(socialErrorCode(failure)); }
    finally { if (current(ticket)) { polling.current = false; setLoading(false); } }
  }, [call, current, stamp]);
  useEffect(() => subscribeSession(token => {
    if (auth.current?.token === token) return;
    auth.current = null;
    invalidate();
  }), [invalidate]);
  const accountChanged = useEffectEvent(() => {
    invalidate(); auth.current = session;
    void refresh();
  });
  // Account changes are a privacy boundary; clear private state before the next visible frame.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useLayoutEffect(() => { accountChanged(); }, [session]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', value => {
      active.current = value === 'active';
      invalidate();
      if (active.current) void refresh();
    });
    const interval = setInterval(() => { if (active.current) void refresh(); }, 3000);
    return () => { mounted.current = false; subscription.remove(); clearInterval(interval); invalidate(); };
  }, [invalidate, refresh]);
  const subscribeReset = useCallback((listener: () => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; }, []);
  const muted = new Set(metadata?.friends.filter(item => item.muted).map(item => item.conversation_id));
  const unreadCount = (metadata?.conversations.reduce((total, item) => total + (muted.has(item.id) ? 0 : item.unread_count), 0) ?? 0)
    + (metadata?.notifications.filter(item => !item.read_at).length ?? 0);
  return <Context value={{ metadata, unreadCount, loading, error, ownerId: session?.user.id ?? null, refresh, call, stamp, current, subscribeReset }}>{children}</Context>;
}

export function useSocial() {
  const state = use(Context);
  if (!state) throw new Error('SocialProvider missing');
  return state;
}
