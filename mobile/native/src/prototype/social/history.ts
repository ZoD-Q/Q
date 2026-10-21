import type { SocialMessage } from '@xiaoq/shared';
import { SocialError } from './core';

export function mergeHistory(existing: SocialMessage[], incoming: SocialMessage[], conversationId: string) {
  if (incoming.some(item => item.conversation_id !== conversationId)) throw new SocialError('INVALID_RESPONSE');
  const messages = new Map(existing.map(item => [item.id, item]));
  for (const item of incoming) messages.set(item.id, item);
  const result = [...messages.values()].sort((a, b) => a.seq - b.seq);
  if (result.some((item, index) => index > 0 && item.seq === result[index - 1].seq)) throw new SocialError('INVALID_RESPONSE');
  return result;
}

export function validateForwardPage(items: SocialMessage[], cursor: number, next: number, hasMore: boolean) {
  if (items.some((item, index) => item.seq !== cursor + index + 1) || next < cursor || (!items.length && next !== cursor) || (hasMore && next <= cursor)) throw new SocialError('INVALID_RESPONSE');
}
