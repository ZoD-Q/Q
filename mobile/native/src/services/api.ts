import { fetch } from 'expo/fetch';
import type { ApiErrorBody } from '@xiaoq/shared';
import type { CopyKey } from '@/i18n';

const localHost = process.env.EXPO_OS === 'android' ? '10.0.2.2' : '127.0.0.1';
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || (__DEV__ ? `http://${localHost}:8787` : '')).replace(/\/$/, '');
export class ApiError extends Error {
  constructor(public code: string, public status = 0) { super(code); this.name = 'ApiError'; }
}
export async function request<T>(path: string, token?: string | null, method = 'GET', body?: unknown): Promise<T> {
  if (!API_URL) throw new ApiError('NETWORK_ERROR');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method, signal: controller.signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiErrorBody | null;
      throw new ApiError(payload?.error?.code || 'INTERNAL_ERROR', response.status);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('NETWORK_ERROR');
  } finally { clearTimeout(timeout); }
}
export function errorKey(error: unknown): CopyKey {
  if (!(error instanceof ApiError)) return 'unknownError';
  return ({ NETWORK_ERROR: 'networkError', UNAUTHORIZED: 'sessionExpired', INVALID_CREDENTIALS: 'invalidCredentials', HANDLE_TAKEN: 'handleTaken', USER_NOT_FOUND: 'userNotFound', INSUFFICIENT_FUNDS: 'insufficient', SELF_TRANSFER: 'selfTransfer', IDEMPOTENCY_CONFLICT: 'conflict', RATE_LIMITED: 'rateLimited', VALIDATION_ERROR: 'invalidInput' } as Record<string, CopyKey>)[error.code] || 'unknownError';
}
