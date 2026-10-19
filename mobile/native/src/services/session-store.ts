import * as SecureStore from 'expo-secure-store';
import { createSessionStore } from './session-core';
const KEY = 'xiaoq.session.v1';
const store = createSessionStore({
  get: () => SecureStore.getItemAsync(KEY),
  set: token => SecureStore.setItemAsync(KEY, token),
  remove: () => SecureStore.deleteItemAsync(KEY),
});
export const { readToken, writeToken, removeToken } = store;
export const subscribeSession = store.subscribe;
export const readSessionSnapshot = store.readSnapshot;
export const getSessionRevision = store.getRevision;
