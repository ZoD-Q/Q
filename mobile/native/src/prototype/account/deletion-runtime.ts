import { fetch as expoFetch } from 'expo/fetch';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync, randomUUID } from 'expo-crypto';
import { API_URL } from '../../services/api';
import { invalidateToken, readSessionSnapshot, removeToken } from '../../services/session-store';
import { workbenchRequest } from '../api-workbench/core';
import { outboxStore } from '../social/outbox-store';
import { reportStore } from '../social/report-store';
import { createDeletionController, decodeDeletionReceipt, DeletionError, encodeDeletionRecovery } from './deletion-core';
import { deletionStore } from './deletion-store';

export const deletionController = createDeletionController({
  pending: deletionStore,
  session: { readSnapshot: readSessionSnapshot, invalidateToken, removeToken },
  createRecovery: async () => {
    try {
      // The async native/WebCrypto API has no Math.random development fallback.
      const bytes = await getRandomBytesAsync(32);
      return { requestId: randomUUID(), recoveryToken: encodeDeletionRecovery(bytes) };
    } catch { throw new DeletionError('RECOVERY_UNAVAILABLE'); }
  },
  hashToken: token => digestStringAsync(CryptoDigestAlgorithm.SHA256, token),
  cleanupOwner: async ownerId => {
    const results = await Promise.allSettled([outboxStore.purgeOwner(ownerId), reportStore.purgeOwner(ownerId)]);
    if (results.some(result => result.status === 'rejected')) throw new DeletionError('DELETION_CLEANUP_PENDING');
  },
  erase: (token, body, signal) => workbenchRequest({
    baseUrl: API_URL, path: '/v1/account/deletions', method: 'POST', token, body, signal,
    timeoutMs: 30000, decode: decodeDeletionReceipt, transport: expoFetch,
  }),
  lookup: (body, signal) => workbenchRequest({
    baseUrl: API_URL, path: '/v1/account/deletions/status', method: 'POST', body, signal,
    timeoutMs: 15000, decode: decodeDeletionReceipt, transport: expoFetch,
  }),
});
