import * as SecureStore from 'expo-secure-store';
import { createDeletionStore } from './deletion-core';

export const deletionStore = createDeletionStore({
  get: SecureStore.getItemAsync,
  set: SecureStore.setItemAsync,
  remove: SecureStore.deleteItemAsync,
});
