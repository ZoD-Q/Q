import { useCallback, useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { HeartHandshake, MessageCircle } from 'lucide-react-native';
import { Input, Type, useDesign } from '../design';
import { decodeMutation, type RelationshipLabel } from './api';
import { useSocial } from './state';
import { AccountGate, Avatar, ErrorNotice, Loading, ReportForm, SocialButton, SocialScreen, SocialScroll, useSocialOperation } from './components';

export function SocialFriendPage({ userId }: { userId: string }) {
  const { text, colors } = useDesign(), social = useSocial(), router = useRouter(), action = useSocialOperation();
  const friend = social.metadata?.friends.find(item => item.user.id === userId);
  const user = friend?.user ?? social.metadata?.conversations.find(item => item.user.id === userId)?.user
    ?? social.metadata?.requests.flatMap(item => [item.from_user, item.to_user]).find(item => item.id === userId)
    ?? social.metadata?.blocks.find(item => item.id === userId);
  const blocked = social.metadata?.blocks.some(item => item.id === userId) ?? false;
  const { subscribeReset } = social;
  const [remarkDraft, setRemark] = useState<string | null>(null), [confirmation, setConfirmation] = useState<'delete' | 'block' | null>(null), [report, setReport] = useState(false);
  const remark = remarkDraft ?? friend?.remark ?? '';
  const closeReport = useCallback(() => setReport(false), []);
  const reset = useCallback(() => { setRemark(null); setConfirmation(null); setReport(false); }, []);
  useEffect(() => subscribeReset(reset), [reset, subscribeReset]);
  useFocusEffect(useCallback(() => () => reset(), [reset]));
  const labelText = (value: RelationshipLabel) => ({ close_friend: text('密友', 'Close friends'), partner: text('搭档', 'Partners'), couple: text('恋人', 'Couple') })[value];
  return <SocialScreen title={text('好友资料', 'Friend profile')}><AccountGate><SocialScroll>
    {!user && social.loading ? <Loading /> : null}
    {!user && !social.loading ? <><Type muted>{text('当前无法显示此账号资料，请回到好友列表刷新。', 'This profile is unavailable. Refresh your friends list.')}</Type><SocialButton quiet label={text('刷新', 'Refresh')} onPress={() => void social.refresh()} /></> : null}
    {user ? <>
      <View style={{ alignItems: 'center', gap: 9, paddingVertical: 12 }}><Avatar user={user} size={66} /><Type header size={23} weight="500">{friend?.remark || user.display_name}</Type><Type muted size={13}>@{user.handle}</Type></View>
      <ErrorNotice code={social.error || action.error} />
      {friend ? <>
        <SocialButton icon={MessageCircle} label={text('发消息', 'Message')} onPress={() => router.push({ pathname: '/social/conversation', params: { id: friend.conversation_id } })} />
        <View style={{ gap: 12, padding: 18, borderRadius: 18, backgroundColor: colors.soft }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><HeartHandshake size={20} color={colors.accent} /><Type weight="500">{text('我们的关系', 'Our connection')}</Type></View>
          {friend.intimacy_enabled ? <><Type size={22} weight="500">{friend.intimacy_score} {text('个双向互动日', 'mutual interaction days')}</Type><Type muted size={12}>{text('双方开启时，同一天互相发送普通消息记为一天。不分析聊天内容，不要求连续打卡。', 'When both people enable it, exchanging ordinary messages on a UTC day counts once. Content is not analyzed and no streak is required.')}</Type></> : <Type muted>{text('亲密度已关闭', 'Intimacy is turned off')}</Type>}
          {!friend.peer_intimacy_enabled ? <Type muted size={12}>{text('对方已关闭，当前停止累计。', 'The other person has turned it off. No days are accumulating.')}</Type> : null}
          <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}><Type style={{ flex: 1 }}>{text('启用亲密度', 'Enable intimacy')}</Type><Switch accessibilityLabel={text('启用亲密度，关闭后停止累计', 'Enable intimacy; turning it off stops accumulation')} value={friend.intimacy_enabled} disabled={action.busy} onValueChange={value => void action.run(() => social.call(`/v1/social/friends/${userId}`, decodeMutation, 'PATCH', { intimacy_enabled: value }))} /></View>
          <Type muted size={12}>{text('关闭后停止累计；重新开启不会补算。', 'Turning it off stops counting. Re-enabling does not backfill days.')}</Type>
        </View>
        <View style={{ gap: 12 }}><Type header weight="500">{text('关系标签', 'Relationship label')}</Type>
          {friend.relationship_label ? <><Type color={colors.accent}>{labelText(friend.relationship_label)}</Type><SocialButton quiet label={text('解除关系标签', 'Remove relationship label')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}/label`, decodeMutation, 'POST', { label: null }))} /></> : <Type muted size={12}>{text('双方确认后显示，任一方可以解除。', 'Shown after both people agree. Either person can remove it.')}</Type>}
          {friend.proposed_label ? <View style={{ gap: 8 }}><Type>{text('关系邀请：', 'Invitation: ')}{labelText(friend.proposed_label)}</Type>
            {friend.proposed_by !== social.ownerId ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><SocialButton label={text('接受', 'Accept')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}/label/respond`, decodeMutation, 'POST', { accept: true }))} /><SocialButton quiet label={text('拒绝', 'Decline')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}/label/respond`, decodeMutation, 'POST', { accept: false }))} /></View>
              : <><Type muted size={12}>{text('等待对方确认', 'Waiting for confirmation')}</Type><SocialButton quiet label={text('取消邀请', 'Cancel invitation')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}/label`, decodeMutation, 'POST', { label: null }))} /></>}
          </View> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{(['close_friend', 'partner', 'couple'] as const).filter(value => value !== friend.relationship_label).map(value => <SocialButton key={value} quiet label={`${text('邀请成为', 'Invite as ')}${labelText(value)}`} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}/label`, decodeMutation, 'POST', { label: value }))} />)}</View>}
        </View>
        <Input label={text('备注（仅自己可见）', 'Private nickname')} value={remark} onChangeText={setRemark} maxLength={40} />
        <SocialButton quiet label={text('保存备注', 'Save nickname')} disabled={action.busy || remark.trim() === friend.remark} onPress={() => void action.run(() => social.call(`/v1/social/friends/${userId}`, decodeMutation, 'PATCH', { remark: remark.trim() }))} />
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}><View style={{ flex: 1 }}><Type>{text('消息免打扰', 'Mute conversation')}</Type><Type muted size={12}>{text('消息仍会接收，不计入首页未读角标。', 'Messages still arrive but do not add to the home badge.')}</Type></View><Switch accessibilityLabel={text('消息免打扰', 'Mute conversation')} value={friend.muted} disabled={action.busy} onValueChange={value => void action.run(() => social.call(`/v1/social/friends/${userId}`, decodeMutation, 'PATCH', { muted: value }))} /></View>
        <SocialButton quiet danger label={text('删除好友', 'Remove friend')} disabled={action.busy} onPress={() => setConfirmation('delete')} />
      </> : null}
      {confirmation ? <View style={{ padding: 16, borderRadius: 16, backgroundColor: colors.soft, gap: 12 }}><Type>{confirmation === 'block' ? text('拉黑后不能互发消息；普通历史对话保留。解除拉黑不会自动恢复好友。', 'Blocking stops messages. Ordinary history remains. Unblocking does not restore friendship.') : text('删除后不能继续发送消息；普通历史对话保留，亲密记录停止。', 'Removing this friend stops new messages and ends intimacy for this relationship. Ordinary history remains.')}</Type>
        <SocialButton danger label={text('确认', 'Confirm')} disabled={action.busy} onPress={() => void action.run(() => confirmation === 'block' ? social.call('/v1/social/blocks', decodeMutation, 'POST', { user_id: userId }) : social.call(`/v1/social/friends/${userId}`, decodeMutation, 'DELETE')).then(ok => { if (ok) setConfirmation(null); })} /><SocialButton quiet label={text('取消', 'Cancel')} onPress={() => setConfirmation(null)} /></View> : null}
      {blocked ? <SocialButton quiet label={text('解除拉黑', 'Unblock')} disabled={action.busy} onPress={() => void action.run(() => social.call(`/v1/social/blocks/${userId}`, decodeMutation, 'DELETE'))} />
        : <SocialButton quiet danger label={text('拉黑', 'Block')} disabled={action.busy} onPress={() => setConfirmation('block')} />}
      <SocialButton quiet label={text('举报该账号', 'Report account')} onPress={() => setReport(true)} />
      {report ? <ReportForm userId={userId} onClose={closeReport} /> : null}
    </> : null}
  </SocialScroll></AccountGate></SocialScreen>;
}
