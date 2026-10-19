import { createSessionStore } from './session-core';
// Browser bearer tokens remain memory-only. No localStorage or IndexedDB credentials.
let memoryToken: string | null = null;
const store = createSessionStore({
  get: async () => memoryToken,
  set: async token => { memoryToken = token; },
  remove: async () => { memoryToken = null; },
});
export const { readToken, writeToken, removeToken } = store;
export const subscribeSession = store.subscribe;
export const readSessionSnapshot = store.readSnapshot;
export const getSessionRevision = store.getRevision;
