type Listener = () => void;

/** Permission is limited to the current signed-in session and is never persisted. */
export function createAiPermission() {
  let owner: string | null = null;
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One view cannot prevent revocation elsewhere. */ }
    }
  };
  return {
    allows: (identity: string) => identity.length > 0 && identity === owner,
    grant(identity: string) {
      if (!identity) return;
      owner = identity;
      notify();
    },
    revoke() { owner = null; notify(); },
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const permission = createAiPermission();
export const revokeAiConsent = permission.revoke;
export const subscribeAiConsent = permission.subscribe;
export const hasAiConsent = permission.allows;

/** A confirmation cannot authorize a request from a different account or generation. */
export function createAiConsentGate<T>(shared = permission) {
  let pending: { identity: string; generation: number; value: T } | null = null;
  return {
    request(identity: string, generation: number, value: T) {
      if (shared.allows(identity)) return true;
      pending = { identity, generation, value };
      return false;
    },
    approve(identity: string, generation: number): T | null {
      const request = pending;
      pending = null;
      if (!request || !identity || request.identity !== identity || request.generation !== generation) return null;
      shared.grant(identity);
      return request.value;
    },
    cancel() { pending = null; },
  };
}
