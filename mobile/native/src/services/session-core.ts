type SessionStorage = {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  remove(): Promise<void>;
};
type SessionListener = (token: string | null) => void;

/** The adapter must be exclusively accessed through this store to preserve ordering. */
export function createSessionStore(storage: SessionStorage): {
  readToken(): Promise<string | null>;
  readSnapshot(): Promise<{ token: string | null; revision: number }>;
  getRevision(): number;
  writeToken(token: string, guard?: () => boolean): Promise<boolean>;
  removeToken(expectedToken?: string): Promise<boolean>;
  invalidateToken(token: string): void;
  subscribe(listener: SessionListener): () => void;
} {
  let tail: Promise<void> = Promise.resolve();
  let revision = 0;
  let observedToken: string | null | undefined;
  const invalidated = new Set<string>();
  const listeners = new Set<SessionListener>();
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const broadcast = (token: string | null) => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        // Also contain a rejected promise if an async callback is passed as void.
        void Promise.resolve(listener(token)).catch(() => undefined);
      } catch { /* A subscriber cannot break storage or other subscribers. */ }
    }
  };
  const restore = (previous: string | null) =>
    previous === null ? storage.remove() : storage.set(previous);
  const readUsable = async () => {
    const stored = await storage.get();
    observedToken = stored !== null && invalidated.has(stored) ? null : stored;
    return observedToken;
  };

  return {
    readToken: () => enqueue(readUsable),
    readSnapshot: () => enqueue(async () => ({ token: await readUsable(), revision })),
    getRevision: () => revision,
    writeToken: (token, guard) => enqueue(async () => {
      const permitted = () => {
        try { return guard ? guard() === true : true; }
        catch { return false; }
      };
      if (!permitted()) return false;
      const previous = await storage.get();
      if (!permitted()) return false;
      if (invalidated.has(token)) return false;
      if (previous === token) { observedToken = token; return true; }
      try {
        await storage.set(token);
      } catch (error) {
        // A storage adapter may reject after mutation; restore before releasing the queue.
        // If restoration itself fails, propagate that failure rather than claim success.
        await restore(previous);
        throw error;
      }
      if (!permitted() || invalidated.has(token)) {
        await restore(previous);
        return false;
      }
      revision++;
      observedToken = token;
      broadcast(token);
      return true;
    }),
    removeToken: expectedToken => enqueue(async () => {
      const current = await storage.get();
      if (current === null || (expectedToken !== undefined && current !== expectedToken)) return false;
      await storage.remove();
      // invalidateToken already committed the logical transition. Finishing its physical
      // cleanup must not cancel a newer login queued behind this storage operation.
      if (invalidated.has(current)) return true;
      revision++;
      observedToken = null;
      broadcast(null);
      return true;
    }),
    invalidateToken: token => {
      // Logical sign-out is immediate even if secure storage later fails to remove a credential.
      // A stale request cannot invalidate a newer observed account.
      invalidated.add(token);
      if (observedToken === token || observedToken === undefined) {
        observedToken = null;
        revision++;
        broadcast(null);
      }
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
