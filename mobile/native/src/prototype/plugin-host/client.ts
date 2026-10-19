import { fetch as expoFetch } from 'expo/fetch';
import { API_URL } from '../../services/api';
import { removeToken } from '../../services/session-store';
import { workbenchRequest, WorkbenchError } from '../api-workbench/core';

/** Same Q identity as chat, but plugin authorization errors never clear it. No retries. */
export async function pluginRequest<T>(token: string, path: string, decode: (value: unknown) => T, options: {
  method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  try {
    return await workbenchRequest({ baseUrl: API_URL, path, decode, token, transport: expoFetch, ...options });
  } catch (error) {
    if (error instanceof WorkbenchError && error.status === 401) await removeToken(token);
    throw error;
  }
}
