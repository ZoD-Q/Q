import type { SocialReportReceipt, SocialReportRequest } from '@xiaoq/shared';
import { bool, createChunkRegistry, id, integer, nullable, record, SocialError, string } from './core';

export type ReportMeta = { ownerId: string; clientReportId: string; userId: string; messageId: string | null; includeEvidence: boolean; reasonHash: string };
export type PendingReport = ReportMeta & { reason: string | null };
type Storage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };
type Hash = (value: string) => Promise<string>;
export function reportReason(value: string): string {
  const reason = value.trim();
  if (!reason || Array.from(reason).length > 500) throw new SocialError('INVALID_REPORT_REASON');
  return reason;
}
export function decodeReportMeta(value: unknown): ReportMeta {
  const x = record(value), reasonHash = string(x.reasonHash, 64);
  if (!/^[0-9a-f]{64}$/.test(reasonHash)) throw new SocialError('STORAGE_ERROR');
  const result = { ownerId: id(x.ownerId), clientReportId: id(x.clientReportId), userId: id(x.userId), messageId: nullable(x.messageId, id), includeEvidence: bool(x.includeEvidence), reasonHash };
  if (result.includeEvidence && !result.messageId) throw new SocialError('STORAGE_ERROR');
  return result;
}
export async function recoverReportRequest(pending: PendingReport, owner: string, enteredReason: string, hash: Hash): Promise<SocialReportRequest> {
  if (pending.ownerId !== owner) throw new SocialError('UNAUTHORIZED');
  const reason = reportReason(enteredReason);
  if (await hash(reason) !== pending.reasonHash) throw new SocialError('REPORT_REASON_MISMATCH');
  return { client_report_id: pending.clientReportId, user_id: pending.userId, message_id: pending.messageId, reason, include_evidence: pending.includeEvidence };
}
export async function inspectReportReceipt(pending: ReportMeta, owner: string, lookup: (clientId: string) => Promise<SocialReportReceipt>): Promise<'accepted' | 'expired' | 'unknown'> {
  if (pending.ownerId !== owner) throw new SocialError('UNAUTHORIZED');
  try {
    const receipt = await lookup(pending.clientReportId);
    if (receipt.client_report_id !== pending.clientReportId || receipt.status !== 'accepted') throw new SocialError('INVALID_RESPONSE');
    return 'accepted';
  } catch (failure) {
    if (failure instanceof SocialError && failure.status === 404 && failure.code === 'SOCIAL_NOT_FOUND') return 'unknown';
    if (failure instanceof SocialError && failure.status === 410 && failure.code === 'SOCIAL_REPORT_EXPIRED') return 'expired';
    throw failure;
  }
}
export function isFinalReportRejection(error: unknown): boolean {
  return error instanceof SocialError && ((error.status === 410 && ['SOCIAL_MESSAGE_EXPIRED', 'SOCIAL_REPORT_EXPIRED'].includes(error.code))
    || (error.status === 403 && error.code === 'SOCIAL_FORBIDDEN'));
}
/** One unresolved report per owner. Native stores reason encrypted; web stores only its digest. */
export function createReportStore(storage: Storage, hash: Hash, persistReason: boolean) {
  let tail: Promise<unknown> = Promise.resolve();
  const blocked = new Set<string>();
  const registry = createChunkRegistry(storage, 'q.social.report.index.v1');
  const listeners = new Set<() => void>();
  const run = <T,>(action: () => Promise<T>): Promise<T> => { const next = tail.then(action); tail = next.catch(() => undefined); return next; };
  const base = (owner: string) => `q.social.report.v1.${id(owner)}`;
  const retiredKey = (owner: string) => `q.social.report.deleted.${id(owner)}`;
  const retired = async (owner: string) => blocked.has(owner) || await storage.get(retiredKey(owner)) !== null;
  const readManifest = async (owner: string): Promise<(ReportMeta & { chunks: number }) | null> => {
    const raw = await storage.get(base(owner)); if (!raw) return null;
    const value = record(JSON.parse(raw)), meta = decodeReportMeta(value), chunks = integer(value.chunks, 4);
    if (meta.ownerId !== owner || (!persistReason && chunks !== 0)) throw new SocialError('STORAGE_ERROR');
    return { ...meta, chunks };
  };
  const announce = () => { for (const listener of listeners) { try { listener(); } catch { /* A subscriber cannot break committed storage. */ } } };
  const removeChunks = async (owner: string, client: string, count: number) => { for (let i = 0; i < count; i++) await storage.remove(`${base(owner)}.${client}.${i}`); };
  const track = async (owner: string, value: Awaited<ReturnType<typeof readManifest>>) => {
    if (value) await registry.add(owner, { id: value.clientReportId, version: value.clientReportId, count: value.chunks });
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    meta: (owner: string) => run(async () => {
      if (await retired(owner)) return null;
      const value = await readManifest(owner); await track(owner, value); return value ? decodeReportMeta(value) : null;
    }),
    read: (owner: string) => run(async (): Promise<PendingReport | null> => {
      if (await retired(owner)) return null;
      const value = await readManifest(owner); if (!value) return null;
      await track(owner, value);
      let reason: string | null = null;
      if (value.chunks > 0) {
        reason = '';
        for (let i = 0; i < value.chunks; i++) { const chunk = await storage.get(`${base(owner)}.${value.clientReportId}.${i}`); if (chunk === null) throw new SocialError('STORAGE_ERROR'); reason += chunk; }
        if (await hash(reason) !== value.reasonHash || reportReason(reason) !== reason) throw new SocialError('STORAGE_ERROR');
      }
      return { ...decodeReportMeta(value), reason };
    }),
    save: (owner: string, request: SocialReportRequest) => run(async (): Promise<PendingReport> => {
      if (await retired(owner)) throw new SocialError('ACCOUNT_DELETED');
      const reason = reportReason(request.reason), reasonHash = await hash(reason);
      const meta = decodeReportMeta({ ownerId: owner, clientReportId: request.client_report_id, userId: request.user_id, messageId: request.message_id, includeEvidence: request.include_evidence, reasonHash });
      const old = await readManifest(owner);
      if (old) {
        await track(owner, old);
        if (JSON.stringify(decodeReportMeta(old)) !== JSON.stringify(meta)) throw new SocialError('PENDING_REPORT_EXISTS');
        return { ...meta, reason };
      }
      const characters = persistReason ? Array.from(reason) : [], chunks: string[] = [];
      for (let i = 0; i < characters.length; i += 400) chunks.push(characters.slice(i, i + 400).join(''));
      const entry = { id: meta.clientReportId, version: meta.clientReportId, count: chunks.length };
      await registry.add(owner, entry);
      try {
        for (let i = 0; i < chunks.length; i++) await storage.set(`${base(owner)}.${meta.clientReportId}.${i}`, chunks[i]);
        await storage.set(base(owner), JSON.stringify({ ...meta, chunks: chunks.length }));
      } catch (failure) {
        try {
          const installed = await readManifest(owner);
          if (installed?.clientReportId !== meta.clientReportId) {
            await removeChunks(owner, meta.clientReportId, chunks.length); await registry.remove(owner, entry);
          }
        } catch { /* Preserve uncertain manifest commits for lookup recovery. */ }
        throw failure;
      }
      announce(); return { ...meta, reason };
    }),
    remove: (owner: string, expectedId: string) => run(async () => {
      const value = await readManifest(owner);
      if (!value || value.clientReportId !== expectedId) return;
      await track(owner, value);
      await storage.remove(base(owner)); await removeChunks(owner, value.clientReportId, value.chunks);
      await registry.remove(owner, { id: value.clientReportId, version: value.clientReportId, count: value.chunks }); announce();
    }),
    purgeOwner: (owner: string) => {
      id(owner); blocked.add(owner);
      return run(async () => {
        await storage.set(retiredKey(owner), 'deleted');
        // Unlike conversation outboxes, this legacy manifest has one known key per owner.
        const legacy = await readManifest(owner);
        if (legacy) {
          // Keep the manifest until its chunks are gone, so a failed purge remains retryable
          // even when a full directory cannot accept an older unindexed record.
          await removeChunks(owner, legacy.clientReportId, legacy.chunks);
          await storage.remove(base(owner));
        }
        for (const entry of await registry.entries(owner)) {
          await removeChunks(owner, entry.id, entry.count);
          await storage.remove(base(owner));
          await registry.remove(owner, entry);
        }
        announce();
      });
    },
  };
}
