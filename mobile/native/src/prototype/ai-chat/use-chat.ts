import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import type { AiModel, AuthResponse } from '@xiaoq/shared';
import { API_URL } from '../../services/api';
import { readSessionSnapshot, getSessionRevision, invalidateToken, removeToken, writeToken, subscribeSession } from '../../services/session-store';
import { decodeAuth, decodeUser, workbenchRequest, WorkbenchError } from '../api-workbench/core';
import { ChatError, decodeAiStatus, streamChat } from './stream';
import { buildContext, finishStatus, prepareRetry, type ChatMessage, type Conversation, type ChatPlugin } from './state-model';
import { chatPluginSnapshot, createHistoryWriter, decodeHistory, decodeHistoryPage, restoreHistory } from './history';
import { createAiConsentGate, hasAiConsent, revokeAiConsent, subscribeAiConsent } from './consent';
import { createAiStatusMonitor, initialAiStatus } from './status-monitor';
import { bankIdForPlugin, bankTransferArguments, decodeInvocation, decodePluginConnection, type JsonObject } from '../plugin-host/core';
import { parseBankIntent } from '../banking/intent';
import { getBank } from '../banking/catalog';
import { decodeBankWallet } from '../banking/client';
import { appendLocalFinanceTurn, financialAiTitle, isFinancialAiConversation, localFinanceHelp, type LocalFinanceTurn } from '../finance-agent/conversation';
import { FINANCIAL_AI_GUIDANCE, respondToFinanceText } from '../finance-agent/intent';

type ActiveRequest = { id: string; conversationId: string; assistantId: string; controller: AbortController; generation: number; automaticInvocationId?: string };
type ConsentRequest = { conversation: Conversation; messages: ChatMessage[]; invocationIds: string[]; clearDraft: boolean };
type ToolResumeTarget = { conversationId: string; messageId: string; invocationId: string };
const errorCode = (error: unknown) => error instanceof ChatError || error instanceof WorkbenchError ? error.code
  : error instanceof Error && ['EMPTY_MESSAGE', 'MESSAGE_TOO_LONG', 'FINANCE_MESSAGE_TOO_LONG', 'LOCAL_FINANCE_PRIVATE'].includes(error.message) ? error.message : 'REQUEST_FAILED';

export function useChat(visible: boolean, locale: 'zh' | 'en' = 'zh') {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const sessionRef = useRef<AuthResponse | null>(null);
  const [statusSnapshot, setStatusSnapshot] = useState(initialAiStatus);
  const [statusMonitor] = useState(() => createAiStatusMonitor({
    load: signal => workbenchRequest({ baseUrl: API_URL, path: '/v1/ai/status', decode: decodeAiStatus, signal, transport: expoFetch, timeoutMs: 8000 }),
    onChange: setStatusSnapshot,
  }));
  const { status, error: statusError, phase: statusPhase } = statusSnapshot;
  const statusBusy = statusPhase === 'checking';
  const [authBusy, setAuthBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [aiConsentOpen, setAiConsentOpen] = useState(false);
  const [consentGate] = useState(() => createAiConsentGate<ConsentRequest>());
  const [messageError, setMessageError] = useState('');
  const [toolResumeTarget, setToolResumeTarget] = useState<ToolResumeTarget | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const hydrated = useRef(new Set<string>());
  const historyOwner = useRef('');
  const historyReady = useRef(false);
  const historyCapabilities = useRef(new Map<string, 'cloud' | 'session'>());
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
  const [financialAi, setFinancialAi] = useState(false);
  const [plugin, setPlugin] = useState<ChatPlugin | null>(null);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'thinking' | 'responding'>('idle');
  const generation = useRef(0);
  const [privacyEpoch, setPrivacyEpoch] = useState(0);
  const mounted = useRef(true);
  const shortRequests = useRef(new Set<AbortController>());
  const inflight = useRef<ActiveRequest | null>(null);
  const continuation = useRef<({ key: string; controller: AbortController } & ToolResumeTarget) | null>(null);
  const continuedInvocations = useRef(new Set<string>());
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
    if (conversation.localOnly || conversation.messages.some(message => message.localFinance || message.financeResult)) return false;
    const capability = historyCapabilities.current.get(account.token);
    if (capability === 'session') return true;
    if (capability !== 'cloud') return false;
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
    // Local-only is a privacy promise for this login session. A later deployment
    // must not silently upload the conversation on refresh or the next send.
    if (historyCapabilities.current.get(account.token) === 'session') {
      historyReady.current = true;
      setHistoryUnavailable(true); setHistoryCursor(null); setHistoryError(''); setHistoryBusy(false);
      return;
    }
    const epoch = ++historyEpoch.current;
    historyReady.current = false;
    setHistoryBusy(true);
    try {
      const result = await call(`/v1/ai/conversations?limit=20${more && historyCursor ? `&cursor=${historyCursor}` : ''}`, decodeHistoryPage, account.token);
      if (!mounted.current || sessionRef.current?.token !== account.token || epoch !== historyEpoch.current) return;
      historyCapabilities.current.set(account.token, 'cloud');
      historyReady.current = true; setHistoryUnavailable(false);
      const writer = writerFor(account);
      result.items.forEach(item => { if (!hydrated.current.has(item.id)) writer.seed(item.id, item.revision); });
      updateItems(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...result.items.filter(item => !known.has(item.id)).map(item => ({ id: item.id, title: item.title, messages: [] }))];
      });
      setHistoryCursor(result.next_cursor); setHistoryError('');
    } catch (error) {
      if (!mounted.current || sessionRef.current?.token !== account.token || epoch !== historyEpoch.current) return;
      // Only a missing collection on an as-yet unsupported server permits local-only
      // history. Detail/write errors or a server already proven capable never downgrade.
      if (error instanceof WorkbenchError && [404, 405].includes(error.status)
        && historyCapabilities.current.get(account.token) !== 'cloud' && !writers.current.has(account.token)) {
        historyCapabilities.current.set(account.token, 'session');
        historyReady.current = true;
        setHistoryUnavailable(true); setHistoryCursor(null); setHistoryError('');
      } else if (error instanceof WorkbenchError && error.status === 401) {
        const version = invalidate(); applySession(null); clearPrivateState(); setAuthError('UNAUTHORIZED');
        await removeToken(account.token).catch(() => { if (isCurrent(version)) setAuthError('STORAGE_ERROR'); });
      } else setHistoryError(errorCode(error));
    }
    finally { if (mounted.current && epoch === historyEpoch.current) setHistoryBusy(false); }
  };
  const select = (id: string | null) => { activeIdRef.current = id; setActiveId(id); };
  const updateAnswer = (request: ActiveRequest, update: (message: ChatMessage) => ChatMessage) => {
    updateItems(current => current.map(conversation => conversation.id !== request.conversationId ? conversation : {
      ...conversation, messages: conversation.messages.map(message => message.id === request.assistantId ? update(message) : message),
    }));
  };
  const stop = () => {
    if (continuation.current) {
      const { conversationId, messageId, invocationId } = continuation.current;
      if (mounted.current) setToolResumeTarget({ conversationId, messageId, invocationId });
      continuation.current.controller.abort(); continuation.current = null;
      if (mounted.current) setPhase('idle');
    }
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
    setPrivacyEpoch(value => value + 1);
    historyEpoch.current++; setHistoryBusy(false);
    consentGate.cancel(); setAiConsentOpen(false);
    stop();
    for (const controller of shortRequests.current) controller.abort();
    shortRequests.current.clear();
    authLock.current = false;
    return generation.current;
  };
  const clearPrivateState = () => {
    setToolResumeTarget(null);
    continuedInvocations.current.clear();
    historyEpoch.current++; hydrated.current.clear(); historyOwner.current = ''; setHistoryCursor(null); setHistoryError(''); setHistoryBusy(false);
    historyReady.current = false; setHistoryUnavailable(false);
    updateItems(() => []); select(null); setDraft(''); setMessageError(''); setPlugin(null);
  };
  const applySession = (value: AuthResponse | null) => {
    if (sessionRef.current?.token !== value?.token) revokeAiConsent();
    if ((sessionRef.current?.user.id ?? null) !== (value?.user.id ?? null)) clearPrivateState();
    sessionRef.current = value; setSession(value);
    if (value && historyOwner.current !== value.token) {
      historyOwner.current = value.token; historyReady.current = false; setHistoryUnavailable(false);
      void loadHistory();
    }
  };
  const isCurrent = (version: number) => mounted.current && generation.current === version;
  const call = async <T,>(path: string, decode: (value: unknown) => T, token?: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const controller = new AbortController();
    shortRequests.current.add(controller);
    try { return await workbenchRequest({ baseUrl: API_URL, path, decode, token, method, body, signal: controller.signal, transport: expoFetch }); }
    finally { shortRequests.current.delete(controller); }
  };
  const restore = async () => {
    const version = invalidate();
    setAuthBusy(true); setAuthError('');
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
      if (!sessionRef.current) void restore();
      else if (!historyReady.current) void loadHistory();
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
    // Mark external-session/history synchronization busy before accepting another send.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    activate();
  }, [visible]);
  useEffect(() => {
    // The shell already includes foreground/focus in visible. Keep this independent
    // of login cancellation and session generations, and stop retries while hidden.
    if (visible) statusMonitor.refresh();
    else statusMonitor.pause();
    return () => statusMonitor.pause();
  }, [visible, statusMonitor]);

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
        await writers.current.get(previous.token)?.drain();
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

  const start = (conversation: Conversation, baseMessages: ChatMessage[], invocationIds: string[] = [], clearDraft = false, continuationKey?: string) => {
    if (conversation.localOnly || baseMessages.some(message => message.localFinance || message.financeResult)) {
      setMessageError('LOCAL_FINANCE_PRIVATE'); return false;
    }
    const authenticated = sessionRef.current;
    if (inflight.current || continuation.current || authBusy || historyBusy || historyAction.current) return false;
    if (!authenticated) { setAuthOpen(true); return false; }
    if (!historyReady.current || historyOwner.current !== authenticated.token) return false;
    if (!status?.configured) { setMessageError(statusBusy ? 'AI_STATUS_CHECKING' : statusError || 'AI_NOT_CONFIGURED'); return false; }
    let context: ReturnType<typeof buildContext>;
    try {
      const lastUser = baseMessages.findLastIndex(message => message.role === 'user');
      context = buildContext(baseMessages.slice(0, lastUser + 1), (financialAi || isFinancialAiConversation(conversation)) && !conversation.plugin ? FINANCIAL_AI_GUIDANCE : '');
    }
    catch (error) { setMessageError(errorCode(error)); return false; }
    if (!consentGate.request(authenticated.token, generation.current, { conversation, messages: baseMessages, invocationIds, clearDraft })) {
      setAiConsentOpen(true);
      return false;
    }
    const request: ActiveRequest = { id: randomUUID(), conversationId: conversation.id, assistantId: randomUUID(), controller: new AbortController(), generation: generation.current };
    if (writers.current.get(authenticated.token)?.hasPending(conversation.id)) { setHistoryError('HISTORY_SAVE_PENDING'); return false; }
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
      if (continuationKey) { continuedInvocations.current.add(continuationKey); setToolResumeTarget(null); }
      await streamChat({ baseUrl: API_URL, token: authenticated.token, request: { model, thinking: selectedPlugin ? false : think, messages: context.messages, ...(selectedPlugin ? { plugin_connection_id: selectedPlugin.id, tool_invocation_ids: invocationIds, ...(status.automatic_readonly_tools === true ? { automatic_readonly_tools: true } : {}) } : {}) }, signal: request.controller.signal, transport: expoFetch,
      onEvent: event => {
        if (!current()) return;
        if (event.type === 'status') setPhase(event.phase);
        if (event.type === 'delta') { setPhase('responding'); updateAnswer(request, message => ({ ...message, content: message.content + event.text, status: 'streaming' })); }
        if (event.type === 'tool_proposal') {
          if (event.connection_id !== selectedPlugin?.id) { request.controller.abort(); return; }
          if (event.automatic === true && status.automatic_readonly_tools === true) request.automaticInvocationId = event.invocation_id;
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
    }).finally(async () => {
      const final = list.current.find(item => item.id === request.conversationId);
      let saved = false;
      if (final && sessionRef.current?.token === authenticated.token && !writers.current.get(authenticated.token)?.hasPending(final.id)) saved = await persist(authenticated, final);
      const stillActive = inflight.current === request;
      if (stillActive) { inflight.current = null; if (mounted.current) setPhase('idle'); }
      if (stillActive && !saved && isCurrent(request.generation) && request.automaticInvocationId && final?.messages.at(-1)?.status === 'tool') {
        setToolResumeTarget({ conversationId: request.conversationId, messageId: request.assistantId, invocationId: request.automaticInvocationId });
      }
      if (stillActive && saved && !request.controller.signal.aborted && isCurrent(request.generation)
        && activeIdRef.current === request.conversationId && final?.messages.at(-1)?.status === 'tool' && request.automaticInvocationId) {
        void resumeTool(request.assistantId, request.automaticInvocationId);
      }
    });
    return true;
  };
  // Legacy bank commands may already have prepared a proposal before losing the response.
  // Only their explicit retry reuses the original identity; all new messages use the model.
  const recoverBankCommand = (conversation: Conversation, baseMessages: ChatMessage[], retryAnswer: ChatMessage) => {
    if (conversation.localOnly || baseMessages.some(message => message.localFinance || message.financeResult)) return false;
    if (!retryAnswer.bankCommand) return false;
    const intent = parseBankIntent(baseMessages.findLast(message => message.role === 'user')?.content ?? '');
    const authenticated = sessionRef.current;
    if (inflight.current || continuation.current || authBusy || historyBusy || historyAction.current) return false;
    if (!authenticated) { setAuthOpen(true); return false; }
    if (!historyReady.current || historyOwner.current !== authenticated.token) return false;
    if (writers.current.get(authenticated.token)?.hasPending(conversation.id)) { setHistoryError('HISTORY_SAVE_PENDING'); return false; }
    const text = (zh: string, en: string) => authenticated.user.locale === 'en' ? en : zh;
    const selectedBankId = bankIdForPlugin(conversation.plugin);
    const sourceBankId = intent.kind === 'transfer' ? intent.fromBankId ?? selectedBankId : selectedBankId;
    // A bank command cannot silently change the plugin attached to an existing conversation.
    const mismatch = !!conversation.plugin && sourceBankId !== selectedBankId;
    const request: ActiveRequest = { id: randomUUID(), conversationId: conversation.id, assistantId: retryAnswer.id, controller: new AbortController(), generation: generation.current };
    const answer: ChatMessage = { id: request.assistantId, role: 'assistant', content: '', status: 'pending', bankCommand: true };
    inflight.current = request;
    let next: Conversation = { ...conversation, messages: [...baseMessages, answer] };
    const publish = () => updateItems(items => items.some(item => item.id === next.id) ? items.map(item => item.id === next.id ? next : item) : [next, ...items]);
    const current = () => isCurrent(request.generation) && inflight.current === request && sessionRef.current?.token === authenticated.token;
    const reply = (content: string) => { if (current()) updateAnswer(request, message => ({ ...message, content, status: 'complete' })); };
    publish(); hydrated.current.add(next.id); select(next.id); setPhase('waiting'); setMessageError('');
    void (async () => {
      let guidance = '';
      if (mismatch) guidance = text('这条对话正在使用另一插件。请先在钱包或银行插件页选择付款银行，再开始新对话。', 'This chat is using another plugin. Select the source bank in Wallet or Bank plugins to start a new chat.');
      else if (intent.kind === 'unsupported') {
        const reasons: Record<string, [string, string]> = {
          NEGATED_OR_CANCELLED: ['我没有发起转账。已有待确认转账请点击卡片里的取消按钮。', 'I have not initiated a transfer. Cancel any pending transfer using its card.'],
          REAL_ACCOUNT_UNSUPPORTED: ['当前只支持你的模拟账户或虚构收款人陈小明，请不要填写真实卡号或手机号。', 'Use your simulated accounts or the fictional recipient Chen Xiaoming. Do not enter real card or phone numbers.'],
          SCHEDULED_TRANSFER: ['当前支持即时模拟转账，预约和定期转账还未开放。', 'Immediate demo transfers are available; scheduled and recurring transfers are not.'],
          CURRENCY_NOT_HKD: ['当前银行插件只支持模拟港币，请用 HKD 金额重新填写。', 'Bank plugins support simulated HKD only. Enter the amount in HKD.'],
          INVALID_AMOUNT: ['请填写大于零、最多两位小数的港币金额。', 'Enter a positive HKD amount with at most two decimal places.'],
        };
        guidance = text(...(reasons[intent.reason] ?? ['这条指令还不够明确。请一次填写一笔转账，例如：从汇丰转 500 港币到陈小明的中银香港。', 'Please specify one transfer, for example: Transfer HKD 500 from HSBC to Chen at BOCHK.']));
      } else if (intent.kind === 'transfer') {
        const missing = [!sourceBankId ? text('付款银行', 'source bank') : '', !intent.toBankId ? text('收款银行', 'destination bank') : '', !intent.recipient ? text('收款人（自己或陈小明）', 'recipient (yourself or Chen Xiaoming)') : '', intent.amountMinor === undefined ? text('港币金额', 'HKD amount') : ''].filter(Boolean);
        if (missing.length) guidance = text(`还需要${missing.join('、')}。请补全后发送完整转账指令；目前没有发起转账。`, `Please include ${missing.join(', ')} in a complete transfer instruction. No transfer has been initiated.`);
        else if (intent.recipient === 'me' && sourceBankId === intent.toBankId) guidance = text('付款和收款是同一个账户，请选择另一家收款银行。', 'The source and destination are the same account. Choose another destination bank.');
        else if (intent.memo !== undefined && (Array.from(intent.memo).length > 120 || /[\u0000-\u001f\u007f]/.test(intent.memo))) guidance = text('备注最多 120 个字符，且不能包含换行或控制字符。', 'The memo must be at most 120 characters without line breaks or control characters.');
      }
      if (!guidance && !sourceBankId) guidance = text('请先在钱包或银行插件页选择一家已添加的银行。', 'Select an added bank in Wallet or Bank plugins first.');
      if (guidance) {
        next = { ...next, messages: [...baseMessages, { ...answer, status: 'complete', content: guidance }] };
        if (!current()) return;
        publish();
        if (!await persist(authenticated, next) && current()) setHistoryError('HISTORY_SAVE_FAILED');
        return;
      }
      // Reading an existing account never opens or adds a bank on the user's behalf.
      const wallet = await workbenchRequest({ baseUrl: API_URL, path: '/v1/banking/wallet', token: authenticated.token, decode: decodeBankWallet, signal: request.controller.signal, transport: expoFetch });
      if (!current()) return;
      const account = wallet.accounts.find(item => item.bank_id === sourceBankId);
      if (!account?.connection_id) { reply(text('请先在钱包或银行插件页添加付款银行，再回到这里转账。', 'Add the source bank in Wallet or Bank plugins, then return here.')); return; }
      if (intent.kind === 'transfer' && intent.recipient === 'me' && !wallet.accounts.some(item => item.bank_id === intent.toBankId && item.connection_id)) {
        reply(text('请先在钱包添加你自己的收款银行。当前没有创建转账。', 'Add your destination bank in Wallet first. No transfer has been created.')); return;
      }
      const connection = await workbenchRequest({ baseUrl: API_URL, path: `/v1/plugins/connections/${account.connection_id}`, token: authenticated.token, decode: decodePluginConnection, signal: request.controller.signal, transport: expoFetch });
      if (!current()) return;
      if (bankIdForPlugin(connection) !== sourceBankId || connection.status !== 'ready' || (conversation.plugin && conversation.plugin.id !== connection.id)) throw new WorkbenchError('BANK_NOT_CONNECTED');
      const selected: ChatPlugin = { id: connection.id, title: connection.title, endpoint_url: connection.endpoint_url, connection_kind: connection.connection_kind, builtin_service_id: connection.builtin_service_id };
      next = { ...next, plugin: selected };
      publish(); setPlugin(selected); setThink(false);
      // The assistant ID is durable before prepare and reused after timeout/restart.
      if (!await persist(authenticated, next)) { if (current()) updateAnswer(request, message => ({ ...message, status: 'error', errorCode: 'HISTORY_SAVE_FAILED' })); return; }
      if (!current()) return;
      let toolName: string, argumentsValue: JsonObject;
      if (intent.kind === 'transfer') {
        toolName = 'bank_transfer';
        argumentsValue = { to_bank_id: intent.toBankId, recipient: intent.recipient === 'me' ? 'self' : 'demo_chen', amount_minor: intent.amountMinor, ...(intent.memo === undefined ? {} : { memo: intent.memo }) };
      } else { toolName = intent.kind === 'history' ? 'bank_transactions' : 'bank_balance'; argumentsValue = intent.kind === 'history' ? { limit: 20 } : {}; }
      const invocation = await workbenchRequest({ baseUrl: API_URL, path: '/v1/plugins/invocations', token: authenticated.token, method: 'POST', body: { connection_id: selected.id, tool_name: toolName, arguments: argumentsValue, idempotency_key: answer.id }, decode: decodeInvocation, signal: request.controller.signal, transport: expoFetch });
      if (!current()) return;
      if (invocation.connection_id !== selected.id || bankIdForPlugin(invocation) !== sourceBankId || invocation.tool_name !== toolName
        || (toolName === 'bank_transfer' && (!bankTransferArguments(invocation) || invocation.arguments.to_bank_id !== argumentsValue.to_bank_id || invocation.arguments.recipient !== argumentsValue.recipient || invocation.arguments.amount_minor !== argumentsValue.amount_minor || (invocation.arguments.memo ?? '') !== (argumentsValue.memo ?? '')))) throw new WorkbenchError('INVALID_RESPONSE');
      updateAnswer(request, message => ({ ...message, status: 'tool', toolProposalId: invocation.id,
        content: text(`已通过${getBank(sourceBankId!).zh}插件准备好${toolName === 'bank_transfer' ? '转账' : '查询'}。请核对下方信息并确认。`, `The ${getBank(sourceBankId!).en} plugin has prepared your ${toolName === 'bank_transfer' ? 'transfer' : 'query'}. Review and confirm below.`) }));
    })().catch(async error => {
      if (!current()) return;
      if (error instanceof WorkbenchError && error.status === 401) {
        const version = invalidate(); applySession(null); clearPrivateState(); setAuthError('UNAUTHORIZED'); setAuthOpen(true);
        await removeToken(authenticated.token).catch(() => { if (isCurrent(version)) setAuthError('STORAGE_ERROR'); });
        return;
      }
      updateAnswer(request, message => ({ ...message, status: 'error', errorCode: errorCode(error), content: text('银行请求未完成。可以重试读取原提案；不会自动确认转账。', 'The bank request did not complete. Retry to recover the original proposal; transfers are never confirmed automatically.') }));
    }).finally(() => {
      const final = list.current.find(item => item.id === request.conversationId);
      if (final && sessionRef.current?.token === authenticated.token && !writers.current.get(authenticated.token)?.hasPending(final.id)) void persist(authenticated, final);
      if (inflight.current === request) { inflight.current = null; if (mounted.current) setPhase('idle'); }
    });
    return true;
  };
  const addLocalFinance = (turn: LocalFinanceTurn, continueLocal = false) => {
    if (authBusy || historyAction.current) return false;
    const previous = continueLocal ? list.current.find(item => item.id === activeIdRef.current) ?? null : null;
    if (previous && !previous.localOnly) return false;
    let next: Conversation;
    try { next = appendLocalFinanceTurn(previous, turn, randomUUID); }
    catch (error) {
      setMessageError(error instanceof Error && ['LOCAL_FINANCE_LIMIT', 'MESSAGE_TOO_LONG', 'LOCAL_FINANCE_PRIVATE'].includes(error.message) ? error.message : 'VALIDATION_ERROR');
      return false;
    }
    consentGate.cancel(); setAiConsentOpen(false); stop(); setToolResumeTarget(null);
    setPlugin(null); setThink(false); setFinancialAi(false); setMessageError(''); setDraft('');
    hydrated.current.add(next.id);
    updateItems(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [next, ...current]);
    select(next.id); setPhase('idle');
    return true;
  };
  const send = (value: string) => {
    if (inflight.current || historyBusy || (activeIdRef.current && !hydrated.current.has(activeIdRef.current))) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const active = list.current.find(item => item.id === activeIdRef.current);
    if (active?.localOnly) return addLocalFinance(respondToFinanceText(trimmed, locale) ?? localFinanceHelp(locale, trimmed), true);
    if (!financialAi && !isFinancialAiConversation(active) && !plugin && !active?.plugin) {
      const financial = respondToFinanceText(trimmed, locale);
      if (financial) return addLocalFinance(financial);
    }
    const current = list.current.find(item => item.id === activeIdRef.current) ?? { id: randomUUID(), title: financialAi ? financialAiTitle(trimmed, locale) : Array.from(trimmed).slice(0, 24).join(''), messages: [], ...(plugin ? { plugin } : {}) };
    if (current.messages.at(-1)?.errorCode === 'HISTORY_SAVE_FAILED' && current.messages.findLast(message => message.role === 'user')?.content === trimmed) {
      const base = prepareRetry(current);
      return base ? start(current, base, [], true) : false;
    }
    return start(current, [...current.messages, { id: randomUUID(), role: 'user', content: trimmed, status: 'complete' }], [], true);
  };
  const retry = () => {
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    if (conversation?.localOnly) return;
    const base = conversation ? prepareRetry(conversation) : null;
    if (conversation && base) {
      const last = conversation.messages.at(-1);
      if (last?.bankCommand) recoverBankCommand(conversation, base, last);
      else start(conversation, base, last?.toolInvocationIds ?? []);
    }
  };
  const cancelAiSharing = () => { consentGate.cancel(); setAiConsentOpen(false); };
  const confirmAiSharing = () => {
    const pending = consentGate.approve(sessionRef.current?.token ?? '', generation.current);
    setAiConsentOpen(false);
    if (!pending || !mounted.current) return;
    if (start(pending.conversation, pending.messages, pending.invocationIds) && pending.clearDraft
      && draft.trim() === pending.messages.at(-1)?.content) setDraft('');
  };
  const newConversation = () => { cancelAiSharing(); stop(); setToolResumeTarget(null); select(null); setDraft(''); setMessageError(''); setFinancialAi(false); };
  const newFinancialAi = () => { newConversation(); setPlugin(null); setFinancialAi(true); };
  const openConversation = async (id: string, replaceLocal = false) => {
    if (historyAction.current) return;
    if (replaceLocal) historyAction.current = true;
    cancelAiSharing(); stop(); setToolResumeTarget(null); select(id); setDraft(''); setMessageError(''); setFinancialAi(isFinancialAiConversation(list.current.find(item => item.id === id)));
    if (list.current.find(item => item.id === id)?.localOnly) {
      setPlugin(null); historyAction.current = false; return;
    }
    const account = sessionRef.current;
    if (!account) { historyAction.current = false; return; }
    if (historyCapabilities.current.get(account.token) === 'session') {
      setPlugin(list.current.find(item => item.id === id)?.plugin ?? null); historyAction.current = false; return;
    }
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
      setFinancialAi(isFinancialAiConversation(detail));
      setPlugin(detail.plugin ?? null); setHistoryError('');
    } catch (error) { if (isCurrent(version) && activeIdRef.current === id) setHistoryError(errorCode(error)); }
    finally { if (replaceLocal) historyAction.current = false; if (isCurrent(version)) setHistoryBusy(false); }
  };
  const retryHistory = async () => {
    if (historyAction.current || inflight.current) return;
    const account = sessionRef.current;
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    if (conversation?.localOnly) return;
    if (account && conversation && writers.current.get(account.token)?.hasPending(conversation.id)) {
      historyAction.current = true; setHistoryBusy(true);
      try {
        if (await persist(account, conversation, true)) await persist(account, conversation);
      } finally { historyAction.current = false; if (mounted.current && sessionRef.current?.token === account.token) setHistoryBusy(false); }
    } else if (conversation && !hydrated.current.has(conversation.id)) await openConversation(conversation.id);
    else await loadHistory();
  };
  const selectPlugin = (value: ChatPlugin | null) => {
    newConversation(); setPlugin(value ? chatPluginSnapshot(value) : null); if (value) setThink(false);
    statusMonitor.refresh();
  };
  const resumeTool = async (messageId: string, invocationId: string) => {
    const account = sessionRef.current;
    const conversation = list.current.find(item => item.id === activeIdRef.current);
    if (conversation?.localOnly) return;
    const message = conversation?.messages.at(-1);
    if (!account || !visible || !hasAiConsent(account.token) || !conversation || !conversation.plugin || !message || message.id !== messageId || message.toolProposalId !== invocationId || inflight.current || continuation.current || historyAction.current) return;
    const key = `${account.token}:${conversation.id}:${invocationId}`;
    if (continuedInvocations.current.has(key)) return;
    const ids = [...(message.toolInvocationIds ?? []), invocationId];
    if (ids.length > 8 || new Set(ids).size !== ids.length) { setMessageError('PLUGIN_TURN_LIMIT'); return; }
    const version = generation.current;
    const target = { conversationId: conversation.id, messageId, invocationId };
    const pending = { ...target, key, controller: new AbortController() };
    continuation.current = pending; setPhase('waiting'); setMessageError('');
    const current = () => isCurrent(version) && visible && continuation.current === pending && !pending.controller.signal.aborted
      && sessionRef.current?.token === account.token && activeIdRef.current === conversation.id && hasAiConsent(account.token);
    try {
      const writer = writers.current.get(account.token);
      await writer?.drain();
      if (!current()) return;
      if (writer?.hasPending(conversation.id)) { setToolResumeTarget(target); setHistoryError('HISTORY_SAVE_PENDING'); return; }
      // Read the saved result: neither UI callbacks nor the SSE hint authorize execution.
      const invocation = await workbenchRequest({ baseUrl: API_URL, path: `/v1/plugins/invocations/${invocationId}`, token: account.token,
        signal: pending.controller.signal, decode: decodeInvocation, transport: expoFetch });
      if (!current()) return;
      if (invocation.id !== invocationId || invocation.connection_id !== conversation.plugin.id
        || !['succeeded', 'tool_error'].includes(invocation.status) || invocation.result == null) throw new WorkbenchError('PLUGIN_RESULT_UNAVAILABLE');
      const latest = list.current.find(item => item.id === conversation.id);
      if (latest?.messages.at(-1)?.id !== messageId) return;
      continuation.current = null; setPhase('idle');
      if (!start(latest, latest.messages, ids, false, key)) setToolResumeTarget(target);
    } catch (error) {
      if (!current()) return;
      if (error instanceof WorkbenchError && error.status === 401) {
        const nextVersion = invalidate(); applySession(null); clearPrivateState(); setAuthError('UNAUTHORIZED'); setAuthOpen(true);
        await removeToken(account.token).catch(() => { if (isCurrent(nextVersion)) setAuthError('STORAGE_ERROR'); });
      } else { setToolResumeTarget(target); setMessageError('PLUGIN_CONTINUATION_FAILED'); }
    } finally {
      if (continuation.current === pending) { continuation.current = null; if (mounted.current) setPhase('idle'); }
    }
  };

  return {
    session, status, statusError, statusPhase, statusBusy, reconnect: statusMonitor.refresh,
    authBusy, authOpen, authError, authenticate, logout, closeAuth, restore,
    openAuth: () => { setAuthError(''); setAuthOpen(true); },
    historyError, historyBusy, historyUnavailable, historyCursor, loadHistory, retryHistory,
    reloadCloud: () => { if (activeIdRef.current && !list.current.find(item => item.id === activeIdRef.current)?.localOnly && !historyBusy && !inflight.current) void openConversation(activeIdRef.current, true); },
    items, conversation: items.find(item => item.id === activeId) ?? null, activeId,
    draft, setDraft, model, setModel, think, setThink, phase, busy: phase !== 'idle', messageError, toolResumeTarget,
    send, stop, retry, newConversation, openConversation,
    addLocalFinance: (turn: LocalFinanceTurn) => addLocalFinance(turn), privacyEpoch,
    financialAi, newFinancialAi,
    plugin, selectPlugin, resumeTool,
    aiConsentOpen, confirmAiSharing, cancelAiSharing,
  };
}
export type ChatController = ReturnType<typeof useChat>;
