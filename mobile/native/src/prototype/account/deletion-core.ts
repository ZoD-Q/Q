export type DeletionActor = { ownerId: string; token: string };
export type DeletionIntent = {
  ownerId: string;
  requestId: string;
  recoveryToken: string;
  originalTokenHash: string;
};
export type DeletionReceipt = { request_id: string; status: 'deleted'; completed_at: string };
export type DeletionBody = {
  request_id: string;
  recovery_token: string;
  password: string;
  confirmation: 'DELETE';
};
export type DeletionLookup = Pick<DeletionBody, 'request_id' | 'recovery_token'>;
type Storage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
type Phase = 'idle' | 'pending' | 'deleting' | 'checking' | 'unknown' | 'not_found' | 'blocked' | 'deleted';
export type DeletionSnapshot = {
  loading: boolean;
  busy: boolean;
  pending: Pick<DeletionIntent, 'ownerId' | 'requestId'> | null;
  pendingItems: Pick<DeletionIntent, 'ownerId' | 'requestId'>[];
  selectedOwnerId: string | null;
  phase: Phase;
  error: string;
  completedAt: string | null;
};

export class DeletionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DeletionError'; this.code = code; }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const code = (error: unknown) => record(error) && typeof error.code === 'string' ? error.code : 'NETWORK_ERROR';
const isNotFound = (error: unknown) =>
  record(error) && error.status === 404 && error.code === 'ACCOUNT_DELETION_NOT_FOUND';
const meta = (intent: DeletionIntent) => ({ ownerId: intent.ownerId, requestId: intent.requestId });
const sameIntent = (a: DeletionIntent, b: DeletionIntent) => a.ownerId === b.ownerId && a.requestId === b.requestId &&
  a.recoveryToken === b.recoveryToken && a.originalTokenHash === b.originalTokenHash;

export function decodeDeletionIntent(value: unknown): DeletionIntent {
  if (!record(value) || Object.keys(value).some(key => !['ownerId', 'requestId', 'recoveryToken', 'originalTokenHash'].includes(key)) ||
    !uuid(value.ownerId) || !uuid(value.requestId) || typeof value.recoveryToken !== 'string' ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.recoveryToken) ||
    typeof value.originalTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.originalTokenHash)) {
    throw new DeletionError('STORAGE_ERROR');
  }
  return { ownerId: value.ownerId.toLowerCase(), requestId: value.requestId.toLowerCase(),
    recoveryToken: value.recoveryToken, originalTokenHash: value.originalTokenHash };
}

export function decodeDeletionReceipt(value: unknown): DeletionReceipt {
  if (!record(value) || !uuid(value.request_id) || value.status !== 'deleted' ||
    typeof value.completed_at !== 'string' || value.completed_at.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.completed_at) ||
    !Number.isFinite(Date.parse(value.completed_at))) throw new DeletionError('INVALID_RESPONSE');
  return { request_id: value.request_id.toLowerCase(), status: 'deleted', completed_at: value.completed_at };
}

/** Encode exactly 32 cryptographically random bytes without padding or a Buffer dependency. */
export function encodeDeletionRecovery(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new DeletionError('RECOVERY_UNAVAILABLE');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '', bits = 0, buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; result += alphabet[(buffer >>> bits) & 63]; }
  }
  if (bits) result += alphabet[(buffer << (6 - bits)) & 63];
  return result;
}

export const DELETION_LEGACY_KEY = 'q.account.deletion.v1';
export const DELETION_INDEX_KEY = 'q.account.deletion.v2.index';
export const DELETION_PENDING_LIMIT = 32;
export const deletionOwnerKey = (owner: string) => {
  if (!uuid(owner)) throw new DeletionError('STORAGE_ERROR');
  return `q.account.deletion.v2.${owner.toLowerCase()}`;
};

/** One unresolved deletion per owner. Secrets stay in separate bounded SecureStore values. */
export function createDeletionStore(storage: Storage) {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action); tail = result.catch(() => undefined); return result;
  };
  const readOwner = async (owner: string): Promise<DeletionIntent | null> => {
    try {
      const raw = await storage.get(deletionOwnerKey(owner));
      if (raw === null) return null;
      if (raw.length > 1024) throw new DeletionError('STORAGE_ERROR');
      const intent = decodeDeletionIntent(JSON.parse(raw));
      if (intent.ownerId !== owner.toLowerCase()) throw new DeletionError('STORAGE_ERROR');
      return intent;
    } catch { throw new DeletionError('STORAGE_ERROR'); }
  };
  const readIndex = async (): Promise<string[]> => {
    const raw = await storage.get(DELETION_INDEX_KEY);
    if (raw === null) return [];
    if (raw.length > 1800) throw new DeletionError('STORAGE_ERROR');
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 2 || !Array.isArray(value.owners) ||
      value.owners.length > DELETION_PENDING_LIMIT || value.owners.some(owner => !uuid(owner))) {
      throw new DeletionError('STORAGE_ERROR');
    }
    const owners = (value.owners as string[]).map(owner => owner.toLowerCase());
    if (new Set(owners).size !== owners.length) throw new DeletionError('STORAGE_ERROR');
    return owners;
  };
  const writeIndex = async (owners: string[]) => {
    if (owners.length) await storage.set(DELETION_INDEX_KEY, JSON.stringify({ version: 2, owners }));
    else await storage.remove(DELETION_INDEX_KEY);
  };
  const registerOwner = async (owner: string) => {
    const owners = await readIndex();
    if (owners.includes(owner)) return;
    const active: string[] = [];
    for (const existing of owners) if (await readOwner(existing)) active.push(existing);
    if (active.length === DELETION_PENDING_LIMIT) throw new DeletionError('DELETION_PENDING_LIMIT');
    // A discoverable index reservation always precedes its secret record.
    await writeIndex([...active, owner]);
  };
  const migrate = async () => {
    const raw = await storage.get(DELETION_LEGACY_KEY);
    if (raw === null) return;
    if (raw.length > 1024) throw new DeletionError('STORAGE_ERROR');
    const legacy = decodeDeletionIntent(JSON.parse(raw)), existing = await readOwner(legacy.ownerId);
    if (existing && !sameIntent(existing, legacy)) throw new DeletionError('DELETION_PENDING');
    await registerOwner(legacy.ownerId);
    if (!existing) await storage.set(deletionOwnerKey(legacy.ownerId), JSON.stringify(legacy));
    // If copy rejects after mutation, retain v1; the next pass compares the same intent.
    await storage.remove(DELETION_LEGACY_KEY);
  };
  const guarded = <T,>(action: () => Promise<T>) => run(async () => {
    try { await migrate(); return await action(); }
    catch (failure) {
      if (failure instanceof DeletionError) throw failure;
      throw new DeletionError('STORAGE_ERROR');
    }
  });
  return {
    read: (owner: string) => guarded(() => readOwner(owner)),
    list: () => guarded(async () => {
      const result: DeletionIntent[] = [];
      for (const owner of await readIndex()) {
        const intent = await readOwner(owner);
        // An index-only reservation cannot have dispatched a deletion.
        if (intent) result.push(intent);
      }
      return result;
    }),
    save: (input: DeletionIntent) => guarded(async () => {
      const intent = decodeDeletionIntent(input), existing = await readOwner(intent.ownerId);
      if (existing) {
        if (!sameIntent(existing, intent)) throw new DeletionError('DELETION_PENDING');
        return existing;
      }
      // A rejected write may have mutated storage: do not remove or replace its recovery data.
      await registerOwner(intent.ownerId);
      await storage.set(deletionOwnerKey(intent.ownerId), JSON.stringify(intent));
      return intent;
    }),
    remove: (expected: DeletionIntent) => guarded(async () => {
      const existing = await readOwner(expected.ownerId);
      if (!existing) return;
      if (!sameIntent(existing, expected)) throw new DeletionError('DELETION_PENDING');
      await storage.remove(deletionOwnerKey(expected.ownerId));
      await writeIndex((await readIndex()).filter(owner => owner !== expected.ownerId));
    }),
  };
}

type Dependencies = {
  pending: ReturnType<typeof createDeletionStore>;
  session: {
    readSnapshot(): Promise<{ token: string | null; revision: number }>;
    invalidateToken(token: string): void;
    removeToken(expectedToken: string): Promise<boolean>;
  };
  createRecovery(): Promise<{ requestId: string; recoveryToken: string }>;
  hashToken(token: string): Promise<string>;
  cleanupOwner(ownerId: string): Promise<void>;
  erase(token: string, body: DeletionBody, signal: AbortSignal): Promise<unknown>;
  lookup(body: DeletionLookup, signal: AbortSignal): Promise<unknown>;
};

/** Independent of screen/account lifetimes: a late verified result still cleans only its own token. */
export function createDeletionController(deps: Dependencies) {
  let snapshot: DeletionSnapshot = { loading: true, busy: false, pending: null, pendingItems: [], selectedOwnerId: null, phase: 'idle', error: '', completedAt: null };
  const intents = new Map<string, DeletionIntent>();
  const verified = new Map<string, DeletionReceipt>();
  const views = new Map<string, Pick<DeletionSnapshot, 'phase' | 'error' | 'completedAt'>>();
  let selectedOwnerId: string | null = null;
  let cancelled = false;
  let request: AbortController | null = null;
  const tokens = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const key = (intent: DeletionIntent) => `${intent.ownerId}:${intent.requestId}`;
  const emit = (patch: Partial<DeletionSnapshot> = {}) => {
    const pending = selectedOwnerId ? intents.get(selectedOwnerId) : null;
    const view = views.get(selectedOwnerId ?? '') ?? { phase: pending ? 'pending' : 'idle', error: '', completedAt: null };
    snapshot = { ...snapshot, ...view, ...patch, selectedOwnerId, pending: pending ? meta(pending) : null,
      pendingItems: [...intents.values()].map(meta) };
    for (const listener of listeners) { try { listener(); } catch { /* Views cannot interrupt recovery. */ } }
  };
  const show = (owner: string | null, patch?: Partial<Pick<DeletionSnapshot, 'phase' | 'error' | 'completedAt'>>) => {
    selectedOwnerId = owner;
    if (patch) views.set(owner ?? '', { phase: 'idle', error: '', completedAt: null, ...views.get(owner ?? ''), ...patch });
    emit();
  };
  const update = (owner: string, patch: Partial<Pick<DeletionSnapshot, 'phase' | 'error' | 'completedAt'>>) => {
    views.set(owner, { phase: 'idle', error: '', completedAt: null, ...views.get(owner), ...patch }); emit();
  };
  const remember = (intent: DeletionIntent, actor?: DeletionActor | null) => {
    if (!actor || actor.ownerId !== intent.ownerId) return;
    const known = tokens.get(key(intent)) ?? new Set<string>();
    known.add(actor.token); tokens.set(key(intent), known);
  };
  const call = async <T,>(operation: (signal: AbortSignal) => Promise<T>, recovery = false): Promise<T> => {
    const controller = new AbortController(); request = controller;
    if (cancelled && !recovery) controller.abort();
    try { return await operation(controller.signal); }
    finally { if (request === controller) request = null; }
  };
  const refreshPending = async () => {
    const stored = await deps.pending.list();
    // Preserve an in-memory verified cleanup retry after an ambiguous remove acknowledgement.
    for (const [owner, intent] of intents) if (!verified.has(key(intent))) intents.delete(owner);
    for (const intent of stored) intents.set(intent.ownerId, intent);
    emit();
    return stored;
  };
  const requireActor = async (actor: DeletionActor, intent?: DeletionIntent) => {
    if (cancelled) throw new DeletionError('CANCELLED');
    if (!uuid(actor.ownerId) || !actor.token || (intent && actor.ownerId !== intent.ownerId) ||
      (await deps.session.readSnapshot()).token !== actor.token) throw new DeletionError('DELETION_ACCOUNT_CHANGED');
  };
  const validateConfirmation = (password: string, confirmation: string) => {
    if (!password || Array.from(password).length > 128 || confirmation !== 'DELETE') {
      throw new DeletionError('DELETION_CONFIRMATION_REQUIRED');
    }
  };
  const finish = async (intent: DeletionIntent, value: unknown): Promise<boolean> => {
    const receipt = decodeDeletionReceipt(value);
    if (receipt.request_id !== intent.requestId) throw new DeletionError('INVALID_RESPONSE');
    verified.set(key(intent), receipt);
    update(intent.ownerId, { phase: 'deleted', completedAt: receipt.completed_at, error: '' });
    const known = tokens.get(key(intent)) ?? new Set<string>();
    // Commit logical invalidation immediately, before fallible SecureStore operations.
    for (const token of known) deps.session.invalidateToken(token);
    let cleanupFailed = false;
    // Starting the owner purge fences stale social writes synchronously. It never
    // runs for a missing/unverified receipt and never touches ledger recovery.
    let localCleanup: Promise<boolean>;
    try { localCleanup = deps.cleanupOwner(intent.ownerId).then(() => true, () => false); }
    catch { localCleanup = Promise.resolve(false); }
    try {
      const current = (await deps.session.readSnapshot()).token;
      if (current && await deps.hashToken(current) === intent.originalTokenHash) {
        known.add(current); deps.session.invalidateToken(current);
      }
    } catch { cleanupFailed = true; }
    for (const token of known) {
      try { await deps.session.removeToken(token); }
      catch { cleanupFailed = true; }
    }
    tokens.set(key(intent), known);
    if (!await localCleanup) cleanupFailed = true;
    if (!cleanupFailed) {
      try { await deps.pending.remove(intent); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      intents.set(intent.ownerId, intent);
      update(intent.ownerId, { error: 'DELETION_CLEANUP_PENDING' });
      return false;
    }
    tokens.delete(key(intent)); intents.delete(intent.ownerId);
    update(intent.ownerId, { error: '' });
    return true;
  };
  const inspect = async (intent: DeletionIntent, recovery = false): Promise<DeletionReceipt | null> => {
    try {
      const receipt = decodeDeletionReceipt(await call(signal => deps.lookup({
        request_id: intent.requestId, recovery_token: intent.recoveryToken,
      }, signal), recovery));
      if (receipt.request_id !== intent.requestId) throw new DeletionError('INVALID_RESPONSE');
      return receipt;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const send = async (intent: DeletionIntent, actor: DeletionActor, password: string): Promise<boolean> => {
    remember(intent, actor);
    update(intent.ownerId, { phase: 'deleting', error: '' });
    try {
      const receipt = await call(signal => deps.erase(actor.token, {
        request_id: intent.requestId, recovery_token: intent.recoveryToken, password, confirmation: 'DELETE',
      }, signal));
      return await finish(intent, receipt);
    } catch (error) {
      const original = code(error);
      if (original === 'ACCOUNT_BUSY') {
        update(intent.ownerId, { phase: 'blocked', error: original }); return false;
      }
      // A 401, timeout, cancellation or malformed success is never proof of deletion.
      update(intent.ownerId, { phase: 'checking', error: original });
      try {
        const receipt = await inspect(intent, true);
        if (receipt) return await finish(intent, receipt);
        update(intent.ownerId, { phase: 'not_found', error: original });
      } catch {
        update(intent.ownerId, { phase: 'unknown', error: original });
      }
      return false;
    }
  };
  const run = async (operation: () => Promise<boolean>, owner?: string): Promise<boolean> => {
    if (snapshot.busy) return false;
    if (owner) selectedOwnerId = owner;
    cancelled = false; emit({ busy: true, error: '' });
    try { return await operation(); }
    catch (error) {
      // Surface uncertain storage commits without issuing any write to the server.
      try { await refreshPending(); } catch { /* Keep previously known recovery state. */ }
      const pending = selectedOwnerId ? intents.get(selectedOwnerId) : null;
      show(selectedOwnerId, { error: code(error), phase: pending && verified.has(key(pending)) ? 'deleted' : pending ? 'pending' : 'idle' });
      return false;
    } finally { emit({ busy: false, loading: false }); }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel: () => { cancelled = true; request?.abort(); },
    select: (owner: string) => {
      if (snapshot.busy || !uuid(owner)) return false;
      show(owner.toLowerCase()); return true;
    },
    resetCompleted: () => {
      if (snapshot.busy || snapshot.pending) return;
      show(selectedOwnerId, { phase: 'idle', error: '', completedAt: null });
    },
    load: (owner?: string | null) => run(async () => {
      const stored = await refreshPending();
      show(owner ?? selectedOwnerId ?? stored[0]?.ownerId ?? null);
      return true;
    }),
    begin: (actor: DeletionActor, password: string, confirmation: string) => run(async () => {
      validateConfirmation(password, confirmation);
      await refreshPending();
      if (intents.has(actor.ownerId)) throw new DeletionError('DELETION_PENDING');
      await requireActor(actor);
      const [ids, originalTokenHash] = await Promise.all([deps.createRecovery(), deps.hashToken(actor.token)]);
      await requireActor(actor);
      const intent = decodeDeletionIntent({ ownerId: actor.ownerId, ...ids, originalTokenHash });
      await deps.pending.save(intent);
      intents.set(intent.ownerId, intent); remember(intent, actor);
      update(intent.ownerId, { completedAt: null, phase: 'pending', error: '' });
      await requireActor(actor, intent);
      return send(intent, actor, password);
    }, actor.ownerId),
    check: (actor?: DeletionActor | null, owner?: string) => run(async () => {
      await refreshPending();
      const intent = selectedOwnerId ? intents.get(selectedOwnerId) : null;
      if (!intent) return snapshot.phase === 'deleted';
      remember(intent, actor);
      update(intent.ownerId, { phase: 'checking', error: '' });
      const completed = verified.get(key(intent));
      if (completed) return finish(intent, completed);
      try {
        const receipt = await inspect(intent);
        if (receipt) return finish(intent, receipt);
        update(intent.ownerId, { phase: 'not_found', error: 'ACCOUNT_DELETION_NOT_FOUND' });
      } catch (error) { update(intent.ownerId, { phase: 'unknown', error: code(error) }); }
      return false;
    }, owner),
    retry: (actor: DeletionActor, password: string, confirmation: string) => run(async () => {
      validateConfirmation(password, confirmation);
      await refreshPending();
      const intent = intents.get(actor.ownerId);
      if (!intent) throw new DeletionError(intents.size ? 'DELETION_ACCOUNT_CHANGED' : 'DELETION_PENDING');
      await requireActor(actor, intent);
      remember(intent, actor);
      update(intent.ownerId, { phase: 'checking', error: '' });
      const completed = verified.get(key(intent));
      if (completed) return finish(intent, completed);
      let receipt: DeletionReceipt | null;
      try { receipt = await inspect(intent); }
      catch (error) { update(intent.ownerId, { phase: 'unknown', error: code(error) }); return false; }
      if (receipt) return finish(intent, receipt);
      // The user explicitly requested this retry. Keep the original capability and request ID.
      await requireActor(actor, intent);
      return send(intent, actor, password);
    }, actor.ownerId),
  };
}
