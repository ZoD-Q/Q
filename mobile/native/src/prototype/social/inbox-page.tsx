import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, UserPlus } from 'lucide-react-native';
import { Type, useDesign } from '../design';
import { decodeMutation, type SocialNotification } from './api';
import { useSocial } from './state';
import { AccountGate, ErrorNotice, Loading, PersonRow, ReportRecoveryPanel, SocialButton, SocialScreen, SocialScroll, useSocialOperation } from './components';

export function SocialInboxPage() {
  const { text, colors } = useDesign(), social = useSocial(), router = useRouter(), action = useSocialOperation();
  const [tab, setTab] = useState<'messages' | 'friends' | 'notices'>('messages'), [showBlocks, setShowBlocks] = useState(false);
  const metadata = social.metadata;
  const notificationCopy = (item: SocialNotification) => ({
    friend_request: text('申请添加你为好友', 'Sent you a friend request'), friend_accepted: text('接受了好友申请', 'Accepted your friend request'),
    relationship_proposed: text('邀请你确认关系标签', 'Invited you to confirm a relationship label'), relationship_accepted: text('接受了关系标签', 'Accepted your relationship label'),
  })[item.kind];
  return <SocialScreen title={text('消息', 'Messages')} right={<Pressable accessibilityRole="button" accessibilityLabel={text('添加好友', 'Add friend')} onPress={() => router.push('/social/add')} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}><UserPlus size={21} color={colors.ink} /></Pressable>}>
    <AccountGate><SocialScroll>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 4, backgroundColor: colors.soft, padding: 4, borderRadius: 16 }}>
        {(['messages', 'friends', 'notices'] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }}
          onPress={() => setTab(item)} style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: tab === item ? colors.surface : 'transparent', borderRadius: 12 }}>
          <Type weight={tab === item ? '500' : '400'} muted={tab !== item}>{item === 'messages' ? text('消息', 'Chats') : item === 'friends' ? text('好友', 'Friends') : text('通知', 'Activity')}</Type>
        </Pressable>)}
      </View>
      <ErrorNotice code={social.error || action.error} />
      {social.loading && !metadata ? <Loading /> : null}
      {social.error ? <SocialButton quiet label={text('重新连接', 'Reconnect')} onPress={() => void social.refresh()} /> : null}
      {tab === 'messages' ? <View>
        {metadata?.conversations.map(conversation => {
          const friend = metadata.friends.find(item => item.conversation_id === conversation.id);
          const preview = !conversation.active ? text('历史对话 · 当前不可发送', 'History · sending unavailable')
            : conversation.last_message?.kind === 'ephemeral' ? text('阅后消息', 'Ephemeral message')
              : conversation.last_message ? conversation.last_message.preview || text('文字消息', 'Text message') : text('开始对话', 'Start a conversation');
          return <PersonRow key={conversation.id} user={conversation.user} title={friend?.remark || undefined} detail={`${friend?.muted ? text('免打扰 · ', 'Muted · ') : ''}${preview}`} onPress={() => router.push({ pathname: '/social/conversation', params: { id: conversation.id } })}
            trailing={conversation.unread_count > 0 ? <View style={{ borderRadius: 12, minWidth: 24, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: friend?.muted ? colors.soft : colors.accent }}><Type size={12} color={friend?.muted ? colors.muted : colors.onAccent}>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</Type></View> : undefined} />;
        })}
        {metadata && metadata.conversations.length === 0 ? <View style={{ gap: 18, paddingVertical: 40 }}><Type header size={22} weight="500">{text('从一个朋友开始', 'Start with a friend')}</Type><Type muted>{text('添加好友后，在这里开始私人对话。', 'Add a friend to start a private conversation here.')}</Type><SocialButton label={text('添加好友', 'Add friend')} onPress={() => router.push('/social/add')} /></View> : null}
      </View> : null}
      {tab === 'friends' ? <View style={{ gap: 18 }}>
        <Type header weight="500">{text('新的朋友', 'Friend requests')}</Type>
        {metadata?.requests.map(request => {
          const incoming = request.to_user.id === social.ownerId, user = incoming ? request.from_user : request.to_user;
          return <View key={request.id} style={{ paddingBottom: 14, borderBottomWidth: 1, borderColor: colors.line, gap: 10 }}>
            <PersonRow user={user} detail={request.note || (incoming ? text('请求添加好友', 'Wants to add you') : text('等待对方确认', 'Waiting for confirmation'))} onPress={() => router.push({ pathname: '/social/friend', params: { id: user.id } })} />
            {incoming ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><SocialButton label={text('接受', 'Accept')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/requests/${request.id}/respond`, decodeMutation, 'POST', { accept: true }))} /><SocialButton quiet label={text('拒绝', 'Decline')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/requests/${request.id}/respond`, decodeMutation, 'POST', { accept: false }))} /></View> : null}
          </View>;
        })}
        {metadata?.requests.length === 0 ? <Type muted size={13}>{text('暂无好友申请', 'No pending requests')}</Type> : null}
        <SocialButton quiet icon={UserPlus} label={text('添加好友', 'Add friend')} onPress={() => router.push('/social/add')} />
        <Type header weight="500">{text('我的好友', 'My friends')}{metadata ? ` · ${metadata.friends.length}` : ''}</Type>
        {metadata?.friends.map(friend => <PersonRow key={friend.user.id} user={friend.user} title={friend.remark || undefined} detail={`@${friend.user.handle}`} onPress={() => router.push({ pathname: '/social/friend', params: { id: friend.user.id } })} />)}
        <SocialButton quiet label={`${text('已拉黑', 'Blocked accounts')} · ${metadata?.blocks.length ?? 0}`} onPress={() => setShowBlocks(value => !value)} />
        {showBlocks ? metadata?.blocks.map(user => <View key={user.id} style={{ gap: 8 }}><Type>{user.display_name} · @{user.handle}</Type><SocialButton quiet label={text('解除拉黑', 'Unblock')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/blocks/${user.id}`, decodeMutation, 'DELETE'))} /></View>) : null}
      </View> : null}
      {tab === 'notices' ? <View style={{ gap: 12 }}>
        <ReportRecoveryPanel />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Bell color={colors.muted} size={18} /><Type muted size={13}>{text('好友与关系提醒', 'Friend and relationship activity')}</Type></View>
        {metadata?.notifications.map(item => <PersonRow key={item.id} user={item.user} detail={notificationCopy(item)} trailing={!item.read_at ? <Type color={colors.accent} size={12}>{text('未读', 'New')}</Type> : undefined}
          onPress={() => { void action.run(() => social.call(`/v1/social/notifications/${item.id}/read`, decodeMutation, 'POST', {})); if (item.kind === 'friend_request') setTab('friends'); else router.push({ pathname: '/social/friend', params: { id: item.user.id } }); }} />)}
        {metadata?.notifications.length === 0 ? <Type muted>{text('暂无新通知', 'No recent activity')}</Type> : null}
        <Type muted size={12}>{text('应用在前台时更新消息；暂不支持系统离线推送。', 'Messages update while the app is open. Offline system push is not available yet.')}</Type>
      </View> : null}
    </SocialScroll></AccountGate>
  </SocialScreen>;
}
