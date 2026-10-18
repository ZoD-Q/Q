import type { Recipient, TransferRequest } from '@xiaoq/shared';

export interface PendingTransfer {
  sender_id: string;
  request: TransferRequest;
  recipient: Recipient;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const pendingTransferKey = (senderId: string) => `xiaoq.pending.v1.${senderId}`;

/** Untrusted browser storage must never select a different sender or alter the payload. */
export function parsePendingTransfer(raw: string | null, senderId: string): PendingTransfer | null {
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingTransfer;
  const request = value?.request;
  const recipient = value?.recipient;
  if (value?.sender_id !== senderId || !uuid.test(senderId) || !request || !recipient ||
      !uuid.test(request.idempotency_key) || !uuid.test(recipient.id) ||
      !/^[a-z0-9_]{3,24}$/.test(request.recipient_handle) || recipient.handle !== request.recipient_handle ||
      !Number.isSafeInteger(request.amount_minor) || request.amount_minor < 1 || request.amount_minor > 100000000 ||
      typeof request.memo !== 'string' || Array.from(request.memo).length > 80 ||
      typeof recipient.display_name !== 'string' || !['orbit', 'leaf', 'spark', 'wave'].includes(recipient.avatar)) {
    throw new Error('Invalid pending transfer recovery data');
  }
  return value;
}
