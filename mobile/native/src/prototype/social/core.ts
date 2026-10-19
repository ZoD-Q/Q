import type { SocialMessage, SocialSendRequest } from '@xiaoq/shared';

/** Pure client safety rules. No account credentials or message contents enter logs. */
export type EphemeralSeconds = 30 | 300 | 86400;
export type PendingSend = {
  ownerId: string;
  conversationId: string;
  clientMessageId: string;
  text: string | null;
  ttlSeconds: EphemeralSeconds | null;
};

export class SocialError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) { super(code); this.name = 'SocialError'; this.code = code; this.status = status; }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SocialError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || Array.from(value).length > max) throw new SocialError('INVALID_RESPONSE');
  return value;
}
export function id(value: unknown): string {
  const result = string(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new SocialError('INVALID_RESPONSE');
  return result;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new SocialError('INVALID_RESPONSE');
  return value;
}
export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SocialError('INVALID_RESPONSE');
  return value;
}
export function timestamp(value: unknown): string {
  const result = string(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new SocialError('INVALID_RESPONSE');
  return result;
}
export function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null { return value === null ? null : decode(value); }
export function array<T>(value: unknown, decode: (value: unknown) => T, max = 200): T[] {
  if (!Array.isArray(value) || value.length > max) throw new SocialError('INVALID_RESPONSE');
  return value.map(decode);
}
export function ttl(value: unknown): EphemeralSeconds | null {
  if (value === null || value === 30 || value === 300 || value === 86400) return value;
  throw new SocialError('INVALID_RESPONSE');
}

export type RequestStamp = { ownerId: string; token: string; revision: number; epoch: number };
export function sameStamp(a: RequestStamp | null, b: RequestStamp | null): boolean {
  return a !== null && b !== null && a.ownerId === b.ownerId && a.token === b.token && a.revision === b.revision && a.epoch === b.epoch;
}
export function createPrivacyGate() {
  let epoch = 0, active = false;
  return {
    enter: () => { active = true; epoch++; },
    invalidate: () => { epoch++; },
    leave: () => { active = false; epoch++; },
    capture: () => epoch,
    accepts: (ticket: number) => active && epoch === ticket,
    isActive: () => active,
  };
}

export type Deadline = { monotonicStart: number; wallStart: number; durationMs: number };
/** Start from the request's start time: network transit can only shorten visibility. */
export function createDeadline(serverNow: string, expiresAt: string, requestMono: number, requestWall: number): Deadline {
  const durationMs = Date.parse(timestamp(expiresAt)) - Date.parse(timestamp(serverNow));
  if (durationMs <= 0 || durationMs > 86400000 || !Number.isFinite(requestMono) || !Number.isFinite(requestWall)) throw new SocialError('MESSAGE_EXPIRED');
  return { monotonicStart: requestMono, wallStart: requestWall, durationMs };
}
/** A backwards clock or a divergent wall clock fails closed; never extend a message. */
export function remainingMs(deadline: Deadline, mono: number, wall: number): number {
  const elapsed = mono - deadline.monotonicStart;
  const wallElapsed = wall - deadline.wallStart;
  if (!Number.isFinite(elapsed) || !Number.isFinite(wallElapsed) || elapsed < 0 || wallElapsed < 0 || Math.abs(elapsed - wallElapsed) > 2000) return 0;
  return Math.max(0, deadline.durationMs - Math.max(elapsed, wallElapsed));
}

export function decodePending(value: unknown): PendingSend {
  const p = record(value);
  const result = { ownerId: id(p.ownerId), conversationId: id(p.conversationId), clientMessageId: id(p.clientMessageId), text: nullable(p.text, string), ttlSeconds: ttl(p.ttlSeconds) };
  if (result.ttlSeconds !== null && result.text !== null) throw new SocialError('STORAGE_ERROR');
  if (result.text !== null && validateText(result.text) !== result.text) throw new SocialError('STORAGE_ERROR');
  return result;
}
/** Ephemeral bodies may only live in a focused conversation, including on failed sends. */
export function persistedPending(pending: PendingSend): PendingSend {
  return { ownerId: id(pending.ownerId), conversationId: id(pending.conversationId), clientMessageId: id(pending.clientMessageId),
    text: pending.ttlSeconds === null && pending.text !== null ? validateText(pending.text) : null, ttlSeconds: ttl(pending.ttlSeconds) };
}
export function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) throw new SocialError('INVALID_HANDLE');
  return handle;
}
export function validateText(value: string): string {
  const text = value.trim();
  if (!text || Array.from(text).length > 2000) throw new SocialError('INVALID_MESSAGE');
  return text;
}
export function sendPayload(pending: PendingSend): SocialSendRequest {
  if (pending.text === null) throw new SocialError('EPHEMERAL_BODY_CLEARED');
  return { client_message_id: id(pending.clientMessageId), body: validateText(pending.text), ttl_seconds: ttl(pending.ttlSeconds) };
}
export function messageReceipt(message: SocialMessage, peerReadSeq: number): 'expired' | 'opened' | 'unopened' | 'read' | 'sent' {
  if (message.kind === 'ephemeral') return message.expired ? 'expired' : message.opened_at ? 'opened' : 'unopened';
  return message.seq <= peerReadSeq ? 'read' : 'sent';
}
export function canReportEvidence(message: SocialMessage, hasVisibleBody: boolean): boolean {
  return message.kind === 'text' || (!message.expired && hasVisibleBody);
}

type Storage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
/** Serialize manifest operations; a partial chunk write never becomes a recoverable request. */
export function createOutboxStore(storage: Storage) {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T,>(op: () => Promise<T>): Promise<T> => { const result = tail.then(op); tail = result.catch(() => undefined); return result; };
  const key = (owner: string, conversation: string) => `q.social.pending.${id(owner)}.${id(conversation)}`;
  const manifest = (raw: string | null): { version: string; count: number } | null => {
    if (!raw) return null;
    const m = record(JSON.parse(raw));
    const version = id(m.version), count = integer(m.count, 64);
    return { version, count };
  };
  const removeChunks = async (base: string, m: ReturnType<typeof manifest>) => {
    if (m) for (let i = 0; i < m.count; i++) await storage.remove(`${base}.${m.version}.${i}`);
  };
  return {
    read: (owner: string, conversation: string) => run(async () => {
      const base = key(owner, conversation), m = manifest(await storage.get(base));
      if (!m) return null;
      let raw = '';
      for (let i = 0; i < m.count; i++) { const part = await storage.get(`${base}.${m.version}.${i}`); if (part === null) throw new SocialError('STORAGE_ERROR'); raw += part; }
      const pending = decodePending(JSON.parse(raw));
      if (pending.ownerId !== owner || pending.conversationId !== conversation) throw new SocialError('STORAGE_ERROR');
      return pending;
    }),
    write: (pending: PendingSend, version: string) => run(async () => {
      const base = key(pending.ownerId, pending.conversationId), old = manifest(await storage.get(base));
      if (old) {
        let raw = '';
        for (let i = 0; i < old.count; i++) raw += await storage.get(`${base}.${old.version}.${i}`) ?? '';
        const prior = decodePending(JSON.parse(raw));
        if (JSON.stringify(prior) !== JSON.stringify(persistedPending(pending))) throw new SocialError('PENDING_SEND_EXISTS');
        return;
      }
      id(version);
      const chars = Array.from(JSON.stringify(persistedPending(pending)));
      const parts: string[] = [];
      for (let i = 0; i < chars.length; i += 400) parts.push(chars.slice(i, i + 400).join(''));
      try {
        for (let i = 0; i < parts.length; i++) await storage.set(`${base}.${version}.${i}`, parts[i]);
        await storage.set(base, JSON.stringify({ version, count: parts.length }));
      } catch (error) {
        // A storage API can reject after mutation. Keep a committed record recoverable.
        try {
          const installed = manifest(await storage.get(base));
          if (installed?.version !== version) await removeChunks(base, { version, count: parts.length });
        } catch { /* Unknown manifest outcome: preserve chunks instead of corrupting it. */ }
        throw error;
      }
      await removeChunks(base, old);
    }),
    remove: (owner: string, conversation: string, expectedId: string) => run(async () => {
      const base = key(owner, conversation), m = manifest(await storage.get(base));
      if (!m) return;
      let raw = '';
      for (let i = 0; i < m.count; i++) raw += await storage.get(`${base}.${m.version}.${i}`) ?? '';
      if (decodePending(JSON.parse(raw)).clientMessageId !== expectedId) return;
      await storage.remove(base);
      await removeChunks(base, m);
    }),
  };
}
