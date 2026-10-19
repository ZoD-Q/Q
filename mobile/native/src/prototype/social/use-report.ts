import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import type { SocialReportRequest } from '@xiaoq/shared';
import { createPrivacyGate, SocialError, type RequestStamp } from './core';
import { decodeMutation, decodeReportReceipt } from './api';
import { inspectReportReceipt, isFinalReportRejection, recoverReportRequest, reportReason, type PendingReport, type ReportMeta } from './report-core';
import { hashReportReason, reportStore } from './report-store';
import { socialErrorCode, useSocial } from './state';

export function usePendingReportMeta() {
  const social = useSocial(), { ownerId, subscribeReset } = social;
  const service = useRef(social); useLayoutEffect(() => { service.current = social; }, [social]);
  const [stored, setStored] = useState<ReportMeta | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    const load = async () => {
      const stamp = service.current.stamp();
      if (!ownerId || !stamp) return;
      try { const result = await reportStore.meta(ownerId); if (live && service.current.current(stamp)) setStored(result); }
      catch { /* The report form displays storage errors without discarding unknown outcomes. */ }
    };
    void load();
    const storage = reportStore.subscribe(() => { void load(); });
    const reset = subscribeReset(() => setStored(null));
    const app = AppState.addEventListener('change', value => { if (value === 'active') void load(); });
    return () => { live = false; storage(); reset(); app.remove(); };
  }, [ownerId, subscribeReset]));
  return stored?.ownerId === ownerId ? stored : null;
}

export function useReport(userId: string, messageId: string | null) {
  const social = useSocial(), service = useRef(social);
  useLayoutEffect(() => { service.current = social; }, [social]);
  const [reason, setReason] = useState(''), [evidence, setEvidence] = useState(false);
  const [intent, setIntent] = useState<SocialReportRequest | null>(null), [pending, setPending] = useState<PendingReport | null>(null);
  const [stage, setStage] = useState<'loading' | 'edit' | 'confirm' | 'recover' | 'done'>('loading');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<'accepted' | 'expired' | 'rejected'>('accepted');
  const gate = useRef(createPrivacyGate()), controllers = useRef(new Set<AbortController>()), locked = useRef(false);
  const intentRef = useRef<SocialReportRequest | null>(null);
  const ticket = () => ({ page: gate.current.capture(), session: service.current.stamp() });
  const valid = (value: { page: number; session: RequestStamp | null }) => gate.current.accepts(value.page) && service.current.current(value.session);
  const call = async <T,>(path: string, decode: (value: unknown) => T, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    const controller = new AbortController(); controllers.current.add(controller);
    try { return await service.current.call(path, decode, method, body, controller.signal); }
    finally { controllers.current.delete(controller); }
  };
  const clear = useCallback(() => {
    gate.current.invalidate(); locked.current = false;
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    intentRef.current = null; setIntent(null); setPending(null); setReason(''); setEvidence(false); setError(''); setBusy(false); setStage('loading');
  }, []);
  const resolve = async (value: PendingReport, stamp: ReturnType<typeof ticket>) => {
    try {
      const result = await inspectReportReceipt(value, stamp.session?.ownerId ?? '', clientId => call(`/v1/social/reports/by-client/${clientId}`, decodeReportReceipt));
      if (!valid(stamp)) return;
      if (result === 'unknown') { setStage('recover'); setError('REPORT_NOT_CONFIRMED'); return; }
      await reportStore.remove(value.ownerId, value.clientReportId);
      if (!valid(stamp)) return;
      intentRef.current = null; setIntent(null); setPending(null); setReason(''); setError(''); setOutcome(result); setStage('done');
    } catch (failure) {
      if (!valid(stamp)) return;
      setStage('recover'); setError(socialErrorCode(failure));
    }
  };
  const restore = async () => {
    const stamp = ticket(); if (!valid(stamp) || !stamp.session || locked.current) return;
    locked.current = true; setBusy(true);
    try {
      let stored: PendingReport | null;
      try { stored = await reportStore.read(stamp.session.ownerId); }
      catch (failure) {
        // Receipt lookup needs only the manifest. A damaged reason chunk must not lose the original ID.
        const meta = await reportStore.meta(stamp.session.ownerId);
        if (!meta) throw failure;
        stored = { ...meta, reason: null };
      }
      if (!valid(stamp)) return;
      if (!stored) { setStage(intentRef.current ? 'confirm' : 'edit'); setError(''); return; }
      setPending(stored); setEvidence(stored.includeEvidence);
      setReason(stored.reason ?? (intentRef.current?.client_report_id === stored.clientReportId ? intentRef.current.reason : ''));
      setStage('recover'); await resolve(stored, stamp);
    } catch (failure) { if (valid(stamp)) { setStage('recover'); setError(socialErrorCode(failure)); } }
    finally { if (valid(stamp)) { locked.current = false; setBusy(false); } }
  };
  const prepare = () => {
    try {
      const value = { client_report_id: randomUUID(), user_id: userId, message_id: messageId, reason: reportReason(reason), include_evidence: evidence };
      intentRef.current = value; setIntent(value); setError(''); setStage('confirm');
    } catch (failure) { setError(socialErrorCode(failure)); }
  };
  const submit = async () => {
    const stamp = ticket(); if (!valid(stamp) || !stamp.session || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    let submitted: SocialReportRequest | null = null;
    try {
      const request = pending ? await recoverReportRequest(pending, stamp.session.ownerId, reason, hashReportReason) : intentRef.current;
      if (!request) throw new SocialError('PENDING_REPORT_EXISTS');
      if (!valid(stamp)) return;
      // The durable original ID precedes the first network mutation.
      const saved = await reportStore.save(stamp.session.ownerId, request);
      if (!valid(stamp)) return;
      setPending(saved); setStage('recover');
      submitted = request;
      await call('/v1/social/reports', decodeMutation, 'POST', request);
      if (!valid(stamp)) return;
      await reportStore.remove(stamp.session.ownerId, request.client_report_id);
      if (!valid(stamp)) return;
      intentRef.current = null; setIntent(null); setPending(null); setReason(''); setOutcome('accepted'); setStage('done');
    } catch (failure) {
      if (!valid(stamp)) return;
      if (submitted && isFinalReportRejection(failure)) {
        try {
          await reportStore.remove(stamp.session.ownerId, submitted.client_report_id);
          if (!valid(stamp)) return;
          intentRef.current = null; setIntent(null); setPending(null); setReason(''); setOutcome(failure instanceof SocialError && failure.status === 403 ? 'rejected' : 'expired'); setStage('done'); setError(socialErrorCode(failure));
        } catch (storageFailure) { if (valid(stamp)) { setStage('recover'); setError(socialErrorCode(storageFailure)); } }
      } else { setStage('recover'); setError(socialErrorCode(failure)); }
    }
    finally { if (valid(stamp)) { locked.current = false; setBusy(false); } }
  };
  // The focus event runs the owner-scoped restore, never automatically resubmits it.
  const restoreRef = useRef(restore); useLayoutEffect(() => { restoreRef.current = restore; });
  const { subscribeReset } = social;
  useFocusEffect(useCallback(() => {
    gate.current.enter(); clear(); void restoreRef.current();
    const unsubscribe = subscribeReset(clear);
    return () => { gate.current.leave(); unsubscribe(); clear(); };
  }, [clear, subscribeReset]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') clear(); else void restoreRef.current(); });
    return () => subscription.remove();
  }, [clear]);
  return { reason, setReason, evidence, setEvidence, intent, pending, stage, error, busy, outcome, restore, prepare, submit,
    edit: () => { if (stage === 'confirm') { intentRef.current = null; setIntent(null); setStage('edit'); } } };
}
