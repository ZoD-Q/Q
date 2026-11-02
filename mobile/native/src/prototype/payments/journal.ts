import * as SecureStore from 'expo-secure-store';
import { createPaymentJournal } from './journal-core';
export const paymentJournal = (origin: string, ownerId: string) => createPaymentJournal({
  get: key => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: key => SecureStore.deleteItemAsync(key),
}, origin, ownerId);
