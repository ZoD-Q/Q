import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AuthResponse, Locale, ProfilePatch, ThemeName, User } from '@xiaoq/shared';
import { ApiError, request } from '@/services/api';
import { readToken, removeToken, writeToken } from '@/services/session-store';
import { palettes } from '@/theme';
import { copy } from '@/i18n';
import { createSerialQueue } from '@/utils/serial-queue';

function useAppState() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const generation = useRef(0);
  const [storeOperation] = useState(() => createSerialQueue());
  const [profileOperation] = useState(() => createSerialQueue());
  const [guestLocale, setGuestLocale] = useState<Locale>('zh-CN');
  const [guestTheme, setGuestTheme] = useState<ThemeName>('warm');
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const clearSession = useCallback(async (expectedToken: string | null) => {
    if (session.current !== expectedToken) return;
    generation.current++;
    session.current = null; setToken(null); setUser(null);
    if (expectedToken) await storeOperation(() => removeToken(expectedToken));
  }, [storeOperation]);
  const restore = useCallback(() => {
    const attempt = generation.current;
    return storeOperation(readToken).then(stored => {
      if (!stored) return;
      session.current = stored;
      return request<User>('/v1/me', stored).then(profile => {
        if (generation.current === attempt) { session.current = stored; setToken(stored); setUser(profile); }
      });
    }).catch(async error => {
      if (generation.current !== attempt) return;
      if (error instanceof ApiError && error.status === 401) await clearSession(session.current);
      else setBootError(true);
    }).finally(() => setBooting(false));
  }, [clearSession, storeOperation]);
  useEffect(() => { void restore(); }, [restore]);
  const retryRestore = () => { setBooting(true); setBootError(false); void restore(); };
  const authenticate = async (mode: 'login' | 'register', data: { handle: string; password: string; display_name?: string }) => {
    const attempt = ++generation.current;
    const auth = await request<AuthResponse>(`/v1/auth/${mode}`, null, 'POST', data);
    if (generation.current !== attempt) return;
    await storeOperation(async () => { if (generation.current === attempt) await writeToken(auth.token, () => generation.current === attempt); });
    if (generation.current !== attempt) return;
    session.current = auth.token; setToken(auth.token); setUser(auth.user); setSessionExpired(false);
  };
  const call = useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const active = session.current;
    try { return await request<T>(path, active, method, body); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401 && session.current === active) {
        setSessionExpired(true); await clearSession(active);
      }
      throw error;
    }
  }, [clearSession]);
  const updateProfile = (patch: ProfilePatch) => {
    const active = session.current;
    return profileOperation(async () => {
      if (session.current !== active || !active) throw new ApiError('UNAUTHORIZED', 401);
      const profile = await call<User>('/v1/me', 'PATCH', patch);
      if (session.current === active) setUser(profile);
      return profile;
    });
  };
  const logout = async () => {
    const active = session.current;
    // Keep a failed logout visible, so users can retry server-side revocation.
    await call<void>('/v1/auth/logout', 'POST');
    await clearSession(active);
  };
  const locale = user?.locale || guestLocale;
  const theme = user?.theme || guestTheme;
  return { user, token, locale, theme, colors: palettes[theme], t: copy(locale), booting, bootError, sessionExpired, restore: retryRestore, authenticate, call, updateProfile, logout, setGuestLocale, setGuestTheme };
}
const AppContext = createContext<ReturnType<typeof useAppState> | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const value = useAppState();
  return <AppContext value={value}>{children}</AppContext>;
}
export function useApp() {
  const context = use(AppContext);
  if (!context) throw new Error('AppProvider is required');
  return context;
}
