import { createSerialQueue } from '@/utils/serial-queue';
import { parsePendingTransfer, pendingTransferKey, type PendingTransfer } from './pending-transfer-data';

// Only an unresolved transfer intent is persisted. Authentication tokens stay in memory.
const enqueue = createSerialQueue();
export const readPendingTransfer = (senderId: string) => enqueue(async () => parsePendingTransfer(localStorage.getItem(pendingTransferKey(senderId)), senderId));
export const savePendingTransfer = (intent: PendingTransfer) => enqueue(async () => {
  const key = pendingTransferKey(intent.sender_id);
  const existing = parsePendingTransfer(localStorage.getItem(key), intent.sender_id);
  if (existing && existing.request.idempotency_key !== intent.request.idempotency_key) throw new Error('Unresolved transfer already exists');
  localStorage.setItem(key, JSON.stringify(intent));
});
export const clearPendingTransfer = (senderId: string, key: string) => enqueue(async () => {
  const storageKey = pendingTransferKey(senderId);
  const current = parsePendingTransfer(localStorage.getItem(storageKey), senderId);
  if (current?.request.idempotency_key === key) localStorage.removeItem(storageKey);
});
