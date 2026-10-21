import { createDeletionStore } from './deletion-core';

// A deletion recovery capability is sensitive: never put it in browser persistence.
const memory = new Map<string, string>();
export const deletionStore = createDeletionStore({
  get: async key => memory.get(key) ?? null,
  set: async (key, value) => { memory.set(key, value); },
  remove: async key => { memory.delete(key); },
});
