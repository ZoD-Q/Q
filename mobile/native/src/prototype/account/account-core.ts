import type { AuthResponse, ProfilePatch, User } from '@xiaoq/shared';

type Mode = 'login' | 'register';
export type AccountFields = { handle: string; password: string; display_name?: string };
export type AccountSnapshot = {
  session: AuthResponse | null;
  loading: boolean;
  authBusy: boolean;
  profileBusy: boolean;
  logoutPending: boolean;
  logoutBusy: boolean;
  logoutError: string;
  authOpen: boolean;
  error: string;
};
type SessionStore = {
  readSnapshot(): Promise<{ token: string | null; revision: number }>;
  getRevision(): number;
  writeToken(token: string, guard?: () => boolean): Promise<boolean>;
  removeToken(expectedToken?: string): Promise<boolean>;
  invalidateToken(token: string): void;
  subscribe(listener: (token: string | null) => void): () => void;
};
type Dependencies = {
  store: SessionStore;
  user(token: string, signal: AbortSignal): Promise<User>;
  authenticate(mode: Mode, fields: AccountFields, signal: AbortSignal): Promise<AuthResponse>;
  revoke(token: string, signal: AbortSignal): Promise<void>;
  patch(token: string, fields: ProfilePatch, signal: AbortSignal): Promise<User>;
};
const failure = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : 'NETWORK_ERROR';
const unauthorized = (error: unknown) => error !== null && typeof error === 'object' && 'status' in error && error.status === 401;

/** Shared account view. Storage remains the only session authority; every async result is revision guarded. */
export function createAccountController(deps: Dependencies) {
  let snapshot: AccountSnapshot = { session: null, loading: true, authBusy: false, profileBusy: false, logoutPending: false, logoutBusy: false, logoutError: '', authOpen: false, error: '' };
  let epoch = 0;
  let alive = false;
  let pendingAuth: { epoch: number; result: AuthResponse } | null = null;
  let unsubscribe: (() => void) | null = null;
  type LogoutIntent = { token: string; localDone: boolean; remoteDone: boolean; error: string };
  const logouts = new Map<string, LogoutIntent>();
  let logoutJob: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const active = new Set<AbortController>();
  const emit = (patch: Partial<AccountSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const invalidate = () => {
    epoch++;
    for (const request of active) request.abort();
    active.clear();
    return epoch;
  };
  const current = (version: number, revision?: number) => alive && epoch === version &&
    (revision === undefined || deps.store.getRevision() === revision);
  const call = async <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    active.add(controller);
    try { return await operation(controller.signal); }
    finally { active.delete(controller); }
  };
  const refresh = async () => {
    const version = invalidate();
    emit({ loading: true, authBusy: false, profileBusy: false, error: '' });
    let token: string | null = null;
    try {
      const stored = await deps.store.readSnapshot();
      if (!current(version, stored.revision)) return;
      token = stored.token;
      if (!token) { emit({ session: null }); return; }
      if (snapshot.session?.token !== token) emit({ session: null });
      const user = await call(signal => deps.user(token!, signal));
      if (current(version, stored.revision)) emit({ session: { token, user } });
    } catch (error) {
      if (!current(version)) return;
      emit({ error: failure(error) });
      if (unauthorized(error) && token) {
        emit({ session: null });
        deps.store.invalidateToken(token);
        try { await deps.store.removeToken(token); }
        catch { if (current(version)) emit({ error: 'STORAGE_ERROR' }); }
      }
    } finally { if (current(version)) emit({ loading: false }); }
  };
  const authenticate = async (mode: Mode, fields: AccountFields) => {
    if (snapshot.authBusy) return false;
    const version = invalidate();
    const revision = deps.store.getRevision();
    emit({ authBusy: true, profileBusy: false, loading: false, error: '' });
    try {
      const result = await call(signal => deps.authenticate(mode, fields, signal));
      if (!current(version, revision)) return false;
      pendingAuth = { epoch: version, result };
      let stored: boolean;
      try { stored = await deps.store.writeToken(result.token, () => current(version, revision)); }
      catch { throw { code: 'STORAGE_ERROR' }; }
      finally { if (pendingAuth?.epoch === version) pendingAuth = null; }
      if (!stored || !current(version)) return false;
      emit({ session: result, authOpen: false });
      return true;
    } catch (error) {
      if (current(version)) emit({ error: failure(error) });
      return false;
    } finally { if (current(version)) emit({ authBusy: false }); }
  };
  const publishLogouts = (busy: boolean) => {
    if (alive) emit({ logoutBusy: busy, logoutPending: logouts.size > 0,
      logoutError: [...logouts.values()].find(intent => intent.error === 'STORAGE_ERROR')?.error
        ?? [...logouts.values()].find(intent => intent.error)?.error ?? '' });
  };
  const retryLogout = (): Promise<void> => {
    if (logoutJob) return logoutJob;
    const perform = async () => {
      publishLogouts(true);
      const attempted = new Set<string>();
      // New sign-outs arriving during this bounded job are queued independently by token.
      let intent: LogoutIntent | undefined;
      while ((intent = [...logouts.values()].find(item => !attempted.has(item.token)))) {
        attempted.add(intent.token);
        const target = intent;
        const [local, remote] = await Promise.allSettled([
          target.localDone ? Promise.resolve() : deps.store.removeToken(target.token),
          target.remoteDone ? Promise.resolve() : deps.revoke(target.token, new AbortController().signal)
            .catch(error => { if (!unauthorized(error)) throw error; }),
        ]);
        target.localDone = local.status === 'fulfilled';
        target.remoteDone = remote.status === 'fulfilled';
        target.error = !target.localDone ? 'STORAGE_ERROR' : !target.remoteDone ? 'LOGOUT_UNCONFIRMED' : '';
        if (target.localDone && target.remoteDone) logouts.delete(target.token);
        publishLogouts(true);
      }
      publishLogouts(false);
    };
    // Revocations never share cancellation or identity state with login/profile requests.
    logoutJob = perform().finally(() => { logoutJob = null; });
    return logoutJob;
  };
  const logout = async () => {
    const token = snapshot.session?.token;
    invalidate();
    emit({ session: null, loading: false, authBusy: false, profileBusy: false, authOpen: false, error: '' });
    if (token) {
      if (!logouts.has(token)) logouts.set(token, { token, localDone: false, remoteDone: false, error: '' });
      deps.store.invalidateToken(token);
    }
    await retryLogout();
  };
  const updateProfile = async (fields: ProfilePatch) => {
    const session = snapshot.session;
    if (!session || snapshot.loading || snapshot.authBusy || snapshot.profileBusy) return false;
    const version = epoch;
    const revision = deps.store.getRevision();
    emit({ error: '', profileBusy: true });
    try {
      const user = await call(signal => deps.patch(session.token, fields, signal));
      if (!current(version, revision) || snapshot.session?.token !== session.token) return false;
      emit({ session: { token: session.token, user } });
      return true;
    } catch (error) {
      if (!current(version, revision)) return false;
      emit({ error: failure(error) });
      if (unauthorized(error)) {
        emit({ session: null });
        deps.store.invalidateToken(session.token);
        await deps.store.removeToken(session.token).catch(() => { if (current(version)) emit({ error: 'STORAGE_ERROR' }); });
      }
      return false;
    } finally { if (current(version)) emit({ profileBusy: false }); }
  };
  const onToken = (token: string | null) => {
    if (pendingAuth && pendingAuth.result.token === token && current(pendingAuth.epoch)) {
      emit({ session: pendingAuth.result });
      return;
    }
    if ((snapshot.session?.token ?? null) === token) return;
    invalidate();
    emit({ session: null, loading: token !== null, authBusy: false, profileBusy: false, authOpen: false, error: '' });
    if (token) void refresh();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { alive = true; unsubscribe?.(); unsubscribe = deps.store.subscribe(onToken); void refresh(); },
    stop: () => { alive = false; invalidate(); unsubscribe?.(); unsubscribe = null; },
    refresh,
    authenticate,
    logout,
    retryLogout,
    updateProfile,
    requestAuth: () => emit({ authOpen: true, error: '' }),
    closeAuth: () => {
      if (!snapshot.authOpen && !snapshot.authBusy) return;
      invalidate(); emit({ authOpen: false, authBusy: false, profileBusy: false, loading: false, error: '' });
    },
  };
}
