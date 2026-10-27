import type { ChatMessage, ChatPlugin, Conversation } from './state-model';
import { decodePluginIdentity } from '../plugin-host/core';
import { WorkbenchError } from '../api-workbench/core';

export type HistorySummary = { id: string; title: string; revision: number; updated_at: string };
export type HistoryDetail = HistorySummary & Conversation;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v);
const invalid = (): never => { throw new Error('INVALID_RESPONSE'); };
/** A selected connection may contain runtime fields outside the history contract. */
export function chatPluginSnapshot(value: ChatPlugin): ChatPlugin {
  return {
    id: value.id, title: value.title, endpoint_url: value.endpoint_url,
    ...(value.connection_kind === undefined ? {} : { connection_kind: value.connection_kind }),
    ...(value.builtin_service_id === undefined ? {} : { builtin_service_id: value.builtin_service_id }),
  };
}
export function decodeSummary(v: unknown): HistorySummary {
  if (!record(v) || !uuid(v.id) || typeof v.title !== 'string' || Array.from(v.title).length > 200 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || typeof v.updated_at !== 'string' || !Number.isFinite(Date.parse(v.updated_at))) return invalid();
  return { id: v.id, title: v.title, revision: Number(v.revision), updated_at: v.updated_at };
}
export function decodeHistory(v: unknown): HistoryDetail {
  const summary = decodeSummary(v);
  if (!record(v) || !Array.isArray(v.messages) || v.messages.length > 2000) return invalid();
  const messages = v.messages.map((m): ChatMessage => {
    if (!record(m) || (typeof m.id !== 'string' || !m.id || m.id.length > 200) || !['user', 'assistant'].includes(String(m.role)) || typeof m.content !== 'string' || m.content.length > 1048576 || !['pending','streaming','complete','incomplete','cancelled','error','tool'].includes(String(m.status))) return invalid();
    if (m.model !== undefined && !['deepseek-flash','deepseek-v4-pro'].includes(String(m.model))) return invalid();
    if (m.thinking !== undefined && typeof m.thinking !== 'boolean') return invalid();
    if (m.contextLimited !== undefined && typeof m.contextLimited !== 'boolean') return invalid();
    if (m.bankCommand !== undefined && typeof m.bankCommand !== 'boolean') return invalid();
    if (m.finishReason !== undefined && !['stop','length','content_filter','tool_calls','insufficient_system_resource','aborted'].includes(String(m.finishReason))) return invalid();
    if (m.errorCode !== undefined && typeof m.errorCode !== 'string') return invalid();
    if (m.toolProposalId !== undefined && !uuid(m.toolProposalId)) return invalid();
    if (m.toolInvocationIds !== undefined && (!Array.isArray(m.toolInvocationIds) || m.toolInvocationIds.length > 8 || !m.toolInvocationIds.every(uuid))) return invalid();
    if (m.usage !== undefined && (!record(m.usage) || !['prompt_tokens','completion_tokens','total_tokens'].every(key => Number.isSafeInteger(m.usage && record(m.usage) ? m.usage[key] : null) && Number(record(m.usage) ? m.usage[key] : -1) >= 0))) return invalid();
    return { ...m } as unknown as ChatMessage;
  });
  let plugin: Conversation['plugin'];
  if (v.plugin != null) {
    if (!record(v.plugin) || !uuid(v.plugin.id) || typeof v.plugin.title !== 'string' || typeof v.plugin.endpoint_url !== 'string') return invalid();
    plugin = { id: v.plugin.id, title: v.plugin.title, endpoint_url: v.plugin.endpoint_url, ...decodePluginIdentity(v.plugin) };
  }
  return { ...summary, messages, ...(plugin ? { plugin } : {}) };
}
export function decodeHistoryPage(v: unknown): { items: HistorySummary[]; next_cursor: string | null } {
  if (!record(v) || !Array.isArray(v.items) || v.items.length > 20 || !(v.next_cursor === null || uuid(v.next_cursor))) return invalid();
  return { items: v.items.map(decodeSummary), next_cursor: v.next_cursor };
}
export function restoreHistory(detail: HistoryDetail): Conversation {
  return { id: detail.id, title: detail.title, ...(detail.plugin ? { plugin: detail.plugin } : {}), messages: detail.messages.map(m => m.status === 'pending' || m.status === 'streaming' ? { ...m, status: 'cancelled', errorCode: 'INTERRUPTED' } : m) };
}

type SaveBody = Pick<Conversation, 'title' | 'messages' | 'plugin'> & { request_id: string; expected_revision: number };
function saveSnapshot(conversation: Conversation, revision: number, requestId: string): SaveBody {
  if (conversation.localOnly || conversation.messages.some(message => message.localFinance || message.financeResult)) {
    throw new Error('LOCAL_FINANCE_PRIVATE');
  }
  return {
    title: conversation.title,
    messages: JSON.parse(JSON.stringify(conversation.messages)) as ChatMessage[],
    ...(conversation.plugin ? { plugin: chatPluginSnapshot(conversation.plugin) } : {}),
    request_id: requestId, expected_revision: revision,
  };
}
/** One writer per conversation. An uncertain request blocks later writes until its exact replay succeeds. */
export function createHistoryWriter(save: (id: string, body: SaveBody) => Promise<HistoryDetail>, newId: () => string) {
  const revisions = new Map<string, number>();
  const pending = new Map<string, SaveBody>();
  const queues = new Map<string, Promise<void>>();
  const rejected = new Set<string>();
  const uncertain = new Set<string>();
  const seed = (id: string, revision: number, replaceSnapshot = false) => { if (!pending.has(id) && (replaceSnapshot || !revisions.has(id))) revisions.set(id, revision); };
  const run = (conversation: Conversation, retry = false): Promise<HistoryDetail> => {
    if (conversation.localOnly || conversation.messages.some(message => message.localFinance || message.financeResult)) {
      return Promise.reject(new Error('LOCAL_FINANCE_PRIVATE'));
    }
    const previous = queues.get(conversation.id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let body = pending.get(conversation.id);
      if (body && !retry) throw new Error('HISTORY_SAVE_PENDING');
      // A structured validation rejection proves no write occurred, unless an
      // earlier attempt had an unknown outcome. Only an explicit retry may use
      // corrected local content, retaining the original revision for CAS.
      if (body && retry && rejected.has(conversation.id)) {
        const corrected = saveSnapshot(conversation, body.expected_revision, body.request_id);
        if (JSON.stringify(corrected) !== JSON.stringify(body)) {
          body = { ...corrected, request_id: newId() };
          pending.set(conversation.id, body); rejected.delete(conversation.id);
        }
      }
      if (!body) { body = saveSnapshot(conversation, revisions.get(conversation.id) ?? 0, newId()); pending.set(conversation.id, body); }
      let result: HistoryDetail;
      try { result = await save(conversation.id, body); }
      catch (error) {
        if (error instanceof WorkbenchError && error.status === 400 && error.code === 'VALIDATION_ERROR' && !uncertain.has(conversation.id)) rejected.add(conversation.id);
        else { uncertain.add(conversation.id); rejected.delete(conversation.id); }
        throw error;
      }
      revisions.set(conversation.id, result.revision); pending.delete(conversation.id);
      rejected.delete(conversation.id); uncertain.delete(conversation.id);
      return result;
    });
    queues.set(conversation.id, operation.then(() => {}, () => {}));
    return operation;
  };
  return { seed, discard: (id: string, revision: number) => { pending.delete(id); rejected.delete(id); uncertain.delete(id); revisions.set(id, revision); }, drain: () => Promise.all(queues.values()), save: (c: Conversation) => run(c), retry: (c: Conversation) => run(c, true), hasPending: (id: string) => pending.has(id) };
}
