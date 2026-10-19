import type { AiHistoryMessage, AiModel, AiFinishReason, AiUsage } from '@xiaoq/shared';

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'incomplete' | 'cancelled' | 'error';
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
}
export interface Conversation { id: string; title: string; messages: ChatMessage[] }
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
    const assistant = messages[i], user = messages[i - 1];
    if (assistant.role !== 'assistant' || user.role !== 'user') continue;
    if (assistant.status !== 'complete' || !assistant.content.trim()) { i--; continue; }
    const userSize = characters(user.content), answerSize = characters(assistant.content);
    if (userSize > 12000 || answerSize > 12000 || selected.length + 2 > 40 || total + userSize + answerSize > 24000) {
      limited = true;
      break;
    }
    selected.unshift({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content });
    total += userSize + answerSize;
    i--;
  }
  return { messages: selected, limited };
}

export function prepareRetry(conversation: Conversation): ChatMessage[] | null {
  const last = conversation.messages.at(-1);
  const prompt = conversation.messages.at(-2);
  if (!last || last.role !== 'assistant' || !['error', 'cancelled', 'incomplete'].includes(last.status) || prompt?.role !== 'user') return null;
  return conversation.messages.slice(0, -1);
}

export function finishStatus(reason: AiFinishReason, content: string): MessageStatus {
  return reason === 'stop' && content.trim() ? 'complete' : 'incomplete';
}
