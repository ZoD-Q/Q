import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { Copy, Share2 } from 'lucide-react-native';
import { Input, Type, useDesign } from '../design';
import { useQAccount } from '../account/account-state';
import { InviteQr } from '../account/invite-qr';
import { decodeRequest, decodeSocialUser, type SocialUser } from './api';
import { normalizeHandle } from './core';
import { useSocial } from './state';
import { AccountGate, Avatar, ErrorNotice, SocialButton, SocialScreen, SocialScroll, useSocialOperation } from './components';

export function SocialAddFriendPage({ initialHandle = '' }: { initialHandle?: string }) {
  const { text, notify } = useDesign(), social = useSocial(), account = useQAccount(), router = useRouter(), action = useSocialOperation();
  const { subscribeReset } = social;
  const [handleDraft, setHandleDraft] = useState({ source: initialHandle, value: initialHandle.slice(0, 24) }), [note, setNote] = useState(''), [found, setFound] = useState<SocialUser | null>(null), [sent, setSent] = useState(false);
  const handle = handleDraft.source === initialHandle ? handleDraft.value : initialHandle.slice(0, 24);
  const setHandle = useCallback((value: string) => setHandleDraft({ source: initialHandle, value }), [initialHandle]);
  const reset = useCallback(() => { setFound(null); setNote(''); setSent(false); }, []);
  useEffect(() => subscribeReset(reset), [subscribeReset, reset]);
  useFocusEffect(useCallback(() => () => { reset(); setHandle(''); }, [reset, setHandle]));
  const invitation = account.session ? Linking.createURL('/social/add', { scheme: 'xiaoq', queryParams: { handle: account.session.user.handle } }) : '';
  const friend = found ? social.metadata?.friends.find(item => item.user.id === found.id) : null;
  return <SocialScreen title={text('添加好友', 'Add friend')}><AccountGate><SocialScroll>
    <Type header size={23} weight="500">{text('通过Q号找到朋友', 'Find a friend by Q handle')}</Type>
    <Type muted size={13}>{text('精确查找账号，确认后发送好友申请。', 'Look up an exact handle, then send a friend request.')}</Type>
    <Input label={text('好友Q号', 'Friend’s Q handle')} editable={!action.busy} autoCapitalize="none" autoCorrect={false} value={handle} onChangeText={value => { setHandle(value); setFound(null); setSent(false); }} maxLength={24} />
    <SocialButton label={text('查找', 'Find account')} disabled={action.busy || !handle.trim()} onPress={() => {
      let result: SocialUser | null = null;
      void action.run(async () => { result = await social.call(`/v1/users/lookup?handle=${encodeURIComponent(normalizeHandle(handle))}`, decodeSocialUser); }).then(ok => { if (ok) { setFound(result); setSent(false); } });
    }} />
    <ErrorNotice code={action.error} />
    {found ? <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}><Avatar user={found} /><View style={{ flex: 1 }}><Type weight="500">{found.display_name}</Type><Type muted size={12}>@{found.handle}</Type></View></View>
      {found.id === social.ownerId ? <Type muted>{text('这是你自己的账号。', 'This is your own account.')}</Type> : friend ? <SocialButton label={text('发消息', 'Message')} onPress={() => router.push({ pathname: '/social/conversation', params: { id: friend.conversation_id } })} /> : sent ? <Type muted>{text('申请已发送，等待对方确认。', 'Request sent. Waiting for confirmation.')}</Type> : <>
        <Input label={text('附言（选填）', 'Note (optional)')} value={note} onChangeText={setNote} maxLength={80} />
        <SocialButton label={text('发送好友申请', 'Send friend request')} disabled={action.busy} onPress={() => void action.run(() => social.call('/v1/social/requests', decodeRequest, 'POST', { user_id: found.id, note: note.trim() })).then(ok => { if (ok) { setSent(true); setNote(''); } })} />
      </>}
    </View> : null}
    <View style={{ paddingTop: 20, gap: 12 }}><Type header weight="500">{text('邀请朋友', 'Invite a friend')}</Type><Type selectable muted>{account.session ? `@${account.session.user.handle}` : ''}</Type>
      <SocialButton quiet icon={Copy} label={text('复制邀请链接', 'Copy invitation link')} onPress={() => { void Clipboard.setStringAsync(invitation).then(() => notify(text('邀请链接已复制', 'Invitation link copied'))).catch(() => action.setError('REQUEST_FAILED')); }} />
      <SocialButton quiet icon={Share2} label={text('分享邀请', 'Share invitation')} onPress={() => { void Share.share({ message: invitation }).catch(() => action.setError('REQUEST_FAILED')); }} />
      {account.session ? <InviteQr handle={account.session.user.handle} /> : null}
      <Type muted size={12}>{text('链接与二维码只包含公开Q号，在安装了小Q的设备中打开；仍需发送并接受好友申请。', 'The link and QR code contain only your public Q handle and open in an installed Q app. A friend request and acceptance are still required.')}</Type>
    </View>
  </SocialScroll></AccountGate></SocialScreen>;
}
