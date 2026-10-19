import * as SecureStore from 'expo-secure-store';
import { createOutboxStore } from './core';

export const outboxStore = createOutboxStore({ get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync });
