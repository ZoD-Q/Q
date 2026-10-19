import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { createReportStore } from './report-core';

export const hashReportReason = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
export const reportStore = createReportStore({
  get: async key => localStorage.getItem(key),
  set: async (key, value) => { localStorage.setItem(key, value); },
  remove: async key => { localStorage.removeItem(key); },
}, hashReportReason, false);
