import type { AdPreferences } from "./policy";

export const AD_PREFERENCE_KEY = "q.finance-ads.preferences.v1";
export type AdPreferenceStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};
export type AdPreferenceSnapshot = Readonly<{
  preferences: AdPreferences;
  hydrated: boolean;
  loading: boolean;
  saving: boolean;
  error: "read" | "write" | null;
}>;
const defaults = (): AdPreferences => ({ enabled: true, hiddenCampaignIds: [] });
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);

export function decodeAdPreferences(raw: string | null): AdPreferences {
  if (raw === null) return defaults();
  if (raw.length > 2048) throw new Error("Invalid ad preferences");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ad preferences");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "enabled" && key !== "hiddenCampaignIds") ||
    typeof record.enabled !== "boolean" || !Array.isArray(record.hiddenCampaignIds) ||
    record.hiddenCampaignIds.length > 24 || !record.hiddenCampaignIds.every(validId)) throw new Error("Invalid ad preferences");
  return { enabled: record.enabled, hiddenCampaignIds: [...new Set<string>(record.hiddenCampaignIds)] };
}

export function displayPreferences(snapshot: AdPreferenceSnapshot): AdPreferences | null {
  return snapshot.hydrated && !snapshot.loading && !snapshot.saving && !snapshot.error ? snapshot.preferences : null;
}

/** Serial, device-level preferences. A failed write never rolls back a refusal. */
export function createAdPreferenceStore(storage: AdPreferenceStorage) {
  let snapshot: AdPreferenceSnapshot = { preferences: defaults(), hydrated: false, loading: true, saving: false, error: null };
  let revision = 0;
  let attempted = false;
  let firstLoad: Promise<boolean> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: AdPreferenceSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const read = (): Promise<boolean> => {
    const generation = ++revision;
    publish({ ...snapshot, loading: true });
    return enqueue(async () => {
      try {
        const preferences = decodeAdPreferences(await storage.get(AD_PREFERENCE_KEY));
        if (revision !== generation) return false;
        publish({ preferences, hydrated: true, loading: false, saving: false, error: null });
        return true;
      } catch {
        if (revision === generation) publish({ ...snapshot, loading: false, error: "read" });
        return false;
      }
    });
  };

  const persist = (preferences: AdPreferences): Promise<boolean> => {
    // Controls remain unavailable before a successful read, preserving unknown saved refusals.
    if (!snapshot.hydrated) return Promise.resolve(false);
    const generation = ++revision;
    const safePreferences = decodeAdPreferences(JSON.stringify(preferences));
    publish({ ...snapshot, preferences: safePreferences, saving: true });
    return enqueue(async () => {
      if (revision !== generation) return false;
      try {
        await storage.set(AD_PREFERENCE_KEY, JSON.stringify(safePreferences));
        if (revision !== generation) return false;
        publish({ ...snapshot, saving: false, error: null });
        return true;
      } catch {
        if (revision === generation) publish({ ...snapshot, saving: false, error: "write" });
        return false;
      }
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hydrate(): Promise<boolean> {
      if (!attempted) { attempted = true; firstLoad = read(); }
      return firstLoad ?? Promise.resolve(snapshot.hydrated);
    },
    setEnabled(enabled: boolean) { return persist({ ...snapshot.preferences, enabled }); },
    hideCampaign(id: string): Promise<boolean> {
      if (!validId(id)) return Promise.resolve(false);
      const hiddenCampaignIds = [...new Set([...snapshot.preferences.hiddenCampaignIds, id])];
      if (hiddenCampaignIds.length > 24) return persist({ ...snapshot.preferences, enabled: false });
      return persist({ ...snapshot.preferences, hiddenCampaignIds });
    },
    retry(): Promise<boolean> {
      // After a write failure, retry the current intent; never reload older saved preferences.
      if (snapshot.hydrated) return persist(snapshot.preferences);
      attempted = true;
      firstLoad = read();
      return firstLoad;
    },
  };
}
