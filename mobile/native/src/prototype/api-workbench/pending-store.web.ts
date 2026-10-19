import { createPendingStore } from "./core";

// Only the unresolved owner-bound request is persisted. Tokens and provider keys never enter this store.
export const pendingStore = createPendingStore({
  get: async (key) => localStorage.getItem(key),
  set: async (key, value) => { localStorage.setItem(key, value); },
  remove: async (key) => { localStorage.removeItem(key); },
});
