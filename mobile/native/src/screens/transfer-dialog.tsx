import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, ScrollView, View, useWindowDimensions } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, Search, X } from 'lucide-react-native';
import type { Recipient, TransferRequest, TransferResponse } from '@xiaoq/shared';
import { useApp } from '@/providers/app-provider';
import { Avatar, Button, IconButton, Input, Notice, Pill, Type } from '@/components/ui';
import { ApiError, errorKey } from '@/services/api';
import { formatAmount, parseAmount } from '@/utils/money';
import { clearPendingTransfer, savePendingTransfer } from '@/services/pending-transfer';
import type { PendingTransfer } from '@/services/pending-transfer-data';
import { canDiscardFailedTransfer } from '@/services/transfer-outcome';

export function TransferDialog({ balance, initialPending, onClose, onComplete }: { balance: number; initialPending: PendingTransfer | null; onClose: () => void; onComplete: () => void }) {
  const { t, colors, user, call } = useApp();
  const { width } = useWindowDimensions();
  const [handle, setHandle] = useState(initialPending?.request.recipient_handle || '');
  const [recipient, setRecipient] = useState<Recipient | null>(initialPending?.recipient || null);
  const [amount, setAmount] = useState(initialPending ? formatAmount(initialPending.request.amount_minor).replaceAll(',', '') : '');
  const [memo, setMemo] = useState(initialPending?.request.memo || '');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [step, setStep] = useState<'edit' | 'confirm' | 'success'>(initialPending ? 'confirm' : 'edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialPending ? t.resumeTransfer : '');
  const [uncertain, setUncertain] = useState(!!initialPending);
  const [result, setResult] = useState<TransferResponse | null>(null);
  const [pending, setPending] = useState<TransferRequest | null>(initialPending?.request || null);
  const persisted = useRef(!!initialPending);
  const lookupVersion = useRef(0);
  const submitGuard = useRef(false);
  const lookup = async () => {
    const normalized = handle.trim().toLowerCase();
    const version = ++lookupVersion.current;
    if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return setError(t.invalidHandle);
    if (normalized === user!.handle) return setError(t.selfTransfer);
    setLookupBusy(true); setError(''); setRecipient(null);
    try {
      const found = await call<Recipient>(`/v1/users/lookup?handle=${encodeURIComponent(normalized)}`);
      if (lookupVersion.current === version) setRecipient(found);
    } catch (err) { if (lookupVersion.current === version) setError(t[errorKey(err)]); }
    finally { if (lookupVersion.current === version) setLookupBusy(false); }
  };
  const review = () => {
    if (!recipient || recipient.handle !== handle.trim().toLowerCase()) return setError(t.requiredRecipient);
    const minor = parseAmount(amount);
    if (minor === null) return setError(t.invalidAmount);
    if (minor > balance) return setError(t.insufficient);
    if (Array.from(memo).length > 80) return setError(t.invalidMemo);
    setPending({ recipient_handle: recipient.handle, amount_minor: minor, memo: memo.trim(), idempotency_key: randomUUID() });
    setError(''); setUncertain(false); setStep('confirm');
  };
  const send = async () => {
    if (submitGuard.current || !pending || !recipient) return;
    submitGuard.current = true; setBusy(true); setError('');
    let dispatched = false;
    try {
      if (!persisted.current) {
        await savePendingTransfer({ sender_id: user!.id, request: pending, recipient });
        persisted.current = true;
      }
      dispatched = true;
      const response = await call<TransferResponse>('/v1/wallet/transfers', 'POST', pending);
      // A cleanup failure leaves the old key recoverable; it never authorizes a new intent.
      await clearPendingTransfer(user!.id, pending.idempotency_key).catch(() => undefined);
      setResult(response); setUncertain(false); setStep('success'); onComplete();
    } catch (err) {
      // Never replace the key after an ambiguous failure: retry the exact request.
      if (!dispatched) { setError(uncertain ? t.uncertain : t.recoveryWriteError); return; }
      let ambiguous = !(err instanceof ApiError && canDiscardFailedTransfer(err.code, err.status, uncertain));
      if (!ambiguous) {
        try { await clearPendingTransfer(user!.id, pending.idempotency_key); persisted.current = false; }
        catch { ambiguous = true; }
      }
      setUncertain(ambiguous); setError(ambiguous ? t.uncertain : t[errorKey(err)]);
    } finally { submitGuard.current = false; setBusy(false); }
  };
  const close = () => { if (!busy && !uncertain) onClose(); };
  const minor = pending?.amount_minor ?? 0;
  return <Modal visible transparent animationType={process.env.EXPO_OS === 'web' ? 'none' : 'fade'} onRequestClose={close} statusBarTranslucent>
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: '#00000066' }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: width < 500 ? 16 : 32 }}>
        <View accessibilityViewIsModal style={{ width: '100%', maxWidth: 470, backgroundColor: colors.surface, padding: width < 500 ? 23 : 32, borderRadius: 25, gap: 23, boxShadow: '0 20px 80px #00000025' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Pill tone="accent">{t.demoOnly}</Pill>{!busy && !uncertain ? <IconButton label={t.cancel} icon={X} onPress={close} /> : null}</View>
          {step === 'success' ? <>
            <View style={{ width: 66, height: 66, borderRadius: 33, backgroundColor: colors.successSoft, justifyContent: 'center', alignItems: 'center', alignSelf: 'center' }}><CheckCheck size={31} color={colors.success} /></View>
            <View style={{ gap: 9, alignItems: 'center' }}><Type size={26} weight="500">{t.transferSuccess}</Type><Type muted style={{ textAlign: 'center' }}>{t.transferSuccessSub}</Type><Type size={40} weight="500" style={{ marginTop: 7, fontVariant: ['tabular-nums'] }}>{formatAmount(minor)} Q</Type><Type muted>{t.to} {recipient?.display_name} · @{recipient?.handle}</Type></View>
            <View style={{ padding: 14, borderRadius: 12, backgroundColor: colors.subtle, gap: 5 }}><Type muted size={11}>{t.reference}</Type><Type selectable size={11}>{result?.transfer_id}</Type></View>
            <Button label={t.done} onPress={onClose} />
          </> : step === 'edit' ? <>
            <View style={{ gap: 7 }}><Type size={26} weight="500">{t.transferTitle}</Type><Type muted size={13}>{t.transferSub}</Type></View>
            <View style={{ gap: 11 }}><Input label={t.recipient} placeholder={t.recipientPlaceholder} value={handle} onChangeText={value => { lookupVersion.current++; setLookupBusy(false); setHandle(value); setRecipient(null); setError(''); }} autoCapitalize="none" autoCorrect={false} maxLength={24} onSubmitEditing={() => void lookup()} /><Button label={lookupBusy ? t.lookupBusy : t.lookup} icon={Search} variant="secondary" loading={lookupBusy} onPress={() => void lookup()} />
              {recipient ? <View style={{ flexDirection: 'row', gap: 11, backgroundColor: colors.successSoft, borderRadius: 12, padding: 12, alignItems: 'center' }}><Avatar name={recipient.avatar} size={38} /><View style={{ flex: 1 }}><Type size={13} weight="600">{recipient.display_name}</Type><Type size={11} muted>@{recipient.handle}</Type></View><Check size={17} color={colors.success} /></View> : null}
            </View>
            <Input label={`${t.amount} · Q`} value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" inputMode="decimal" maxLength={11} style={{ fontSize: 27, fontVariant: ['tabular-nums'] }} hint={`${t.available} ${formatAmount(balance)} Q · ${t.amountHint}`} />
            <Input label={t.note} placeholder={t.memoPlaceholder} value={memo} onChangeText={setMemo} maxLength={80} />
            {error ? <Notice text={error} /> : null}
            <Button label={t.next} icon={ArrowRight} onPress={review} />
          </> : <>
            <View style={{ gap: 7 }}><Type size={27} weight="500">{t.confirmTitle}</Type><Type muted>{t.confirmSub}</Type></View>
            <View style={{ alignItems: 'center', gap: 14, paddingVertical: 12 }}><Avatar name={recipient?.avatar} size={60} selected /><View style={{ alignItems: 'center' }}><Type size={19} weight="600">{recipient?.display_name}</Type><Type muted>@{recipient?.handle}</Type></View><Type size={43} weight="500" style={{ fontVariant: ['tabular-nums'] }}>{formatAmount(minor)} Q</Type>{memo.trim() ? <Type muted selectable>{memo.trim()}</Type> : null}</View>
            {error ? <Notice text={error} /> : null}
            <Button label={busy ? t.sending : error ? t.retry : t.confirm} icon={ArrowUpRight} loading={busy} onPress={() => void send()} />
            {!uncertain ? <Button label={t.back} variant="ghost" disabled={busy} onPress={() => { setPending(null); setError(''); setStep('edit'); }} /> : null}
          </>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </Modal>;
}
