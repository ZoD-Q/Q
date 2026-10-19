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
  subscribe(listener: SessionListener): () => void;
} {
  let tail: Promise<void> = Promise.resolve();
  let revision = 0;
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

  return {
    readToken: () => enqueue(() => storage.get()),
    readSnapshot: () => enqueue(async () => ({ token: await storage.get(), revision })),
    getRevision: () => revision,
    writeToken: (token, guard) => enqueue(async () => {
      const permitted = () => {
        try { return guard ? guard() === true : true; }
        catch { return false; }
      };
      if (!permitted()) return false;
      const previous = await storage.get();
      if (!permitted()) return false;
      if (previous === token) return true;
      try {
        await storage.set(token);
      } catch (error) {
        // A storage adapter may reject after mutation; restore before releasing the queue.
        // If restoration itself fails, propagate that failure rather than claim success.
        await restore(previous);
        throw error;
      }
      if (!permitted()) {
        await restore(previous);
        return false;
      }
      revision++;
      broadcast(token);
      return true;
    }),
    removeToken: expectedToken => enqueue(async () => {
      const current = await storage.get();
      if (current === null || (expectedToken !== undefined && current !== expectedToken)) return false;
      await storage.remove();
      revision++;
      broadcast(null);
      return true;
    }),
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
