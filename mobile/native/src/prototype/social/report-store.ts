import * as SecureStore from 'expo-secure-store';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { createReportStore } from './report-core';

export const hashReportReason = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
export const reportStore = createReportStore({ get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync }, hashReportReason, true);
