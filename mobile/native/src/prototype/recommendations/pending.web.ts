import { decodePending, type PendingRecommendation } from './core';

const key = (owner: string) => `xiaoq.recommendation.v1.${owner}`;
/** Identifiers only; browser bearer tokens and conversation contents stay out of storage. */
export async function savePendingRecommendation(owner: string, value: PendingRecommendation | null): Promise<void> {
  if (value) localStorage.setItem(key(owner), JSON.stringify(decodePending(value)));
  else localStorage.removeItem(key(owner));
}
export async function readPendingRecommendation(owner: string): Promise<PendingRecommendation | null> {
  const raw = localStorage.getItem(key(owner));
  if (!raw || raw.length > 2000) return null;
  try { return decodePending(JSON.parse(raw)); } catch { return null; }
}
