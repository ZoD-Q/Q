import type { FinanceResult } from './core';
import type { Conversation } from '../ai-chat/state-model';

export type LocalFinanceTurn = { prompt: string; answer: string; result?: FinanceResult };
export const LOCAL_FINANCE_MESSAGE_LIMIT = 100;
/** A visible category survives the existing title contract; it changes guidance, never permissions. */
export function isFinancialAiConversation(conversation: Conversation | null | undefined): boolean {
  return !!conversation && !conversation.localOnly && !conversation.plugin
    && /^(?:财务问答|Finance Q&A) · /u.test(conversation.title);
}
export function financialAiTitle(prompt: string, locale: 'zh' | 'en'): string {
  return `${locale === 'zh' ? '财务问答' : 'Finance Q&A'} · ${Array.from(prompt).slice(0, 24).join('')}`;
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
      ? '这段对话只在本机整理与计算，不会把内容发送给 AI 或云端历史。\n\n可以点击下方“财务工具”整理账单、计算分期成本或储蓄目标；也可以问我“什么是实际年利率”“免赔额是什么”。\n\n这里不会查询银行账户、申请产品或转账。如需 AI 进一步解释，请点击“新建 AI 问答”，重新填写要分享的问题，本地记录不会带入。'
      : 'This conversation keeps financial notes and calculations on this device for this session. Its contents are not sent to AI or cloud history.\n\nOpen Financial tools to organize bills, calculate installment costs or plan a savings goal. You can also ask “What is APR?” or “What is a deductible?”.\n\nThis local task cannot query a bank, apply for a product or transfer money. Choose New AI question to enter a separate question; these local notes will not be included.',
  };
}
