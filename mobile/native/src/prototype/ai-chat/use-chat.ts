import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import type { AiModel, AiStatus, AuthResponse } from '@xiaoq/shared';
import { API_URL } from '../../services/api';
import { readSessionSnapshot, getSessionRevision, invalidateToken, removeToken, writeToken, subscribeSession } from '../../services/session-store';
import { decodeAuth, decodeUser, workbenchRequest, WorkbenchError } from '../api-workbench/core';
import { ChatError, decodeAiStatus, streamChat } from './stream';
import { buildContext, finishStatus, prepareRetry, type ChatMessage, type Conversation, type ChatPlugin } from './state-model';
import { createHistoryWriter, decodeHistory, decodeHistoryPage, restoreHistory } from './history';
import { createAiConsentGate, hasAiConsent, revokeAiConsent, subscribeAiConsent } from './consent';

type ActiveRequest = { id: string; conversationId: string; assistantId: string; controller: AbortController; generation: number };
type ConsentRequest = { conversation: Conversation; messages: ChatMessage[]; invocationIds: string[]; clearDraft: boolean };
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
  const [aiConsentOpen, setAiConsentOpen] = useState(false);
  const [consentGate] = useState(() => createAiConsentGate<ConsentRequest>());
  const [messageError, setMessageError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const hydrated = useRef(new Set<string>());
  const historyOwner = useRef('');
  const writers = useRef(new Map<string, ReturnType<typeof createHistoryWriter>>());
  const historyEpoch = useRef(0);
  const historyAction = useRef(false);
  const [items, setItems] = useState<Conversation[]>([]);
  const list = useRef<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<AiModel>('deepseek-flash');
  const [think, setThink] = useState(false);
  const [plugin, setPlugin] = useState<ChatPlugin | null>(null);
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
  const writerFor = (account: AuthResponse) => {
    let writer = writers.current.get(account.token);
    if (!writer) {
      writer = createHistoryWriter((id, body) => workbenchRequest({ baseUrl: API_URL, path: `/v1/ai/conversations/${id}`, token: account.token, method: 'POST', body, decode: decodeHistory, transport: expoFetch }), randomUUID);
      writers.current.set(account.token, writer);
    }
    return writer;
  };
  const persist = async (account: AuthResponse, conversation: Conversation, retry = false) => {
    try {
      const writer = writerFor(account);
      if (retry) await writer.retry(conversation); else await writer.save(conversation);
      if (mounted.current && sessionRef.current?.token === account.token) setHistoryError('');
      return true;
    } catch (error) {
      if (mounted.current && sessionRef.current?.token === account.token) setHistoryError(error instanceof Error ? error.message : 'HISTORY_SAVE_FAILED');
      return false;
    }
  };
  const loadHistory = async (more = false) => {
    const account = sessionRef.current;
    if (!account) return;
    const epoch = ++historyEpoch.current;
    setHistoryBusy(true);
    try {
      const result = await call(`/v1/ai/conversations?limit=20${more && historyCursor ? `&cursor=${historyCursor}` : ''}`, decodeHistoryPage, account.token);
      if (!mounted.current || sessionRef.current?.token !== account.token || epoch !== historyEpoch.current) return;
      const writer = writerFor(account);
      result.items.forEach(item => { if (!hydrated.current.has(item.id)) writer.seed(item.id, item.revision); });
      updateItems(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...result.items.filter(item => !known.has(item.id)).map(item => ({ id: item.id, title: item.title, messages: [] }))];
      });
      setHistoryCursor(result.next_cursor); setHistoryError('');
    } catch (error) { if (mounted.current && sessionRef.current?.token === account.token && epoch === historyEpoch.current) setHistoryError(errorCode(error)); }
    finally { if (mounted.current && epoch === historyEpoch.current) setHistoryBusy(false); }
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
    const account = sessionRef.current;
    const snapshot = list.current.find(item => item.id === request.conversationId);
    if (account && snapshot) void persist(account, snapshot);
    if (mounted.current) setPhase('idle');
  };
  const invalidate = () => {
    generation.current++;
    historyEpoch.current++; setHistoryBusy(false);
    consentGate.cancel(); setAiConsentOpen(false);
    stop();
    for (const controller of shortRequests.current) controller.abort();
    shortRequests.current.clear();
    authLock.current = false;
    return generation.current;
  };
  const clearPrivateState = () => {
    historyEpoch.current++; hydrated.current.clear(); historyOwner.current = ''; setHistoryCursor(null); setHistoryError(''); setHistoryBusy(false);
    updateItems(() => []); select(null); setDraft(''); setMessageError(''); setPlugin(null);
  };
  const applySession = (value: AuthResponse | null) => {
    if (sessionRef.current?.token !== value?.token) revokeAiConsent();
    if (sessionRef.current && sessionRef.current.user.id !== value?.user.id) clearPrivateState();
    sessionRef.current = value; setSession(value);
    if (value && historyOwner.current !== value.user.id) { historyOwner.current = value.user.id; void loadHistory(); }
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
  const onAiConsentChanged = useEffectEvent(() => {
    if (!sessionRef.current || !hasAiConsent(sessionRef.current.token)) {
      consentGate.cancel(); setAiConsentOpen(false); stop();
    }
  });
  const activate = useEffectEvent(() => {
    if (visible) {
      if (sessionRef.current) void loadStatus(generation.current);
      else void restore();
    } else { invalidate(); setAuthBusy(false); setAuthOpen(false); }
  });
  useEffect(() => subscribeSession(onSessionChanged), []);
  useEffect(() => subscribeAiConsent(onAiConsentChanged), []);
  const stopOnUnmount = useEffectEvent(() => stop());
  useEffect(() => {
    mounted.current = true;
    const requests = shortRequests.current;
    const epoch = generation;
    const running = inflight;
    return () => {
      mounted.current = false;
      epoch.current++;
      stopOnUnmount();
      running.current = null;
      for (const controller of requests) controller.abort();
    };
  }, []);
  useEffect(() => {
    // Reuse the subscribed session on re-entry; a restore would cancel detail hydration.
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
        await writerFor(previous).drain();
        invalidateToken(previous.token);
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

  const start = (conversation: Conversation, baseMessages: ChatMessage[], invocationIds: string[] = [], clearDraft = false) => {
    const authenticated = sessionRef.current;
    if (inflight.current || authBusy || historyBusy || historyAction.current) return false;
    if (!authenticated) { setAuthOpen(true); return false; }
    if (!status?.configured) { setMessageError(statusError || 'AI_NOT_CONFIGURED'); return false; }
    let context: ReturnType<typeof buildContext>;
    try {
      const lastUser = baseMessages.findLastIndex(message => message.role === 'user');
      context = buildContext(baseMessages.slice(0, lastUser + 1));
    }
    catch (error) { setMessageError(errorCode(error)); return false; }
    if (!consentGate.request(authenticated.token, generation.current, { conversation, messages: baseMessages, invocationIds, clearDraft })) {
      setAiConsentOpen(true);
      return false;
    }
    const request: ActiveRequest = { id: randomUUID(), conversationId: conversation.id, assistantId: randomUUID(), controller: new AbortController(), generation: generation.current };
    if (writerFor(authenticated).hasPending(conversation.id)) { setHistoryError('HISTORY_SAVE_PENDING'); return false; }
    const selectedPlugin = conversation.plugin;
    const answer: ChatMessage = { id: request.assistantId, role: 'assistant', content: '', status: 'pending', model, thinking: selectedPlugin ? false : think, contextLimited: context.limited, toolInvocationIds: invocationIds };
    inflight.current = request;
    const next = { ...conversation, messages: [...baseMessages, answer] };
    updateItems(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [next, ...current]);
    hydrated.current.add(next.id);
    select(next.id); setPhase('waiting'); setMessageError('');
    const current = () => isCurrent(request.generation) && inflight.current === request && sessionRef.current?.token === authenticated.token;
    void (async () => {
      if (!await persist(authenticated, next)) {
        if (current()) { updateAnswer(request, message => ({ ...message, status: 'error', errorCode: 'HISTORY_SAVE_FAILED' })); if (clearDraft) setDraft(baseMessages.findLast(message => message.role === 'user')?.content ?? ''); }
        return;
      }
      if (!current()) return;
      await streamChat({ baseUrl: API_URL, token: authenticated.token, request: { model, thinking: selectedPlugin ? false : think, messages: context.messages, ...(selectedPlugin ? { plugin_connection_id: selectedPlugin.id, tool_invocation_ids: invocationIds } : {}) }, signal: request.controller.signal, transport: expoFetch,
      onEvent: event => {
        if (!current()) return;
        if (event.type === 'status') setPhase(event.phase);
        if (event.type === 'delta') { setPhase('responding'); updateAnswer(request, message => ({ ...message, content: message.content + event.text, status: 'streaming' })); }
        if (event.type === 'tool_proposal') {
          if (event.connection_id !== selectedPlugin?.id) { request.controller.abort(); return; }
          updateAnswer(request, message => ({ ...message, toolProposalId: event.invocation_id }));
        }
        if (event.type === 'done') updateAnswer(request, message => ({ ...message, status: event.finish_reason === 'tool_calls' && message.toolProposalId ? 'tool' : finishStatus(event.finish_reason, message.content), finishReason: event.finish_reason, usage: event.usage }));
      },
    });
    })().catch(async error => {
      if (!current()) return;
      if (error instanceof ChatError && error.status === 401) {
        const version = invalidate(); applySession(null); clearPrivateState(); setAuthError('UNAUTHORIZED'); setAuthOpen(true);
        await removeToken(authenticated.token).catch(() => { if (isCurrent(version)) setAuthError('STORAGE_ERROR'); });
        return;
      }
      const code = errorCode(error);
      updateAnswer(request, message => ({ ...message, status: code === 'CANCELLED' ? 'cancelled' : 'error', errorCode: code }));
    }).finally(() => {
      const final = list.current.find(item => item.id === request.conversationId);
      if (final && sessionRef.current?.token === authenticated.token && !writerFor(authenticated).hasPending(final.id)) void persist(authenticated, final);
      if (inflight.current === request) { inflight.current = null; if (mounted.current) setPhase('idle'); }
    });
    return true;
  };
  const send = (value: string) => {
    if (inflight.current || historyBusy || (activeIdRef.current && !hydrated.current.has(activeIdRef.current))) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const current = list.current.find(item => item.id === activeIdRef.current) ?? { id: randomUUID(), title: Array.from(trimmed).slice(0, 24).join(''), messages: [], ...(plugin ? { plugin } : {}) };
    if (current.messages.at(-1)?.errorCode === 'HISTORY_SAVE_FAILED' && current.messages.findLast(message => message.role === 'user')?.content === trimmed) {
      const base = prepareRetry(current);
      return base ? start(current, base, [], true) : false;
    }
    return start(current, [...current.messages, { id: randomUUID(), role: 'user', content: trimmed, status: 'complete' }], [], true);
  };
  const retry = () => {
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    const base = conversation ? prepareRetry(conversation) : null;
    if (conversation && base) start(conversation, base, conversation.messages.at(-1)?.toolInvocationIds ?? []);
  };
  const cancelAiSharing = () => { consentGate.cancel(); setAiConsentOpen(false); };
  const confirmAiSharing = () => {
    const pending = consentGate.approve(sessionRef.current?.token ?? '', generation.current);
    setAiConsentOpen(false);
    if (!pending || !mounted.current) return;
    if (start(pending.conversation, pending.messages, pending.invocationIds) && pending.clearDraft
      && draft.trim() === pending.messages.at(-1)?.content) setDraft('');
  };
  const newConversation = () => { cancelAiSharing(); stop(); select(null); setDraft(''); setMessageError(''); };
  const openConversation = async (id: string, replaceLocal = false) => {
    if (historyAction.current) return;
    if (replaceLocal) historyAction.current = true;
    cancelAiSharing(); stop(); select(id); setDraft(''); setMessageError('');
    const account = sessionRef.current;
    if (!account) { historyAction.current = false; return; }
    if (hydrated.current.has(id) && !replaceLocal) { setPlugin(list.current.find(item => item.id === id)?.plugin ?? null); return; }
    const version = generation.current;
    setHistoryBusy(true);
    try {
      if (replaceLocal) await writerFor(account).drain();
      const detail = await call(`/v1/ai/conversations/${id}`, decodeHistory, account.token);
      if (!isCurrent(version) || sessionRef.current?.token !== account.token || activeIdRef.current !== id) return;
      if (replaceLocal) writerFor(account).discard(id, detail.revision); else writerFor(account).seed(id, detail.revision, true);
      hydrated.current.add(id);
      updateItems(current => current.map(item => item.id === id ? restoreHistory(detail) : item));
      setPlugin(detail.plugin ?? null); setHistoryError('');
    } catch (error) { if (isCurrent(version) && activeIdRef.current === id) setHistoryError(errorCode(error)); }
    finally { if (replaceLocal) historyAction.current = false; if (isCurrent(version)) setHistoryBusy(false); }
  };
  const retryHistory = async () => {
    if (historyAction.current || inflight.current) return;
    const account = sessionRef.current;
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    if (account && conversation && writerFor(account).hasPending(conversation.id)) {
      historyAction.current = true; setHistoryBusy(true);
      try {
        if (await persist(account, conversation, true)) await persist(account, conversation);
      } finally { historyAction.current = false; if (mounted.current && sessionRef.current?.token === account.token) setHistoryBusy(false); }
    } else if (conversation && !hydrated.current.has(conversation.id)) await openConversation(conversation.id);
    else await loadHistory();
  };
  const selectPlugin = (value: ChatPlugin | null) => { newConversation(); setPlugin(value); if (value) setThink(false); };
  const resumeTool = (messageId: string, invocationId: string) => {
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    const message = conversation?.messages.at(-1);
    if (!conversation || !conversation.plugin || !message || message.id !== messageId || message.toolProposalId !== invocationId || inflight.current) return;
    const ids = [...(message.toolInvocationIds ?? []), invocationId];
    if (ids.length > 8) { setMessageError('PLUGIN_TURN_LIMIT'); return; }
    start(conversation, conversation.messages, ids);
  };

  return {
    session, status, statusError, authBusy, authOpen, authError, authenticate, logout, closeAuth, restore,
    openAuth: () => { setAuthError(''); setAuthOpen(true); },
    historyError, historyBusy, historyCursor, loadHistory, retryHistory,
    reloadCloud: () => { if (activeIdRef.current && !historyBusy && !inflight.current) void openConversation(activeIdRef.current, true); },
    items, conversation: items.find(item => item.id === activeId) ?? null, activeId,
    draft, setDraft, model, setModel, think, setThink, phase, busy: phase !== 'idle', messageError,
    send, stop, retry, newConversation, openConversation,
    plugin, selectPlugin, resumeTool,
    aiConsentOpen, confirmAiSharing, cancelAiSharing,
  };
}
export type ChatController = ReturnType<typeof useChat>;
