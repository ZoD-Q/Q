import * as SecureStore from 'expo-secure-store';
import { createSerialQueue } from '@/utils/serial-queue';
import { parsePendingTransfer, pendingTransferKey, type PendingTransfer } from './pending-transfer-data';

const enqueue = createSerialQueue();
export const readPendingTransfer = (senderId: string) => enqueue(async () => parsePendingTransfer(await SecureStore.getItemAsync(pendingTransferKey(senderId)), senderId));
export const savePendingTransfer = (intent: PendingTransfer) => enqueue(async () => {
  const key = pendingTransferKey(intent.sender_id);
  const existing = parsePendingTransfer(await SecureStore.getItemAsync(key), intent.sender_id);
  if (existing && existing.request.idempotency_key !== intent.request.idempotency_key) throw new Error('Unresolved transfer already exists');
  await SecureStore.setItemAsync(key, JSON.stringify(intent));
});
export const clearPendingTransfer = (senderId: string, key: string) => enqueue(async () => {
  const storageKey = pendingTransferKey(senderId);
  const current = parsePendingTransfer(await SecureStore.getItemAsync(storageKey), senderId);
  if (current?.request.idempotency_key === key) await SecureStore.deleteItemAsync(storageKey);
});
