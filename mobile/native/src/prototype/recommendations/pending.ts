import * as SecureStore from 'expo-secure-store';
import { decodePending, type PendingRecommendation } from './core';

const key = (owner: string) => `xiaoq.recommendation.v1.${owner}`;
// Serialize local writes so an older completion cannot replace a newer selection.
let tail: Promise<unknown> = Promise.resolve();
export function savePendingRecommendation(owner: string, value: PendingRecommendation | null): Promise<void> {
  const operation = tail.then(() => value ? SecureStore.setItemAsync(key(owner), JSON.stringify(decodePending(value))) : SecureStore.deleteItemAsync(key(owner)));
  tail = operation.catch(() => undefined);
  return operation;
}
export async function readPendingRecommendation(owner: string): Promise<PendingRecommendation | null> {
  await tail;
  const raw = await SecureStore.getItemAsync(key(owner));
  if (!raw || raw.length > 2000) return null;
  try { return decodePending(JSON.parse(raw)); } catch { return null; }
}
