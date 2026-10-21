import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Switch, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowLeft, ChevronRight, type LucideIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Input, Type, useDesign } from '../design';
import { useQAccount } from '../account/account-state';
import type { SocialUser } from './api';
import { socialErrorCode, useSocial } from './state';
import { usePendingReportMeta, useReport } from './use-report';
import type { ReportMeta } from './report-core';

export function SocialButton({ label, onPress, icon: Icon, disabled = false, quiet = false, danger = false }: {
  label: string; onPress: () => void; icon?: LucideIcon; disabled?: boolean; quiet?: boolean; danger?: boolean;
}) {
  const { colors } = useDesign();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      backgroundColor: quiet ? colors.soft : colors.accent, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
    {Icon ? <Icon size={18} color={quiet ? (danger ? colors.danger : colors.ink) : colors.onAccent} /> : null}
    <Type size={14} weight="500" color={quiet ? (danger ? colors.danger : colors.ink) : colors.onAccent}>{label}</Type>
  </Pressable>;
}
export function SocialScreen({ title, children, right, keyboard = false }: { title: string; children: ReactNode; right?: ReactNode; keyboard?: boolean }) {
  const { colors, text } = useDesign(), insets = useSafeAreaInsets(), router = useRouter();
  const body = <View style={{ flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: insets.top, minHeight: insets.top + 60, gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={text('返回', 'Back')} onPress={() => router.canGoBack() ? router.back() : router.replace('/')}
        style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}><ArrowLeft size={22} color={colors.ink} /></Pressable>
      <Type header size={19} weight="500" style={{ flex: 1 }}>{title}</Type>{right}
    </View>{children}
  </View>;
  return keyboard ? <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : 'height'}>{body}</KeyboardAvoidingView>
    : <View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>{body}</View>;
}
export function SocialScroll({ children }: { children: ReactNode }) {
  return <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 32 }}>{children}</ScrollView>;
}
export function Avatar({ user, size = 46 }: { user: SocialUser; size?: number }) {
  const { colors } = useDesign();
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size * 0.34, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentBg }}>
    <Type color={colors.accent} size={size * 0.4} weight="500">{Array.from(user.display_name || user.handle)[0]}</Type>
  </View>;
}
export function PersonRow({ user, title, detail, onPress, trailing }: { user: SocialUser; title?: string; detail?: string; onPress: () => void; trailing?: ReactNode }) {
  const { colors } = useDesign();
  return <Pressable accessibilityRole="button" accessibilityLabel={[title || user.display_name, detail].filter(Boolean).join('，')} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, opacity: pressed ? 0.6 : 1 })}>
    <Avatar user={user} /><View style={{ flex: 1, gap: 3 }}><Type weight="500">{title || user.display_name}</Type>{detail ? <Type muted size={12} numberOfLines={2}>{detail}</Type> : null}</View>
    {trailing ?? <ChevronRight size={18} color={colors.faint} />}
  </Pressable>;
}
export function Loading() { const { colors } = useDesign(); return <ActivityIndicator color={colors.accent} style={{ padding: 14 }} />; }

const errors: Record<string, [string, string]> = {
  NETWORK_ERROR: ['连接失败，请检查网络后重试。', 'Connection failed. Check your network and retry.'],
  REQUEST_TIMEOUT: ['请求超时。发送结果可能未知，请用原消息重试。', 'The request timed out. Retry the original message to confirm its outcome.'],
  UNAUTHORIZED: ['请先登录Q账号。', 'Sign in to your Q account.'],
  INVALID_RESPONSE: ['服务返回了无法识别的数据，请稍后重试。', 'The service returned an invalid response. Try again later.'],
  SOCIAL_UNAVAILABLE: ['当前服务尚未提供好友与消息功能，请更新服务后重新连接。', 'Friends and messages are not available from this service yet. Update the service, then reconnect.'],
  SOCIAL_ACCOUNT_UNAVAILABLE: ['对方账号当前不可用，不能继续此操作；已有历史仍可查看。', 'This account is unavailable for new interactions. Existing history remains available.'],
  ACCOUNT_DELETED: ['该账号已删除，请核查原请求的结果。', 'This account was deleted. Check the original request outcome.'],
  CONTENT_BLOCKED: ['这条内容未通过基础安全检查，请修改后再发送。', 'This content did not pass the basic safety check. Edit it before sending again.'],
  LOCAL_PENDING_LIMIT: ['本机待确认记录已满，请先核查现有记录。', 'Local recovery storage is full. Resolve existing pending records first.'],
  INSECURE_API_URL: ['当前服务地址不可安全连接。', 'The configured service address is not secure.'],
  INVALID_HANDLE: ['Q号为3–24位小写字母、数字或下划线。', 'Q handles use 3–24 letters, numbers or underscores.'],
  INVALID_MESSAGE: ['请输入1–2000字的消息。', 'Enter a message of 1–2000 characters.'],
  USER_NOT_FOUND: ['没有找到这个Q号。', 'No account has this Q handle.'],
  SOCIAL_NOT_FOUND: ['此记录不存在或你无权查看。', 'This record is unavailable.'],
  SOCIAL_FORBIDDEN: ['当前操作不可用。', 'This action is not available.'],
  SOCIAL_BLOCKED: ['当前关系不允许此操作。', 'This action is unavailable for this relationship.'],
  SOCIAL_FRIEND_REQUIRED: ['双方成为好友后才可以聊天。', 'Become friends before starting a conversation.'],
  SOCIAL_ALREADY_FRIENDS: ['你们已经是好友。', 'You are already friends.'],
  SOCIAL_REQUEST_PENDING: ['已有待处理的好友申请。', 'A friend request is already pending.'],
  SOCIAL_REQUEST_CLOSED: ['申请已处理，请刷新列表。', 'This request has been handled. Refresh the list.'],
  SOCIAL_LABEL_PENDING: ['已有待确认的关系邀请。', 'A relationship invitation is already pending.'],
  SOCIAL_CAPACITY: ['已达到当前容量上限。', 'The current capacity limit has been reached.'],
  SOCIAL_MESSAGE_EXPIRED: ['消息已到期，正文不可恢复。', 'This message has expired. Its content is unavailable.'],
  MESSAGE_EXPIRED: ['消息已到期，正文不可恢复。', 'This message has expired. Its content is unavailable.'],
  SOCIAL_REPORT_EXPIRED: ['这次举报已过保留期，不能延长原举报。', 'This report has reached the end of its retention period.'],
  IDEMPOTENCY_CONFLICT: ['原请求与重试内容不一致，请先核查结果。', 'The retry does not match the original request. Check its result first.'],
  RATE_LIMITED: ['操作较频繁，请稍后再试。', 'Too many requests. Try again shortly.'],
  STORAGE_ERROR: ['无法安全保存待确认消息，请稍后重试。', 'The pending message could not be stored safely. Try again later.'],
  PENDING_SEND_EXISTS: ['请先处理上一条待确认消息。', 'Resolve the previous pending message first.'],
  SEND_NOT_CONFIRMED: ['服务器尚未找到这条消息，可以用原内容重试。', 'The server has not found this message. Retry its original content.'],
  EPHEMERAL_NOT_SENT: ['服务器尚未找到这条消息；正文已从本机清除。', 'This message was not found; its local content has been cleared.'],
  EPHEMERAL_BODY_CLEARED: ['正文已清除，请先核查原发送结果。', 'The content was cleared. Check the original send result first.'],
  VALIDATION_ERROR: ['请检查输入内容。', 'Check the entered information.'],
  INVALID_REPORT_REASON: ['请输入1–500字的举报原因。', 'Enter a report reason of 1–500 characters.'],
  PENDING_REPORT_EXISTS: ['请先处理上一条待确认举报，避免重复提交。', 'Resolve the pending report before creating another one.'],
  REPORT_NOT_CONFIRMED: ['尚未查到举报结果。保留原举报，核查或按原内容重试。', 'The report result is not yet available. Check again or retry the original report.'],
  REPORT_REASON_MISMATCH: ['请填写与上次完全一致的举报原因，才能重试原举报。', 'Enter the exact original reason to retry this report.'],
};
export function ErrorNotice({ code }: { code: string }) {
  const { colors, text } = useDesign();
  if (!code || code === 'CANCELLED') return null;
  const copy = errors[code] ?? ['暂时无法完成，请稍后重试。', 'This action could not be completed. Please retry.'];
  return <View accessibilityLiveRegion="polite"><Type color={colors.danger} size={13}>{text(copy[0], copy[1])}</Type></View>;
}
export function AccountGate({ children }: { children: ReactNode }) {
  const account = useQAccount(), { text } = useDesign();
  if (account.loading) return <Loading />;
  if (!account.session) return <SocialScroll><Type header size={22} weight="500">{text('和朋友聊聊', 'Stay close to your friends')}</Type><Type muted>{text('登录同一个Q账号，管理好友和私人对话。', 'Use your Q account for friends and private conversations.')}</Type><ErrorNotice code={account.error} /><SocialButton label={text('登录 / 注册', 'Sign in / Create account')} onPress={account.requestAuth} /></SocialScroll>;
  return children;
}

export function useSocialOperation() {
  const social = useSocial(), service = useRef(social);
  const { subscribeReset } = social;
  useLayoutEffect(() => { service.current = social; }, [social]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const version = useRef(0), lock = useRef(false), focused = useRef(false);
  const reset = useCallback(() => { version.current++; lock.current = false; setBusy(false); setError(''); }, []);
  useFocusEffect(useCallback(() => { focused.current = true; reset(); return () => { focused.current = false; reset(); }; }, [reset]));
  useEffect(() => subscribeReset(reset), [subscribeReset, reset]);
  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (lock.current || !focused.current) return false;
    const ticket = service.current.stamp(), epoch = version.current;
    lock.current = true; setBusy(true); setError('');
    const valid = () => focused.current && version.current === epoch && service.current.current(ticket);
    try { await operation(); if (!valid()) return false; void service.current.refresh(); return true; }
    catch (failure) { if (valid()) setError(socialErrorCode(failure)); return false; }
    finally { if (valid()) { lock.current = false; setBusy(false); } }
  };
  return { busy, error, setError, run };
}

export function ReportForm({ userId, messageId = null, evidenceAvailable = true, onClose }: { userId: string; messageId?: string | null; evidenceAvailable?: boolean; onClose: () => void }) {
  const { text, colors } = useDesign(), social = useSocial(), report = useReport(userId, messageId);
  const { subscribeReset } = social;
  useEffect(() => subscribeReset(onClose), [onClose, subscribeReset]);
  const targetId = report.pending?.userId ?? userId;
  const targetName = social.metadata?.friends.find(item => item.user.id === targetId)?.user.display_name
    ?? social.metadata?.conversations.find(item => item.user.id === targetId)?.user.display_name;
  const includesEvidence = report.pending?.includeEvidence ?? report.intent?.include_evidence ?? false;
  return <View style={{ backgroundColor: colors.soft, padding: 18, borderRadius: 18, gap: 14 }}>
    <Type header size={17} weight="500">{report.stage === 'recover' ? text('继续待确认举报', 'Resume pending report') : text('举报', 'Report')}{targetName ? ` · ${targetName}` : ''}</Type>
    <Type muted size={12}>{text('举报原因与记录保留30天。只有你明确同意，才提交仍可用的消息正文作为独立证据，证据同样保留30天。', 'Report details are retained for 30 days. Available message content is copied into separate evidence only with your explicit consent, also for 30 days.')}</Type>
    {report.stage === 'loading' ? <Loading /> : null}
    {report.stage === 'done' ? <Type>{report.outcome === 'accepted' ? text('举报已提交。', 'Report submitted.') : report.outcome === 'rejected' ? text('服务未接受这次举报，未创建新的举报或改变证据授权。', 'The service rejected this report. No new report was created and evidence consent was not changed.') : text('原举报已过期或不可用，未重新创建举报。', 'The original report has expired or is unavailable. No new report was created.')}</Type> : null}
    {report.stage === 'edit' ? <>
      <Input label={text('举报原因', 'Reason')} value={report.reason} onChangeText={report.setReason} maxLength={1000} multiline />
      {messageId ? <View style={{ minHeight: 48, flexDirection: 'row', gap: 12, alignItems: 'center' }}><Type size={13} style={{ flex: 1 }}>{text('同意提交正文，独立保留30天', 'Include content as evidence for 30 days')}</Type><Switch accessibilityLabel={text('同意将消息正文作为独立证据保留30天', 'Consent to retain message content as separate evidence for 30 days')} disabled={!evidenceAvailable && !report.evidence} value={report.evidence} onValueChange={report.setEvidence} /></View> : null}
      {messageId && !evidenceAvailable ? <Type muted size={12}>{text('正文尚未开封或已不可用；仍可不附正文举报。', 'The content is unopened or unavailable. You can still report without content evidence.')}</Type> : null}
      <SocialButton label={text('继续', 'Continue')} disabled={!report.reason.trim() || (report.evidence && !evidenceAvailable)} onPress={report.prepare} />
    </> : null}
    {report.stage === 'confirm' && report.intent ? <><Type>{report.intent.reason}</Type><Type muted size={13}>{includesEvidence ? text('将提交消息正文证据，独立保留30天。', 'Message content will be retained separately as evidence for 30 days.') : text('不提交消息正文。', 'No message content will be included.')}</Type>
      <SocialButton label={text('确认提交举报', 'Confirm report')} disabled={report.busy} onPress={() => void report.submit()} /><SocialButton quiet label={text('返回修改', 'Edit report')} disabled={report.busy} onPress={report.edit} />
    </> : null}
    {report.stage === 'recover' ? <>
      <Type muted size={12}>{text('保留的是上一次举报。关闭页面或切换账号不会丢失原编号；核查不会提交新的举报。', 'This is the original pending report. Leaving the page or switching accounts keeps its original ID. Checking its result does not submit another report.')}</Type>
      {report.pending ? <><Input label={text('原举报原因（必须一致）', 'Original reason (must match)')} value={report.reason} onChangeText={report.setReason} maxLength={1000} multiline editable={!report.busy} />
        <Type muted size={12}>{includesEvidence ? text('原授权：提交仍可用的正文证据，独立保留30天。', 'Original consent: include available content as evidence for 30 days.') : text('原授权：不提交消息正文。', 'Original consent: no message content.')}</Type></> : null}
      {report.pending || report.intent ? <SocialButton label={text('重试原举报', 'Retry original report')} disabled={report.busy || (report.pending !== null && !report.reason.trim())} onPress={() => void report.submit()} /> : null}
      <SocialButton quiet label={text('核查原举报结果', 'Check original report result')} disabled={report.busy} onPress={() => void report.restore()} />
    </> : null}
    <ErrorNotice code={report.error} />
    <SocialButton quiet label={report.stage === 'recover' ? text('稍后处理', 'Continue later') : text('关闭', 'Close')} onPress={onClose} />
  </View>;
}

export function ReportRecoveryPanel() {
  const { text } = useDesign(), pending = usePendingReportMeta(), { subscribeReset } = useSocial();
  const [selected, setSelected] = useState<ReportMeta | null>(null);
  const close = useCallback(() => setSelected(null), []);
  useEffect(() => subscribeReset(close), [close, subscribeReset]);
  if (selected) return <ReportForm userId={selected.userId} messageId={selected.messageId} onClose={close} />;
  return pending ? <SocialButton quiet label={text('继续处理待确认举报', 'Resolve pending report')} onPress={() => setSelected(pending)} /> : null;
}
