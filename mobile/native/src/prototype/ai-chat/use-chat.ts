import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import type { AiModel, AiStatus, AuthResponse } from '@xiaoq/shared';
import { API_URL } from '../../services/api';
import { readSessionSnapshot, getSessionRevision, removeToken, writeToken, subscribeSession } from '../../services/session-store';
import { decodeAuth, decodeUser, workbenchRequest, WorkbenchError } from '../api-workbench/core';
import { ChatError, decodeAiStatus, streamChat } from './stream';
import { buildContext, finishStatus, prepareRetry, type ChatMessage, type Conversation } from './state-model';

type ActiveRequest = { id: string; conversationId: string; assistantId: string; controller: AbortController; generation: number };
const errorCode = (error: unknown) => error instanceof ChatError || error instanceof WorkbenchError ? error.code
  : error instanceof Error && ['EMPTY_MESSAGE', 'MESSAGE_TOO_LONG'].includes(error.message) ? error.message : 'REQUEST_FAILED';

export function useChat(visible: boolean) {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const sessionRef = useRef<AuthResponse | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const list = useRef<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<AiModel>('deepseek-flash');
  const [think, setThink] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'thinking' | 'responding'>('idle');
  const generation = useRef(0);
  const mounted = useRef(true);
  const shortRequests = useRef(new Set<AbortController>());
  const inflight = useRef<ActiveRequest | null>(null);
  const authLock = useRef(false);
  const pendingAuth = useRef<{ version: number; result: AuthResponse } | null>(null);

  const updateItems = (update: (current: Conversation[]) => Conversation[]) => {
    list.current = update(list.current);
    if (mounted.current) setItems(list.current);
  };
  const select = (id: string | null) => { activeIdRef.current = id; setActiveId(id); };
  const updateAnswer = (request: ActiveRequest, update: (message: ChatMessage) => ChatMessage) => {
    updateItems(current => current.map(conversation => conversation.id !== request.conversationId ? conversation : {
      ...conversation, messages: conversation.messages.map(message => message.id === request.assistantId ? update(message) : message),
    }));
  };
  const stop = () => {
    const request = inflight.current;
    if (!request) return;
    inflight.current = null;
    request.controller.abort();
    updateAnswer(request, message => ({ ...message, status: 'cancelled' }));
    if (mounted.current) setPhase('idle');
  };
  const invalidate = () => {
    generation.current++;
    stop();
    for (const controller of shortRequests.current) controller.abort();
    shortRequests.current.clear();
    authLock.current = false;
    return generation.current;
  };
  const clearPrivateState = () => {
    updateItems(() => []); select(null); setDraft(''); setMessageError('');
  };
  const applySession = (value: AuthResponse | null) => {
    if (sessionRef.current && sessionRef.current.user.id !== value?.user.id) clearPrivateState();
    sessionRef.current = value; setSession(value);
  };
  const isCurrent = (version: number) => mounted.current && generation.current === version;
  const call = async <T,>(path: string, decode: (value: unknown) => T, token?: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const controller = new AbortController();
    shortRequests.current.add(controller);
    try { return await workbenchRequest({ baseUrl: API_URL, path, decode, token, method, body, signal: controller.signal, transport: expoFetch }); }
    finally { shortRequests.current.delete(controller); }
  };
  const loadStatus = async (version: number) => {
    try {
      const result = await call('/v1/ai/status', decodeAiStatus);
      if (isCurrent(version)) { setStatus(result); setStatusError(''); }
    } catch (error) { if (isCurrent(version)) { setStatus(null); setStatusError(errorCode(error)); } }
  };
  const restore = async () => {
    const version = invalidate();
    setAuthBusy(true); setAuthError('');
    void loadStatus(version);
    let restoredToken: string | null = null;
    try {
      const snapshot = await readSessionSnapshot();
      const token = snapshot.token;
      restoredToken = token;
      if (!isCurrent(version) || snapshot.revision !== getSessionRevision()) return;
      if (!token) { applySession(null); return; }
      if (sessionRef.current && sessionRef.current.token !== token) applySession(null);
      const user = await call('/v1/me', decodeUser, token);
      if (isCurrent(version) && snapshot.revision === getSessionRevision()) applySession({ token, user });
    } catch (error) {
      if (!isCurrent(version)) return;
      setAuthError(errorCode(error));
      if (error instanceof WorkbenchError && error.status === 401) {
        applySession(null);
        if (restoredToken) await removeToken(restoredToken).catch(() => { if (isCurrent(version)) setAuthError('STORAGE_ERROR'); });
      }
    } finally { if (isCurrent(version)) setAuthBusy(false); }
  };

  const onSessionChanged = useEffectEvent((token: string | null) => {
    const pending = pendingAuth.current;
    if (pending && pending.result.token === token && isCurrent(pending.version)) {
      applySession(pending.result);
      return;
    }
    if ((sessionRef.current?.token ?? null) === token) return;
    invalidate(); applySession(null); clearPrivateState(); setAuthBusy(false); setAuthOpen(false); setAuthError('');
    if (visible) void restore();
  });
  const activate = useEffectEvent(() => {
    if (visible) void restore();
    else { invalidate(); setAuthBusy(false); setAuthOpen(false); }
  });
  useEffect(() => subscribeSession(onSessionChanged), []);
  useEffect(() => {
    mounted.current = true;
    const requests = shortRequests.current;
    const epoch = generation;
    const running = inflight;
    return () => {
      mounted.current = false;
      epoch.current++;
      running.current?.controller.abort();
      running.current = null;
      for (const controller of requests) controller.abort();
    };
  }, []);
  useEffect(() => {
    // Restore the external Q session on entry and cancel it on leave. The loading
    // state is intentional synchronization, not state derived from a render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    activate();
  }, [visible]);

  const authenticate = async (mode: 'login' | 'register', fields: { handle: string; password: string; display_name?: string }) => {
    if (authLock.current) return false;
    const version = invalidate();
    authLock.current = true; setAuthBusy(true); setAuthError('');
    try {
      const result = await call(`/v1/auth/${mode}`, decodeAuth, undefined, 'POST', fields);
      if (!isCurrent(version)) return false;
      pendingAuth.current = { version, result };
      let stored: boolean;
      try { stored = await writeToken(result.token, () => isCurrent(version)); }
      catch { throw new ChatError('STORAGE_ERROR'); }
      finally { if (pendingAuth.current?.version === version) pendingAuth.current = null; }
      if (!stored || !isCurrent(version)) return false;
      applySession(result); setAuthOpen(false);
      void loadStatus(version);
      return true;
    } catch (error) { if (isCurrent(version)) setAuthError(errorCode(error)); return false; }
    finally { if (isCurrent(version)) { authLock.current = false; setAuthBusy(false); } }
  };
  const closeAuth = () => { invalidate(); setAuthOpen(false); setAuthBusy(false); setAuthError(''); };
  const logout = async () => {
    const previous = sessionRef.current;
    const version = invalidate();
    applySession(null); clearPrivateState(); setAuthBusy(true); setAuthOpen(false);
    try {
      if (previous) {
        // Try both independently: a local storage failure must not skip server revocation.
        const [local, remote] = await Promise.allSettled([
          removeToken(previous.token),
          call('/v1/auth/logout', () => undefined, previous.token, 'POST'),
        ]);
        if (isCurrent(version)) setAuthError(local.status === 'rejected' ? 'STORAGE_ERROR' : remote.status === 'rejected' ? 'LOGOUT_UNCONFIRMED' : '');
      }
    } catch { if (isCurrent(version)) setAuthError('LOGOUT_UNCONFIRMED'); }
    finally { if (isCurrent(version)) setAuthBusy(false); }
  };

  const start = (conversation: Conversation, baseMessages: ChatMessage[]) => {
    const authenticated = sessionRef.current;
    if (inflight.current || authBusy) return false;
    if (!authenticated) { setAuthOpen(true); return false; }
    if (!status?.configured) { setMessageError(statusError || 'AI_NOT_CONFIGURED'); return false; }
    let context: ReturnType<typeof buildContext>;
    try { context = buildContext(baseMessages); }
    catch (error) { setMessageError(errorCode(error)); return false; }
    const request: ActiveRequest = { id: randomUUID(), conversationId: conversation.id, assistantId: randomUUID(), controller: new AbortController(), generation: generation.current };
    const answer: ChatMessage = { id: request.assistantId, role: 'assistant', content: '', status: 'pending', model, thinking: think, contextLimited: context.limited };
    inflight.current = request;
    const next = { ...conversation, messages: [...baseMessages, answer] };
    updateItems(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [next, ...current]);
    select(next.id); setPhase('waiting'); setMessageError('');
    const current = () => isCurrent(request.generation) && inflight.current === request && sessionRef.current?.token === authenticated.token;
    void streamChat({ baseUrl: API_URL, token: authenticated.token, request: { model, thinking: think, messages: context.messages }, signal: request.controller.signal, transport: expoFetch,
      onEvent: event => {
        if (!current()) return;
        if (event.type === 'status') setPhase(event.phase);
        if (event.type === 'delta') { setPhase('responding'); updateAnswer(request, message => ({ ...message, content: message.content + event.text, status: 'streaming' })); }
        if (event.type === 'done') updateAnswer(request, message => ({ ...message, status: finishStatus(event.finish_reason, message.content), finishReason: event.finish_reason, usage: event.usage }));
      },
    }).catch(async error => {
      if (!current()) return;
      if (error instanceof ChatError && error.status === 401) {
        const version = invalidate(); applySession(null); clearPrivateState(); setAuthError('UNAUTHORIZED'); setAuthOpen(true);
        await removeToken(authenticated.token).catch(() => { if (isCurrent(version)) setAuthError('STORAGE_ERROR'); });
        return;
      }
      const code = errorCode(error);
      updateAnswer(request, message => ({ ...message, status: code === 'CANCELLED' ? 'cancelled' : 'error', errorCode: code }));
    }).finally(() => {
      if (inflight.current === request) { inflight.current = null; if (mounted.current) setPhase('idle'); }
    });
    return true;
  };
  const send = (value: string) => {
    if (inflight.current) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const current = list.current.find(item => item.id === activeIdRef.current) ?? { id: randomUUID(), title: Array.from(trimmed).slice(0, 24).join(''), messages: [] };
    return start(current, [...current.messages, { id: randomUUID(), role: 'user', content: trimmed, status: 'complete' }]);
  };
  const retry = () => {
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    const base = conversation ? prepareRetry(conversation) : null;
    if (conversation && base) start(conversation, base);
  };
  const newConversation = () => { stop(); select(null); setDraft(''); setMessageError(''); };
  const openConversation = (id: string) => { stop(); select(id); setDraft(''); setMessageError(''); };

  return {
    session, status, statusError, authBusy, authOpen, authError, authenticate, logout, closeAuth, restore,
    openAuth: () => { setAuthError(''); setAuthOpen(true); },
    items, conversation: items.find(item => item.id === activeId) ?? null, activeId,
    draft, setDraft, model, setModel, think, setThink, phase, busy: phase !== 'idle', messageError,
    send, stop, retry, newConversation, openConversation,
  };
}
export type ChatController = ReturnType<typeof useChat>;
