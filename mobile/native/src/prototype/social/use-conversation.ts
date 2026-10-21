import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { decodeEphemeralState, decodeMessage, decodeMessagePage, decodeMutation, decodeOpened, type SocialMessage } from './api';
import { createDeadline, createPrivacyGate, id, isFinalSendRejection, remainingMs, restoreRejectedDraft, samePendingSend, sendPayload, SocialError, validateText, type Deadline, type EphemeralSeconds, type PendingSend, type RequestStamp } from './core';
import { outboxStore } from './outbox-store';
import { socialErrorCode, useSocial } from './state';

type VisibleBody = { body: string; deadline: Deadline };
export function useConversation(conversationId: string) {
  const social = useSocial();
  const service = useRef(social);
  useLayoutEffect(() => { service.current = social; }, [social]);
  const [messages, setMessages] = useState<SocialMessage[]>([]), [opened, setOpened] = useState<Record<string, VisibleBody>>({});
  const [draft, setDraft] = useState(''), [seconds, setSeconds] = useState<EphemeralSeconds | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(() => ({ mono: performance.now(), wall: Date.now() }));
  const gate = useRef(createPrivacyGate()), controllers = useRef(new Set<AbortController>());
  const after = useRef(0), list = useRef<SocialMessage[]>([]), pendingRef = useRef<PendingSend | null>(null);
  const loadingRef = useRef(false), sending = useRef(false), reading = useRef(false), readThrough = useRef(0);
  const desiredRead = useRef(0), lastReadAt = useRef(-Infinity);
  const opening = useRef(new Set<string>()), restoring = useRef(false);
  const visibleBodies = useRef<Record<string, VisibleBody>>({});
  const envelopeOffset = useRef(0);
  const ticket = useCallback(() => ({ page: gate.current.capture(), session: service.current.stamp() }), []);
  const current = useCallback((value: { page: number; session: RequestStamp | null }) => gate.current.accepts(value.page) && service.current.current(value.session), []);
  const updatePending = useCallback((value: PendingSend | null) => { pendingRef.current = value; setPending(value); }, []);
  const clear = useCallback(() => {
    gate.current.invalidate();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear(); opening.current.clear();
    list.current = []; after.current = 0; loadingRef.current = false; sending.current = false; reading.current = false; restoring.current = false; readThrough.current = 0; desiredRead.current = 0; lastReadAt.current = -Infinity;
    pendingRef.current = null; visibleBodies.current = {}; setPending(null); setMessages([]); setOpened({}); setDraft(''); setSeconds(null); setError(''); setBusy(false); setLoading(false); setHasMore(false);
  }, []);
  const call = useCallback(async <T,>(path: string, decode: (value: unknown) => T, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await service.current.call(path, decode, method, body, controller.signal); }
    finally { controllers.current.delete(controller); }
  }, []);
  const sync = useCallback(async () => {
    const stamp = ticket();
    if (!current(stamp) || loadingRef.current) return;
    try { id(conversationId); } catch { setError('INVALID_CONVERSATION'); setLoading(false); return; }
    loadingRef.current = true; setLoading(true);
    const cursor = after.current;
    try {
      const page = await call(`/v1/social/conversations/${conversationId}/messages?after_seq=${cursor}&limit=100`, decodeMessagePage);
      if (!current(stamp)) return;
      if (page.items.some(item => item.conversation_id !== conversationId || item.seq <= cursor) || page.next_after_seq < cursor || (!page.items.length && page.next_after_seq !== cursor) || (page.has_more && page.next_after_seq <= cursor)) throw new SocialError('INVALID_RESPONSE');
      const known = new Map(list.current.map(item => [item.id, item]));
      for (const item of page.items) known.set(item.id, item);
      list.current = [...known.values()].sort((a, b) => a.seq - b.seq);
      setMessages(list.current); after.current = page.next_after_seq; setHasMore(page.has_more); setError('');
      const envelopes = list.current.filter(item => item.kind === 'ephemeral' && !item.expired);
      const visibleIds = Object.keys(visibleBodies.current);
      const candidates = envelopes.filter(item => !visibleIds.includes(item.id));
      const offset = candidates.length ? envelopeOffset.current % candidates.length : 0;
      const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
      const ids = [...visibleIds, ...rotated.map(item => item.id)].slice(0, 100);
      envelopeOffset.current += Math.max(1, 100 - visibleIds.length);
      if (ids.length) {
        const requested = new Set(ids), mono = performance.now(), wall = Date.now();
        const refreshed = await call(`/v1/social/conversations/${conversationId}/ephemeral-state?message_ids=${ids.join(',')}`, decodeEphemeralState);
        if (!current(stamp)) return;
        if (refreshed.items.length !== ids.length || refreshed.items.some(item => item.conversation_id !== conversationId || !requested.has(item.id))) throw new SocialError('INVALID_RESPONSE');
        const updates = new Map(refreshed.items.map(item => [item.id, item]));
        list.current = list.current.map(item => updates.get(item.id) ?? item); setMessages(list.current);
        const bodies = { ...visibleBodies.current };
        for (const item of refreshed.items) {
          if (item.expired) { delete bodies[item.id]; continue; }
          if (bodies[item.id] && item.expires_at) {
            try {
              const deadline = createDeadline(refreshed.server_time, item.expires_at, mono, wall);
              if (remainingMs(deadline, performance.now(), Date.now()) < remainingMs(bodies[item.id].deadline, performance.now(), Date.now())) bodies[item.id] = { body: bodies[item.id].body, deadline };
            } catch { delete bodies[item.id]; }
          }
        }
        visibleBodies.current = bodies; setOpened(bodies);
      }
    } catch (failure) { if (current(stamp)) setError(socialErrorCode(failure)); }
    finally { if (current(stamp)) { loadingRef.current = false; setLoading(false); } }
  }, [call, conversationId, current, ticket]);

  const recover = useCallback(async () => {
    const stamp = ticket();
    if (!current(stamp) || !stamp.session || restoring.current) return;
    restoring.current = true;
    try {
      const stored = pendingRef.current ?? await outboxStore.read(stamp.session.ownerId, conversationId);
      if (!current(stamp) || !stored) return;
      updatePending(stored);
      try {
        const result = await call(`/v1/social/messages/by-client/${stored.clientMessageId}`, decodeMessage);
        if (!current(stamp)) return;
        if (result.sender_id !== stored.ownerId || result.conversation_id !== stored.conversationId || result.client_message_id !== stored.clientMessageId) throw new SocialError('INVALID_RESPONSE');
        await outboxStore.remove(stored.ownerId, stored.conversationId, stored.clientMessageId);
        if (!current(stamp)) return;
        updatePending(null); setError(''); void sync();
      } catch (failure) {
        if (!current(stamp)) return;
        if (failure instanceof SocialError && failure.status === 404 && failure.code === 'SOCIAL_NOT_FOUND') setError(stored.text === null ? 'EPHEMERAL_NOT_SENT' : 'SEND_NOT_CONFIRMED');
        else throw failure;
      }
    } catch (failure) { if (current(stamp)) setError(socialErrorCode(failure)); }
    finally { if (current(stamp)) restoring.current = false; }
  }, [call, conversationId, current, sync, ticket, updatePending]);

  const send = useCallback(async (retry = false) => {
    const stamp = ticket();
    if (!current(stamp) || !stamp.session || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    let intent: PendingSend | null = null;
    try {
      if (service.current.metadata?.conversations.find(item => item.id === conversationId)?.active !== true) throw new SocialError('SOCIAL_FRIEND_REQUIRED');
      if (retry) intent = pendingRef.current;
      else {
        if (pendingRef.current) throw new SocialError('PENDING_SEND_EXISTS');
        intent = { ownerId: stamp.session.ownerId, conversationId: id(conversationId), clientMessageId: randomUUID(), text: validateText(draft), ttlSeconds: seconds };
        await outboxStore.write(intent, randomUUID());
        if (!current(stamp)) return;
        updatePending(intent); setDraft('');
      }
      if (!intent || intent.text === null) throw new SocialError('EPHEMERAL_BODY_CLEARED');
      // A retry keeps both the original UUID and the exact original payload.
      const result = await call(`/v1/social/conversations/${intent.conversationId}/messages`, decodeMessage, 'POST', sendPayload(intent));
      if (!current(stamp)) return;
      if (result.sender_id !== intent.ownerId || result.client_message_id !== intent.clientMessageId || result.conversation_id !== intent.conversationId) throw new SocialError('INVALID_RESPONSE');
      await outboxStore.remove(intent.ownerId, intent.conversationId, intent.clientMessageId);
      if (!current(stamp)) return;
      updatePending(null); setSeconds(null); void sync(); void service.current.refresh();
    } catch (failure) {
      if (!current(stamp)) return;
      if (intent && isFinalSendRejection(failure) && samePendingSend(pendingRef.current, intent)) {
        const rejected = intent;
        try {
          await outboxStore.remove(rejected.ownerId, rejected.conversationId, rejected.clientMessageId);
          if (!current(stamp) || !samePendingSend(pendingRef.current, rejected)) return;
          updatePending(null);
          setDraft(value => current(stamp) ? restoreRejectedDraft(value, rejected) : value);
          setError('CONTENT_BLOCKED');
        } catch (storageFailure) {
          if (current(stamp)) setError(socialErrorCode(storageFailure));
        }
        return;
      }
      if (failure instanceof SocialError && failure.status === 410 && failure.code === 'SOCIAL_MESSAGE_EXPIRED' && intent) {
        await outboxStore.remove(intent.ownerId, intent.conversationId, intent.clientMessageId);
        if (!current(stamp)) return;
        updatePending(null);
      }
      setError(socialErrorCode(failure));
      if (intent && !pendingRef.current) void recover();
    } finally { if (current(stamp)) { sending.current = false; setBusy(false); } }
  }, [call, conversationId, current, draft, recover, seconds, sync, ticket, updatePending]);

  const discardUnsent = useCallback(async () => {
    const stamp = ticket(), intent = pendingRef.current;
    if (!current(stamp) || !intent || restoring.current || sending.current) return;
    // A fresh owner-scoped lookup is required before abandoning a lost ephemeral draft.
    try {
      const result = await call(`/v1/social/messages/by-client/${intent.clientMessageId}`, decodeMessage);
      if (!current(stamp)) return;
      if (result.conversation_id !== conversationId || result.sender_id !== intent.ownerId) throw new SocialError('INVALID_RESPONSE');
      await outboxStore.remove(intent.ownerId, conversationId, intent.clientMessageId);
      if (current(stamp)) { updatePending(null); void sync(); }
    } catch (failure) {
      if (!current(stamp)) return;
      if (failure instanceof SocialError && failure.status === 404 && failure.code === 'SOCIAL_NOT_FOUND') {
        await outboxStore.remove(intent.ownerId, conversationId, intent.clientMessageId);
        if (current(stamp)) { updatePending(null); setError(''); }
      } else setError(socialErrorCode(failure));
    }
  }, [call, conversationId, current, sync, ticket, updatePending]);

  const open = useCallback(async (message: SocialMessage) => {
    const stamp = ticket();
    if (!current(stamp) || opening.current.has(message.id)) return;
    opening.current.add(message.id);
    const mono = performance.now(), wall = Date.now();
    try {
      const result = await call(`/v1/social/messages/${message.id}/open`, decodeOpened, 'POST', {});
      if (!current(stamp)) return;
      if (service.current.metadata?.conversations.find(item => item.id === conversationId)?.active !== true) throw new SocialError('SOCIAL_FRIEND_REQUIRED');
      if (result.message_id !== message.id) throw new SocialError('INVALID_RESPONSE');
      const deadline = createDeadline(result.server_time, result.expires_at, mono, wall);
      if (remainingMs(deadline, performance.now(), Date.now()) <= 0) throw new SocialError('SOCIAL_MESSAGE_EXPIRED');
      visibleBodies.current = Object.fromEntries([...Object.entries(visibleBodies.current).filter(([key]) => key !== message.id), [message.id, { body: result.body, deadline }]].slice(-100));
      setOpened(visibleBodies.current); setClock({ mono: performance.now(), wall: Date.now() });
      list.current = list.current.map(item => item.id === message.id ? { ...item, expires_at: result.expires_at } : item); setMessages(list.current);
      setError('');
    } catch (failure) {
      if (current(stamp)) {
        const next = { ...visibleBodies.current }; delete next[message.id]; visibleBodies.current = next; setOpened(next);
        if (failure instanceof SocialError && ['SOCIAL_MESSAGE_EXPIRED', 'MESSAGE_EXPIRED'].includes(failure.code)) { list.current = list.current.map(item => item.id === message.id ? { ...item, expired: true } : item); setMessages(list.current); }
        setError(socialErrorCode(failure));
      }
    } finally { if (current(stamp)) opening.current.delete(message.id); }
  }, [call, conversationId, current, ticket]);

  const markRead = useCallback(async (through: number) => {
    const stamp = ticket();
    if (!current(stamp) || through > after.current) return;
    desiredRead.current = Math.max(desiredRead.current, through);
    if (desiredRead.current <= readThrough.current || reading.current || performance.now() - lastReadAt.current < 3000) return;
    const target = desiredRead.current;
    reading.current = true; lastReadAt.current = performance.now();
    try {
      await call(`/v1/social/conversations/${conversationId}/read`, decodeMutation, 'POST', { through_seq: target });
      if (current(stamp)) { readThrough.current = target; void service.current.refresh(); }
    } catch (failure) { if (current(stamp)) setError(socialErrorCode(failure)); }
    finally { if (current(stamp)) reading.current = false; }
  }, [call, conversationId, current, ticket]);

  useFocusEffect(useCallback(() => {
    gate.current.enter(); clear(); void sync(); void recover();
    const subscription = service.current.subscribeReset(clear);
    const app = AppState.addEventListener('change', value => { if (value === 'active') { void sync(); void recover(); } else clear(); });
    const poll = setInterval(() => { if (AppState.currentState === 'active') { void sync(); void markRead(desiredRead.current); if (pendingRef.current) void recover(); } }, 3000);
    return () => { gate.current.leave(); subscription(); app.remove(); clearInterval(poll); clear(); };
  }, [clear, markRead, recover, sync]));
  const activeConversation = social.metadata?.conversations.find(item => item.id === conversationId)?.active;
  const relationshipChanged = useEffectEvent(() => { if (activeConversation === false) { clear(); void sync(); } });
  // Losing friendship must clear open content immediately, even while this route stays mounted.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { relationshipChanged(); }, [activeConversation]);
  // Expiry is per message. Timer drift or wall-clock changes remove the body conservatively.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!gate.current.isActive() || AppState.currentState !== 'active') return;
      const mono = performance.now(), wall = Date.now();
      const expired = new Set(Object.entries(visibleBodies.current).filter(([, value]) => remainingMs(value.deadline, mono, wall) <= 0).map(([key]) => key));
      if (expired.size) {
        visibleBodies.current = Object.fromEntries(Object.entries(visibleBodies.current).filter(([key]) => !expired.has(key))); setOpened(visibleBodies.current);
        list.current = list.current.map(item => expired.has(item.id) ? { ...item, expired: true } : item); setMessages(list.current);
      }
      setClock({ mono, wall });
    }, 250);
    return () => clearInterval(timer);
  }, []);
  return { messages, opened, draft, setDraft, seconds, setSeconds, pending, busy, error, hasMore, loading, clock, sync, recover, send, open, markRead, discardUnsent };
}
