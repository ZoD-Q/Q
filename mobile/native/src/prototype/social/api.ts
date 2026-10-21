import type { SocialUser, SocialFriend, SocialRequest, SocialMessage, SocialNotification, SocialMutation,
  SocialConversation as WireConversation, SocialSnapshot as WireSnapshot, SocialMessagePage, SocialOpenedMessage, SocialEphemeralState, SocialReportReceipt } from '@xiaoq/shared';
import { array, bool, id, integer, nullable, record, SocialError, string, timestamp, ttl } from './core';

export type { SocialUser, SocialFriend, SocialRequest, SocialMessage, SocialNotification } from '@xiaoq/shared';
export type RelationshipLabel = NonNullable<SocialFriend['relationship_label']>;
export type SocialConversation = Omit<WireConversation, 'last_message'> & { last_message: (Omit<SocialMessage, 'body'> & { preview: string | null }) | null };
export type SocialSnapshot = Omit<WireSnapshot, 'conversations'> & { conversations: SocialConversation[] };
export type MessagePage = SocialMessagePage;
export type OpenedMessage = SocialOpenedMessage;

const choice = <T extends string>(value: unknown, values: readonly T[]): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new SocialError('INVALID_RESPONSE');
  return value as T;
};
const label = (value: unknown) => nullable(value, item => choice(item, ['close_friend', 'partner', 'couple'] as const));
export function decodeSocialUser(value: unknown): SocialUser {
  const x = record(value);
  const handle = string(x.handle, 24);
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) throw new SocialError('INVALID_RESPONSE');
  return { id: id(x.id), handle, display_name: string(x.display_name, 40), avatar: choice(x.avatar, ['orbit', 'leaf', 'spark', 'wave']) };
}
export function decodeFriend(value: unknown): SocialFriend {
  const x = record(value);
  return { user: decodeSocialUser(x.user), conversation_id: id(x.conversation_id), remark: string(x.remark, 40), muted: bool(x.muted),
    intimacy_enabled: bool(x.intimacy_enabled), peer_intimacy_enabled: bool(x.peer_intimacy_enabled), intimacy_score: integer(x.intimacy_score),
    relationship_label: label(x.relationship_label), proposed_label: label(x.proposed_label), proposed_by: nullable(x.proposed_by, id), created_at: timestamp(x.created_at) };
}
export function decodeRequest(value: unknown): SocialRequest {
  const x = record(value);
  return { id: id(x.id), from_user: decodeSocialUser(x.from_user), to_user: decodeSocialUser(x.to_user), note: string(x.note, 80), created_at: timestamp(x.created_at) };
}
export function decodeMessage(value: unknown): SocialMessage {
  const x = record(value), kind = choice(x.kind, ['text', 'ephemeral'] as const), seconds = ttl(x.ttl_seconds);
  if ((kind === 'ephemeral' && (x.body !== null || seconds === null)) || (kind === 'text' && (typeof x.body !== 'string' || seconds !== null))) throw new SocialError('INVALID_RESPONSE');
  return { id: id(x.id), conversation_id: id(x.conversation_id), seq: integer(x.seq), sender_id: id(x.sender_id), client_message_id: id(x.client_message_id),
    kind, body: nullable(x.body, value => string(value, 2000)), ttl_seconds: seconds, opened_at: nullable(x.opened_at, timestamp), expires_at: nullable(x.expires_at, timestamp),
    unopened_expires_at: nullable(x.unopened_expires_at, timestamp), expired: bool(x.expired), created_at: timestamp(x.created_at) };
}
function decodeConversation(value: unknown): SocialConversation {
  const x = record(value), last = nullable(x.last_message, decodeMessage);
  // Keep only a short ordinary-message preview. Ephemeral content is never a preview.
  let metadata: SocialConversation['last_message'] = null;
  if (last) { const { body, ...rest } = last; metadata = { ...rest, preview: last.kind === 'text' && body ? Array.from(body).slice(0, 80).join('') : null }; }
  return { id: id(x.id), user: decodeSocialUser(x.user), last_seq: integer(x.last_seq), read_seq: integer(x.read_seq), peer_read_seq: integer(x.peer_read_seq),
    unread_count: integer(x.unread_count), last_message: metadata, updated_at: timestamp(x.updated_at), active: bool(x.active) };
}
function decodeNotification(value: unknown): SocialNotification {
  const x = record(value);
  return { id: id(x.id), kind: choice(x.kind, ['friend_request', 'friend_accepted', 'relationship_proposed', 'relationship_accepted'] as const), user: decodeSocialUser(x.user), created_at: timestamp(x.created_at), read_at: nullable(x.read_at, timestamp) };
}
export function decodeSnapshot(value: unknown): SocialSnapshot {
  const x = record(value);
  return { server_time: timestamp(x.server_time), friends: array(x.friends, decodeFriend, 200), requests: array(x.requests, decodeRequest, 100),
    conversations: array(x.conversations, decodeConversation, 500), blocks: array(x.blocks, decodeSocialUser, 200), notifications: array(x.notifications, decodeNotification, 200) };
}
export function decodeMessagePage(value: unknown): MessagePage {
  const x = record(value), items = array(x.items, decodeMessage, 100), next = integer(x.next_after_seq);
  if (items.some((item, i) => i > 0 && item.seq <= items[i - 1].seq) || new Set(items.map(item => item.id)).size !== items.length || (items.length > 0 && items.at(-1)?.seq !== next) || (items.length > 0 && items[0].seq !== integer(x.next_before_seq)) || (!items.length && integer(x.next_before_seq) !== 0)) throw new SocialError('INVALID_RESPONSE');
  return { items, next_after_seq: next, has_more: bool(x.has_more), next_before_seq: integer(x.next_before_seq), has_older: bool(x.has_older), server_time: timestamp(x.server_time) };
}
export function decodeEphemeralState(value: unknown): SocialEphemeralState {
  const x = record(value), items = array(x.items, decodeMessage, 100);
  if (items.some(item => item.kind !== 'ephemeral') || new Set(items.map(item => item.id)).size !== items.length) throw new SocialError('INVALID_RESPONSE');
  return { items, server_time: timestamp(x.server_time) };
}
export function decodeOpened(value: unknown): OpenedMessage {
  const x = record(value);
  return { message_id: id(x.message_id), body: string(x.body, 2000), expires_at: timestamp(x.expires_at), server_time: timestamp(x.server_time) };
}
export function decodeMutation(value: unknown): SocialMutation {
  if (record(value).ok !== true) throw new SocialError('INVALID_RESPONSE');
  return { ok: true };
}
export function decodeReportReceipt(value: unknown): SocialReportReceipt {
  const x = record(value);
  return { client_report_id: id(x.client_report_id), status: choice(x.status, ['accepted'] as const), expires_at: timestamp(x.expires_at), server_time: timestamp(x.server_time) };
}

function httpFailure(status: number, payload: unknown = null): SocialError {
  try {
    const code = record(record(payload).error).code;
    if (typeof code === 'string' && /^[A-Z_]{1,60}$/.test(code)) return new SocialError(code, status);
  } catch { /* Empty or nonstandard error bodies still carry a meaningful HTTP status. */ }
  const code = status === 401 ? 'UNAUTHORIZED' : status === 429 ? 'RATE_LIMITED' : status === 404 ? 'SOCIAL_UNAVAILABLE' : 'REQUEST_FAILED';
  return new SocialError(code, status);
}

export async function socialRequest<T>(options: {
  baseUrl: string; path: string; token: string; decode: (value: unknown) => T;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal; transport?: typeof fetch; timeoutMs?: number;
}): Promise<T> {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new SocialError('INSECURE_API_URL'); }
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(base.hostname)))) throw new SocialError('INSECURE_API_URL');
  if (!options.path.startsWith('/v1/') || options.path.startsWith('//')) throw new SocialError('INVALID_REQUEST');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) throw new SocialError('CANCELLED');
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, options.timeoutMs ?? 12000);
  try {
    const response = await (options.transport ?? fetch)(`${options.baseUrl}${options.path}`, {
      method: options.method ?? 'GET', signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${options.token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (controller.signal.aborted) throw new SocialError(options.signal?.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT');
    const reader = response.body?.getReader();
    if (!reader) throw response.ok ? new SocialError('INVALID_RESPONSE') : httpFailure(response.status);
    const decoder = new TextDecoder(); let raw = '', bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new SocialError(options.signal?.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT');
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw response.ok ? new SocialError('INVALID_RESPONSE') : httpFailure(response.status); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw response.ok ? new SocialError('INVALID_RESPONSE') : httpFailure(response.status); }
    if (!response.ok) throw httpFailure(response.status, payload);
    return options.decode(payload);
  } catch (error) {
    if (error instanceof SocialError) throw error;
    throw new SocialError(options.signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
}
