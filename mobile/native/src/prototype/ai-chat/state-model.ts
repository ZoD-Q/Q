import type { AiHistoryMessage, AiModel, AiFinishReason, AiUsage } from '@xiaoq/shared';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'incomplete' | 'cancelled' | 'error' | 'tool';
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  errorCode?: string;
  model?: AiModel;
  thinking?: boolean;
  finishReason?: AiFinishReason;
  usage?: AiUsage;
  contextLimited?: boolean;
  toolProposalId?: string;
  toolInvocationIds?: string[];
  bankCommand?: boolean;
}
export interface ChatPlugin { id: string; title: string; endpoint_url: string; connection_kind?: 'remote_mcp' | 'bank_demo'; builtin_service_id?: string | null }
export interface Conversation { id: string; title: string; messages: ChatMessage[]; plugin?: ChatPlugin }
export const MODEL_NAMES: Record<AiModel, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-pro': 'DeepSeek Pro',
};
const characters = (value: string) => Array.from(value).length;

/** Send whole completed turns only. Never send partial answers or silently shorten a new prompt. */
export function buildContext(messages: ChatMessage[]): { messages: AiHistoryMessage[]; limited: boolean } {
  const current = messages.at(-1);
  if (!current || current.role !== 'user' || !current.content.trim()) throw new Error('EMPTY_MESSAGE');
  const size = characters(current.content);
  if (size > 12000) throw new Error('MESSAGE_TOO_LONG');
  const selected: AiHistoryMessage[] = [{ role: 'user', content: current.content }];
  let total = size;
  let limited = false;
  // A user/assistant pair is eligible only when the answer was fully completed.
  for (let i = messages.length - 2; i > 0; i--) {
    const assistant = messages[i];
    if (assistant.role !== 'assistant') continue;
    let userIndex = i - 1;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex--;
    if (userIndex < 0) break;
    const user = messages[userIndex];
    if (assistant.status !== 'complete' || !assistant.content.trim()) { i = userIndex; continue; }
    const userSize = characters(user.content), answerSize = characters(assistant.content);
    if (userSize > 12000 || answerSize > 12000 || selected.length + 2 > 40 || total + userSize + answerSize > 24000) {
      limited = true;
      break;
    }
    selected.unshift({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content });
    total += userSize + answerSize;
    i = userIndex;
  }
  return { messages: selected, limited };
}

export function prepareRetry(conversation: Conversation): ChatMessage[] | null {
  const last = conversation.messages.at(-1);
  if (!last || last.role !== 'assistant' || !['error', 'cancelled', 'incomplete'].includes(last.status)) return null;
  const prompt = conversation.messages.findLastIndex(message => message.role === 'user');
  if (prompt < 0) return null;
  // A failed continuation can follow a saved tool card. Retain that card and IDs;
  // retrying the model must never repeat a business-tool confirmation.
  if (conversation.messages.at(-2)?.role !== 'user' && !last.toolInvocationIds?.length) return null;
  return conversation.messages.slice(0, -1);
}

export function finishStatus(reason: AiFinishReason, content: string): MessageStatus {
  return reason === 'stop' && content.trim() ? 'complete' : 'incomplete';
}
