import { createOutboxStore, type PendingSend } from './core';

// Only owner/conversation/client IDs and TTL survive a reload. Never tokens or bodies.
const metadataStore = createOutboxStore({
  get: async key => localStorage.getItem(key),
  set: async (key, value) => { localStorage.setItem(key, value); },
  remove: async key => { localStorage.removeItem(key); },
});
export const outboxStore = {
  ...metadataStore,
  write: (pending: PendingSend, version: string) => metadataStore.write({ ...pending, text: null }, version),
};
