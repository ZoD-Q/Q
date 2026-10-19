import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import type { AuthResponse, VideoConnection, VideoConnectionRequest, VideoJob, VideoJobRequest } from '@xiaoq/shared';
import { API_URL } from '../../services/api';
import { removeToken, subscribeSession } from '../../services/session-store';
import { useQAccount } from '../account/account-state';
import { decodeConnection, decodeJob, decodeList, isSafeSubmissionRejection, loadWorkbenchSnapshot, workbenchRequest, WorkbenchError, type PendingVideo } from './core';
import { pendingStore } from './pending-store';

type Generation = Pick<VideoJobRequest, 'connection_id' | 'prompt' | 'duration' | 'aspect_ratio'>;

export function useWorkbench() {
  const account = useQAccount();
  const session = account.session;
  const current = useRef<AuthResponse | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const requests = useRef(new Set<AbortController>());
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>('restore');
  const [boundToken, setBoundToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [connections, setConnections] = useState<VideoConnection[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [pending, setPending] = useState<PendingVideo | null>(null);
  const [ready, setReady] = useState(false);
  const isActive = useCallback((active: AuthResponse) => alive.current && current.current === active, []);
  const clear = useCallback(() => {
    generation.current++;
    for (const request of requests.current) request.abort();
    requests.current.clear(); locked.current = false; current.current = null;
    setBoundToken(null); setConnections([]); setJobs([]); setPending(null); setReady(false); setLoadError(null); setError(null); setBusy(null);
  }, []);
  const call = useCallback(async <T,>(path: string, decode: (value: unknown) => T, token: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) => {
    if (!alive.current) throw new WorkbenchError('CANCELLED');
    const controller = new AbortController();
    requests.current.add(controller);
    try { return await workbenchRequest({ baseUrl: API_URL, path, decode, token, method, body, signal: controller.signal, transport: expoFetch }); }
    finally { requests.current.delete(controller); }
  }, []);
  const load = useCallback(async (active: AuthResponse) => {
    if (!isActive(active)) return;
    setReady(false);
    const snapshot = await loadWorkbenchSnapshot({
      pending: () => pendingStore.read(active.user.id),
      connections: () => call('/v1/video/connections', decodeList(decodeConnection), active.token),
      jobs: () => call('/v1/video/jobs', decodeList(decodeJob), active.token),
    });
    if (!isActive(active)) return;
    // Storage corruption keeps pending recovery blocked while server history remains usable.
    if (snapshot.pending.status === 'fulfilled') setPending(snapshot.pending.value);
    if (snapshot.connections.status === 'fulfilled') setConnections(snapshot.connections.value);
    if (snapshot.jobs.status === 'fulfilled') setJobs(snapshot.jobs.value);
    setReady(snapshot.failure === null); setLoadError(snapshot.failure?.reason ?? null);
    if (snapshot.failure) throw snapshot.failure.reason;
  }, [call, isActive]);
  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    if (locked.current || !alive.current) return false;
    const version = generation.current;
    const token = current.current?.token;
    locked.current = true; setBusy(name); setError(null);
    try { await action(); return alive.current && version === generation.current; }
    catch (failure) {
      if (alive.current && version === generation.current) {
        setError(failure);
        if (failure instanceof WorkbenchError && failure.status === 401 && token) {
          clear();
          await removeToken(token).catch(() => { if (alive.current && current.current === null) setError(new WorkbenchError('STORAGE_ERROR')); });
        }
      }
      return false;
    } finally {
      if (alive.current && version === generation.current) { locked.current = false; setBusy(null); }
    }
  }, [clear]);
  const activate = useEffectEvent(() => {
    clear();
    if (!session) return;
    current.current = session; setBoundToken(session.token);
    void run('restore', () => load(session));
  });
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeSession(token => {
      if ((current.current?.token ?? null) !== token) clear();
    });
    const inflight = requests.current;
    const epoch = generation;
    return () => { alive.current = false; epoch.current++; unsubscribe(); for (const request of inflight) request.abort(); };
  }, [clear]);
  useEffect(() => {
    // Bind private workbench state to the globally verified Q identity, including external sign-out.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    activate();
  }, [session?.token]);

  const refresh = () => run('refresh', async () => { if (current.current) await load(current.current); });
  const restore = async () => { await account.refresh(); return true; };
  const logout = async () => { clear(); await account.logout(); return true; };
  const addConnection = (body: VideoConnectionRequest) => run('connection', async () => {
    const active = current.current; if (!active) return;
    const result = await call('/v1/video/connections', decodeConnection, active.token, 'POST', body);
    if (isActive(active)) setConnections(items => [result, ...items]);
  });
  const revokeConnection = (id: string) => run('revoke', async () => {
    const active = current.current; if (!active) return;
    await call('/v1/video/connections/' + encodeURIComponent(id), () => undefined, active.token, 'DELETE');
    if (isActive(active)) setConnections(items => items.map(item => item.id === id ? { ...item, revoked: true } : item));
  });
  const recordJob = (active: AuthResponse, job: VideoJob) => {
    if (isActive(active)) setJobs(items => [job, ...items.filter(item => item.id !== job.id)]);
  };
  const submitPending = async (active: AuthResponse, intent: PendingVideo) => {
    if (!isActive(active)) return;
    let job: VideoJob;
    try { job = await call('/v1/video/jobs', decodeJob, active.token, 'POST', intent.request); }
    catch (failure) {
      if (isSafeSubmissionRejection(failure)) {
        await pendingStore.clear(active.user.id, intent.request.idempotency_key);
        if (isActive(active)) setPending(null);
      }
      throw failure;
    }
    recordJob(active, job);
    await pendingStore.clear(active.user.id, intent.request.idempotency_key);
    if (isActive(active)) setPending(null);
  };
  const createJob = (fields: Generation) => run('create', async () => {
    const active = current.current; if (!active || !ready) return;
    const intent: PendingVideo = { owner_id: active.user.id, request: { ...fields, model_name: 'kling-v2-6', mode: 'pro', idempotency_key: randomUUID() } };
    await pendingStore.save(intent);
    if (!isActive(active)) return;
    setPending(intent);
    await submitPending(active, intent);
  });
  const recover = () => run('recover', async () => {
    const active = current.current; if (!active) return;
    const intent = await pendingStore.read(active.user.id);
    if (!isActive(active)) return;
    if (intent) await submitPending(active, intent);
    await load(active);
  });
  const refreshJob = (id: string) => run('job', async () => {
    const active = current.current; if (!active) return;
    recordJob(active, await call('/v1/video/jobs/' + encodeURIComponent(id), decodeJob, active.token));
  });
  const bound = !!session && boundToken === session.token;
  return { session, busy: account.loading ? 'restore' : account.authBusy ? 'auth' : busy,
    error: error ?? loadError ?? (account.error || account.logoutError ? new WorkbenchError(account.error || account.logoutError) : null),
    connections: bound ? connections : [], jobs: bound ? jobs : [], pending: bound ? pending : null, ready: bound && ready,
    restore, authenticate: account.authenticate, refresh, logout, addConnection, revokeConnection, createJob, recover, refreshJob };
}
