import { WorkbenchError } from '../api-workbench/core';
import { decodeHistory, type HistoryDetail } from '../ai-chat/history';
import type { Conversation } from '../ai-chat/state-model';
import { createAppNavigationAction, isModuleId, type AppCommand, type AppReadResult, type AppNavigationAction, type ModuleId } from '../app-assistant/core';
import type { AiRecommendation, AiRecommendationCandidate, AiRecommendationSelection } from '@xiaoq/shared';

export type RecommendationCandidate = AiRecommendationCandidate;
export type Recommendation = AiRecommendation;
export type RecommendationSelection = Omit<AiRecommendationSelection, 'conversation'> & { conversation: HistoryDetail | null };
/** Recovery contains identifiers only. It never grants permission or replays a request. */
export type PendingRecommendation = {
  recordId: string; candidateId: string; sourceConversationId: string; targetConversationId?: string;
};
export type RecommendationMap = Record<string, Recommendation>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const invalid = (): never => { throw new WorkbenchError('INVALID_RESPONSE'); };
const text = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || Array.from(value).length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return invalid();
  return value;
};
const optionalText = (value: unknown, max: number) => value == null ? null : text(value, max);
const option = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === 'string' && values.includes(value as T) ? value as T : invalid();

export function decodeCandidate(value: unknown): RecommendationCandidate {
  if (!object(value) || (value.connection_id != null && !uuid(value.connection_id))
    || (value.connection_revision != null && (!Number.isSafeInteger(value.connection_revision) || Number(value.connection_revision) < 1))) return invalid();
  return {
    id: text(value.id, 300), title: text(value.title, 200), description: text(value.description, 4000, true), reason: text(value.reason, 1000, true),
    kind: option(value.kind, ['plugin', 'module']), access: option(value.access, ['ready', 'connect', 'authorize', 'review', 'unavailable']),
    connection_id: value.connection_id == null ? null : value.connection_id as string, connection_revision: value.connection_revision == null ? null : Number(value.connection_revision),
    module: optionalText(value.module, 80), provider_id: optionalText(value.provider_id, 100), bank_id: optionalText(value.bank_id, 100),
    capability_version: text(value.capability_version, 200), price_note: optionalText(value.price_note, 1000),
  };
}
export function decodeRecommendation(value: unknown): Recommendation {
  if (!object(value) || !uuid(value.id) || !uuid(value.conversation_id) || !Array.isArray(value.candidates) || value.candidates.length > 3) return invalid();
  const candidates = value.candidates.map(decodeCandidate);
  const status = option(value.status, ['complete', 'skipped']);
  if (new Set(candidates.map(item => item.id)).size !== candidates.length || (status === 'skipped' && candidates.length)) return invalid();
  const created_at = text(value.created_at, 80), expires_at = text(value.expires_at, 80);
  if (!Number.isFinite(Date.parse(created_at)) || !Number.isFinite(Date.parse(expires_at)) || Date.parse(expires_at) <= Date.parse(created_at)) return invalid();
  return { id: value.id, conversation_id: value.conversation_id, source_message_id: text(value.source_message_id, 200), status, candidates,
    catalog_version: text(value.catalog_version, 200), created_at, expires_at };
}
export function decodeRecommendationPage(value: unknown) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 20 || (value.next_cursor != null && !uuid(value.next_cursor))) return invalid();
  const items = value.items.map(decodeRecommendation);
  if (new Set(items.map(item => item.id)).size !== items.length) return invalid();
  return { items, next_cursor: value.next_cursor == null ? null : value.next_cursor as string };
}
export function decodeSelection(value: unknown): RecommendationSelection {
  if (!object(value) || typeof value.created !== 'boolean') return invalid();
  const kind = option(value.kind, ['conversation', 'connect', 'authorize', 'review', 'navigate']);
  const candidate = decodeCandidate(value.candidate);
  const conversation = value.conversation == null ? null : decodeHistory(value.conversation);
  if ((kind === 'conversation') !== Boolean(conversation) || (value.created && !conversation)) return invalid();
  if (conversation && (candidate.access !== 'ready' || conversation.localOnly
    || conversation.messages.some(message => message.localFinance || message.financeResult)
    || (candidate.kind === 'plugin' && (!candidate.connection_id || conversation.plugin?.id !== candidate.connection_id))
    || (candidate.kind === 'module' && conversation.plugin))) return invalid();
  if (conversation && value.created && (conversation.messages.at(-1)?.role !== 'user'
    || conversation.messages.some(message => message.toolProposalId || message.toolInvocationIds?.length || message.bankCommand))) return invalid();
  return { kind, candidate, conversation, created: value.created };
}
export function decodePending(value: unknown): PendingRecommendation {
  if (!object(value) || !uuid(value.recordId) || !uuid(value.sourceConversationId) || (value.targetConversationId !== undefined && !uuid(value.targetConversationId))) return invalid();
  return { recordId: value.recordId, candidateId: text(value.candidateId, 300), sourceConversationId: value.sourceConversationId,
    ...(value.targetConversationId === undefined ? {} : { targetConversationId: value.targetConversationId as string }) };
}
export function mergeRecommendations(previous: RecommendationMap, items: Recommendation[]): RecommendationMap {
  const next = { ...previous };
  for (const item of items) {
    // One visible card set for a saved user turn, including a later skipped result.
    for (const [id, existing] of Object.entries(next)) if (existing.conversation_id === item.conversation_id && existing.source_message_id === item.source_message_id) delete next[id];
    next[item.id] = item;
  }
  return Object.fromEntries(Object.entries(next).sort(([, a], [, b]) => Date.parse(a.created_at) - Date.parse(b.created_at)).slice(-100));
}
export function recommendationUnderAnswer(conversation: Conversation, messageId: string, records: RecommendationMap): Recommendation | null {
  const index = conversation.messages.findIndex(message => message.id === messageId);
  if (index < 0 || conversation.messages[index].role !== 'assistant' || conversation.messages[index + 1]?.role === 'assistant') return null;
  const source = conversation.messages.slice(0, index).findLast(message => message.role === 'user');
  return Object.values(records).find(item => item.conversation_id === conversation.id && item.source_message_id === source?.id && item.status === 'complete' && item.candidates.length > 0) ?? null;
}
export function visibleCandidates(record: Recommendation, actions: AppNavigationAction[] = [], coveredModules: readonly string[] = []): RecommendationCandidate[] {
  return record.candidates.filter(candidate => candidate.kind !== 'module' || (!actions.some(action => action.module === candidate.module) && !coveredModules.includes(candidate.module ?? ''))).slice(0, 3);
}
export const recommendationTurnKey = (conversationId: string, sourceMessageId: string) => `${conversationId}:${sourceMessageId}`;
/** Only the trusted local executor can supply this ephemeral evidence; restored text cannot. */
export function completedRecommendationModule(command: AppCommand, result: AppReadResult): ModuleId | null {
  if (!result.text.trim() || (object(result.data) && (result.data.success === false || result.data.pending === true))) return null;
  if (['market_query', 'company_search', 'company_research', 'company_filings', 'company_filing'].includes(command.name)) return 'market-data';
  if (['insurance_search', 'insurance_compare'].includes(command.name)) return 'insurance';
  return null;
}
export function recommendationNavigation(candidate: RecommendationCandidate, question: string, locale: 'zh' | 'en' = 'zh'): AppNavigationAction | null {
  if (!candidate.module || !isModuleId(candidate.module)) return null;
  try {
    return createAppNavigationAction(candidate.module, locale,
      candidate.module === 'insurance' ? { query: Array.from(question.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')).slice(0, 120).join('') } : {});
  } catch { return null; }
}
export function canContinueRecommendation(conversation: Conversation | undefined): boolean {
  return Boolean(conversation && !conversation.localOnly && conversation.messages.length && conversation.messages.at(-1)?.role === 'user'
    && conversation.messages.at(-1)?.status === 'complete' && !conversation.messages.some(message => message.localFinance || message.financeResult));
}
export function recommendationError(code: string, copy: (zh: string, en: string) => string): string {
  if (code === 'RECOMMENDATION_EXPIRED' || code === 'NOT_FOUND') return copy('这条推荐已过期。请重新描述需求，获取当前可用的服务。', 'This recommendation has expired. Describe your request again to find an available service.');
  if (code === 'RECOMMENDATION_STALE') return copy('这条推荐已失效。请重新描述需求，获取当前可用的服务。', 'This recommendation is no longer valid. Describe your request again to find an available service.');
  if (code === 'PLUGIN_RECONFIRM_REQUIRED') return copy('插件能力已更新。请返回插件页确认后，继续原问题。', 'The plugin has changed. Review it on the Plugins page, then continue your request.');
  if (['PLUGIN_UNAVAILABLE', 'RECOMMENDATION_UNAVAILABLE'].includes(code)) return copy('这项服务暂时不可用。你可以继续与小Q对话。', 'This service is currently unavailable. You can continue chatting with Q.');
  if (code === 'STORAGE_ERROR') return copy('未能保存继续入口，请稍后重试。', 'The continue link could not be saved. Please try again.');
  return copy('暂时未能打开。重试会恢复同一个任务。', 'Could not open the service. Retrying will recover the same task.');
}
