import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Send, Timer, TimerOff } from 'lucide-react-native';
import { Type, useDesign } from '../design';
import { canReportEvidence, messageReceipt, remainingMs, type EphemeralSeconds } from './core';
import type { SocialMessage } from './api';
import { useSocial } from './state';
import { useConversation } from './use-conversation';
import { AccountGate, Avatar, ErrorNotice, Loading, ReportForm, SocialButton, SocialScreen } from './components';

export function SocialConversationPage({ conversationId }: { conversationId: string }) {
  const { text, colors } = useDesign(), social = useSocial(), router = useRouter(), chat = useConversation(conversationId);
  const conversation = social.metadata?.conversations.find(item => item.id === conversationId);
  const friend = social.metadata?.friends.find(item => item.conversation_id === conversationId);
  const [reportId, setReportId] = useState<string | null>(null);
  const { subscribeReset } = social;
  const closeReport = useCallback(() => setReportId(null), []);
  const reportedMessage = chat.messages.find(item => item.id === reportId);
  const reportBody = reportId ? chat.opened[reportId] : null;
  const evidenceAvailable = reportedMessage ? canReportEvidence(reportedMessage, !!reportBody && remainingMs(reportBody.deadline, chat.clock.mono, chat.clock.wall) > 0) : false;
  useEffect(() => subscribeReset(closeReport), [closeReport, subscribeReset]);
  useFocusEffect(useCallback(() => () => closeReport(), [closeReport]));
  const listRef = useRef<FlatList<SocialMessage>>(null);
  const positioned = useRef(false);
  useEffect(() => { if (!chat.messages.length) positioned.current = false; }, [chat.messages.length]);
  const { markRead } = chat;
  const viewability = useMemo(() => ({ itemVisiblePercentThreshold: 70, minimumViewTime: 500 }), []);
  const onViewable = useCallback(({ viewableItems }: { viewableItems: { item: SocialMessage; isViewable: boolean }[] }) => {
    const seq = Math.max(0, ...viewableItems.filter(item => item.isViewable).map(item => item.item.seq));
    if (seq > 0) void markRead(seq);
  }, [markRead]);
  const durationText = (seconds: EphemeralSeconds | null) => seconds === null ? text('普通', 'Normal') : seconds === 30 ? text('30秒', '30 sec') : seconds === 300 ? text('5分钟', '5 min') : text('24小时', '24 hr');
  const messageRow = ({ item }: { item: SocialMessage }) => {
    const mine = item.sender_id === social.ownerId, body = chat.opened[item.id];
    const remaining = body ? remainingMs(body.deadline, chat.clock.mono, chat.clock.wall) : 0;
    const visibleBody = conversation?.active && body && remaining > 0 ? body.body : null;
    const report = () => { if (!mine) setReportId(item.id); };
    const ephemeral = item.kind === 'ephemeral';
    return <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', paddingVertical: 7, gap: 3 }}>
      <Pressable onLongPress={report} accessibilityRole={ephemeral && !mine && !item.expired ? 'button' : 'text'}
        accessibilityLabel={ephemeral ? item.expired ? text('阅后消息已到期', 'Ephemeral message expired') : visibleBody ?? `${text('阅后消息，', 'Ephemeral message, ')}${durationText(item.ttl_seconds)}` : item.body ?? ''}
        accessibilityHint={!mine ? text('长按可举报此消息', 'Long press to report this message') : undefined}
        accessibilityActions={!mine ? [{ name: 'report', label: text('举报消息', 'Report message') }] : undefined}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'report') report(); }}
        onPress={ephemeral && !mine && !item.expired && !visibleBody && conversation?.active ? () => void chat.open(item) : undefined}
        style={{ minHeight: 48, maxWidth: '88%', paddingHorizontal: 15, paddingVertical: 12, borderRadius: 17, borderTopLeftRadius: mine ? 17 : 4, borderTopRightRadius: mine ? 4 : 17, backgroundColor: mine ? colors.accentBg : colors.soft, gap: 6 }}>
        {ephemeral ? <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>{item.expired ? <TimerOff size={17} color={colors.muted} /> : <Timer size={17} color={colors.accent} />}<Type size={13} muted={item.expired}>{item.expired ? text('消息已到期', 'Message expired') : `${text('阅后', 'Disappears after ')}${durationText(item.ttl_seconds)}`}</Type></View>
          {visibleBody ? <><Type selectable={false}>{visibleBody}</Type><Type size={11} muted>{text('剩余', 'Remaining')} {Math.ceil(remaining / 1000)} {text('秒 · 到期后清除', 'sec · clears on expiry')}</Type></>
            : !item.expired ? <Type size={12} muted>{mine ? text('已发送 · 正文不保留在发送记录中', 'Sent · content is not retained in sent history') : !conversation?.active ? text('当前关系不可开封', 'Opening unavailable for this relationship') : item.expires_at ? text('计时中 · 联网查看', 'Timer running · view online') : text('联网点开 · 开始计时', 'Open online to start the timer')}</Type> : null}
        </> : <Type selectable={false}>{item.body}</Type>}
      </Pressable>
      {mine ? <Type muted size={11}>{{ expired: text('已到期', 'Expired'), opened: text('已开封', 'Opened'), unopened: text('未开封', 'Unopened'), read: text('已读', 'Read'), sent: text('已发送', 'Sent') }[messageReceipt(item, conversation?.peer_read_seq ?? 0)]}</Type> : null}
    </View>;
  };
  return <SocialScreen title={friend?.remark || conversation?.user.display_name || text('私聊', 'Conversation')} keyboard>
    <AccountGate>
      {conversation ? <Pressable accessibilityRole="button" accessibilityLabel={text('查看好友与关系', 'View friend and relationship')} onPress={() => router.push({ pathname: '/social/friend', params: { id: conversation.user.id } })}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 20, paddingVertical: 8 }}>
        <Avatar user={conversation.user} size={38} /><View style={{ flex: 1 }}><Type size={14}>{friend?.remark || conversation.user.display_name}</Type><Type muted size={12}>{friend?.intimacy_enabled && friend.peer_intimacy_enabled ? `${friend.intimacy_score} ${text('个双向互动日', 'mutual interaction days')}` : `@${conversation.user.handle}`}</Type></View>
      </Pressable> : null}
      <FlatList ref={listRef} data={chat.messages} keyExtractor={item => item.id} renderItem={messageRow} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 18, flexGrow: 1 }}
        onContentSizeChange={() => { if (chat.messages.length && !positioned.current) { positioned.current = true; listRef.current?.scrollToEnd({ animated: false }); } }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListHeaderComponent={chat.hasMore ? <SocialButton quiet label={text('加载更早消息', 'Load earlier messages')} disabled={chat.loading} onPress={() => void chat.loadOlder()} /> : undefined}
        onViewableItemsChanged={onViewable} viewabilityConfig={viewability}
        ListEmptyComponent={chat.loading ? <Loading /> : <View style={{ paddingVertical: 38, gap: 10 }}><Type muted>{text('从一句问候开始。', 'Start with a hello.')}</Type></View>}
        ListFooterComponent={<View style={{ gap: 12, paddingTop: 8 }}>
          <ErrorNotice code={chat.error} />
          {chat.error && !chat.pending ? <SocialButton quiet label={text('重新连接', 'Reconnect')} onPress={() => { void chat.sync(); void social.refresh(); }} /> : null}
          {chat.pending ? <View style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: colors.soft }}><Type size={13}>{text('上一条消息等待确认，请先核查结果。', 'The previous message is pending. Confirm its result first.')}</Type>
            {chat.pending.text !== null ? <SocialButton label={text('重试原消息', 'Retry original message')} disabled={chat.busy} onPress={() => void chat.send(true)} /> : null}
            <SocialButton quiet label={text('核查发送结果', 'Check send result')} disabled={chat.busy} onPress={() => void chat.recover()} />
            {chat.pending.text === null ? <><Type muted size={12}>{text('停止本机恢复后，原消息仍可能送达；不会撤回或自动重发。', 'Stopping local recovery does not cancel the original delivery or resend it. The message may still arrive.')}</Type>
              <SocialButton quiet label={text('核查后停止本机恢复', 'Check and stop local recovery')} disabled={chat.busy} onPress={() => void chat.discardUnsent()} /></> : null}
          </View> : null}
          {reportId && conversation ? <ReportForm key={reportId} userId={conversation.user.id} messageId={reportId} evidenceAvailable={evidenceAvailable} onClose={closeReport} /> : null}
        </View>} />
      {conversation?.active ? <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, gap: 8, borderTopWidth: 1, borderColor: colors.line }}>
        <View accessibilityRole="radiogroup" accessibilityLabel={text('这一条消息的保留方式', 'Retention for this message')} style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
          {([null, 30, 300, 86400] as const).map(value => <Pressable key={String(value)} accessibilityRole="radio" accessibilityState={{ checked: chat.seconds === value, disabled: chat.busy }} disabled={chat.busy}
            onPress={() => chat.setSeconds(value)} style={{ minHeight: 48, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: chat.seconds === value ? colors.accentBg : colors.bg }}><Type size={12} color={chat.seconds === value ? colors.accent : colors.muted}>{durationText(value)}</Type></Pressable>)}
        </View>
        {chat.seconds ? <Type muted size={12}>{text('仅这一条：对方联网点开后计时，未开封7天到期。不能保证防截屏。', 'This message only: the timer starts when opened online; unopened content expires after 7 days. Screenshots cannot be prevented.')}</Type> : null}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <TextInput accessibilityLabel={text('消息正文', 'Message')} placeholder={text('发消息', 'Message')} placeholderTextColor={colors.faint} selectionColor={colors.accent} value={chat.draft} onChangeText={chat.setDraft} multiline maxLength={4000} autoCorrect={!chat.seconds} style={{ flex: 1, minHeight: 48, maxHeight: 136, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: colors.ink, backgroundColor: colors.soft, borderRadius: 16, textAlignVertical: 'center' }} />
          <Pressable accessibilityRole="button" accessibilityLabel={text('发送', 'Send')} accessibilityState={{ disabled: chat.busy || !!chat.pending || !chat.draft.trim() }} disabled={chat.busy || !!chat.pending || !chat.draft.trim()} onPress={() => void chat.send()} style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', opacity: chat.busy || chat.pending || !chat.draft.trim() ? 0.4 : 1 }}><Send size={20} color={colors.onAccent} /></Pressable>
        </View>
      </View> : conversation ? <View style={{ padding: 20 }}><Type muted size={13}>{text('这段关系已结束。普通历史消息保留，不能继续发送或开封阅后消息。', 'This relationship has ended. Ordinary history remains, but sending and opening ephemeral messages are unavailable.')}</Type></View> : null}
    </AccountGate>
  </SocialScreen>;
}
