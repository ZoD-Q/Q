import type { FinanceResult } from './core';
import type { Conversation } from '../ai-chat/state-model';

export type LocalFinanceTurn = { prompt: string; answer: string; result?: FinanceResult };
export const LOCAL_FINANCE_MESSAGE_LIMIT = 100;
/** A visible category survives the existing title contract; it changes guidance, never permissions. */
export function isFinancialAiConversation(conversation: Conversation | null | undefined): boolean {
  return !!conversation && !conversation.localOnly && !conversation.plugin
    && /^(?:市场研究|Market research|财务问答|Finance Q&A) · /u.test(conversation.title);
}
export function financialAiTitle(prompt: string, locale: 'zh' | 'en'): string {
  return `${locale === 'zh' ? '市场研究' : 'Market research'} · ${Array.from(prompt).slice(0, 24).join('')}`;
}

/** Local financial input never shares a conversation identity with cloud history. */
export function appendLocalFinanceTurn(
  previous: Conversation | null, turn: LocalFinanceTurn, newId: () => string,
): Conversation {
  if (Array.from(turn.prompt).length > 12000) throw new Error('MESSAGE_TOO_LONG');
  if (!turn.prompt.trim() || !turn.answer.trim() || turn.answer.length > 24000) {
    throw new Error('INVALID_LOCAL_FINANCE_TURN');
  }
  if (previous && (!previous.localOnly || previous.plugin)) throw new Error('LOCAL_FINANCE_PRIVATE');
  if (previous && previous.messages.length + 2 > LOCAL_FINANCE_MESSAGE_LIMIT) throw new Error('LOCAL_FINANCE_LIMIT');
  return {
    id: previous?.id ?? newId(),
    title: previous?.title ?? Array.from(turn.prompt.trim()).slice(0, 24).join(''),
    localOnly: true,
    messages: [...(previous?.messages ?? []),
      { id: newId(), role: 'user', content: turn.prompt, status: 'complete', localFinance: true },
      { id: newId(), role: 'assistant', content: turn.answer, status: 'complete', localFinance: true,
        ...(turn.result ? { financeResult: turn.result } : {}) },
    ],
  };
}

export function localFinanceHelp(locale: 'zh' | 'en', prompt: string): LocalFinanceTurn {
  return {
    prompt,
    answer: locale === 'zh'
      ? '这段对话仅保留本次本机会话，不会把内容发送给 AI 或云端历史。\n\n可以打开“金融知识”，或问我“什么是实际年利率”“免赔额是什么”。账单整理、分期成本和储蓄目标工具已从首页移除，当前不再处理这些任务；已有结果仍可查看。\n\n如需研究市场，请打开“金融数据”查看公开来源，或点击“新建 AI 市场研究”重新填写要分享的问题。本地记录不会带入；市场结论须核对来源、时间和数据延迟。'
      : 'This conversation stays on this device for this session. Its contents are not sent to AI or cloud history.\n\nOpen Financial knowledge or ask “What is APR?” or “What is a deductible?”. Bill organization, installment costs and savings goals have been removed from the home page and are no longer processed here. Existing results remain available.\n\nFor market research, open Financial data for public sources or choose New AI market research and enter a separate question. Local notes are not included. Market conclusions need sources, timestamps and data-delay checks.',
  };
}
