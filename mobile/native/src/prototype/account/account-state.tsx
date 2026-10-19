import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { AppState } from 'react-native';
import { API_URL } from '../../services/api';
import { getSessionRevision, invalidateToken, readSessionSnapshot, removeToken, subscribeSession, writeToken } from '../../services/session-store';
import { decodeAuth, decodeUser, workbenchRequest } from '../api-workbench/core';
import { ChatAuthSheet } from '../ai-chat/auth-sheet';
import { useDesign } from '../design';
import { createAccountController, type AccountSnapshot } from './account-core';

type QAccount = AccountSnapshot & Pick<ReturnType<typeof createAccountController>,
  'refresh' | 'authenticate' | 'logout' | 'retryLogout' | 'updateProfile' | 'requestAuth' | 'closeAuth'>;
const Context = createContext<QAccount | null>(null);

export function QAccountProvider({ children }: { children: ReactNode }) {
  const { locale, text, setName, setProfileAvatar, setProfileBio, setTheme, setLocale } = useDesign();
  const [controller] = useState(() => createAccountController({
    store: { readSnapshot: readSessionSnapshot, getRevision: getSessionRevision, writeToken, removeToken, invalidateToken, subscribe: subscribeSession },
    user: (token, signal) => workbenchRequest({ baseUrl: API_URL, path: '/v1/me', token, signal, decode: decodeUser, transport: expoFetch }),
    authenticate: (mode, fields, signal) => workbenchRequest({ baseUrl: API_URL, path: `/v1/auth/${mode}`, method: 'POST', body: fields, signal, decode: decodeAuth, transport: expoFetch }),
    revoke: (token, signal) => workbenchRequest({ baseUrl: API_URL, path: '/v1/auth/logout', method: 'POST', token, signal, decode: () => undefined, transport: expoFetch }),
    patch: (token, fields, signal) => workbenchRequest({ baseUrl: API_URL, path: '/v1/me', method: 'PATCH', body: fields, token, signal, decode: decodeUser, transport: expoFetch }),
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') controller.closeAuth();
      else void controller.refresh();
    });
    return () => subscription.remove();
  }, [controller]);
  const user = snapshot.session?.user;
  useEffect(() => {
    setName(user?.display_name ?? (locale === 'zh' ? '访客' : 'Guest'));
    setProfileBio(user?.bio ?? '');
    setProfileAvatar(user?.avatar ?? 'orbit');
  }, [user, locale, setName, setProfileBio, setProfileAvatar]);
  useEffect(() => {
    if (!user) return;
    // Explicit API -> prototype preference mapping; signed-out device choices stay local.
    setTheme(user.theme);
    setLocale(user.locale === 'zh-CN' ? 'zh' : 'en');
  }, [user, setTheme, setLocale]);
  const account: QAccount = { ...snapshot, refresh: controller.refresh, authenticate: controller.authenticate, logout: controller.logout, retryLogout: controller.retryLogout,
    updateProfile: controller.updateProfile, requestAuth: controller.requestAuth, closeAuth: controller.closeAuth };
  return <Context value={account}>
    {children}
    <ChatAuthSheet controller={{ authOpen: snapshot.authOpen, authBusy: snapshot.authBusy, authError: snapshot.error,
      authenticate: controller.authenticate, closeAuth: controller.closeAuth }}
      description={text('使用同一个 Q 账号管理资料、与朋友聊天和使用服务。', 'Use one Q account for your profile, friends, and services.')} />
  </Context>;
}

export function useQAccount() {
  const value = use(Context);
  if (!value) throw new Error('QAccountProvider missing');
  return value;
}
