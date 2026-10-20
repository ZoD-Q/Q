import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Check, ChevronRight, Leaf, Orbit, Sparkles, Waves } from 'lucide-react-native';
import type { AvatarName, ThemeName } from '@xiaoq/shared';
import { Action, Divider, Input, Page, Row, Sheet, Type, useDesign } from '../design';
import { chatErrorMessage } from '../ai-chat/messages';
import { revokeAiConsent } from '../ai-chat/consent';
import { openPrivacyPolicy, openSupportEmail, SUPPORT_EMAIL } from '../privacy';
import { useQAccount } from './account-state';
import { DeletionSettings } from './deletion-settings';

const avatars = [
  { id: 'orbit', icon: Orbit, zh: '星环', en: 'Orbit' },
  { id: 'leaf', icon: Leaf, zh: '叶片', en: 'Leaf' },
  { id: 'spark', icon: Sparkles, zh: '星光', en: 'Spark' },
  { id: 'wave', icon: Waves, zh: '涟漪', en: 'Wave' },
] as const;
const themes = [['light', '白昼', 'Light'], ['dark', '夜色', 'Dark'], ['warm', '暖纸', 'Warm']] as const;

export function QProfilePage() {
  const account = useQAccount();
  return <ProfileEditor key={account.session?.user.id ?? 'signed-out'} />;
}

function ProfileEditor() {
  const { colors, text, theme, setTheme, locale, setLocale, notify } = useDesign();
  const account = useQAccount();
  const user = account.session?.user;
  const [sheet, setSheet] = useState<'edit' | 'theme' | 'language' | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<AvatarName>('orbit');
  const [editOwner, setEditOwner] = useState<string | null>(null);
  const Avatar = avatars.find(item => item.id === user?.avatar)?.icon ?? Orbit;
  const selectedTheme = themes.find(item => item[0] === theme)!;
  const close = () => { setSheet(null); setName(''); setBio(''); setEditOwner(null); };
  const edit = () => {
    if (!user) { account.requestAuth(); return; }
    setEditOwner(user.id); setName(user.display_name); setBio(user.bio); setAvatar(user.avatar); setSheet('edit');
  };
  const save = async () => {
    if (user?.id !== editOwner || !name.trim() || account.profileBusy) return;
    if (await account.updateProfile({ display_name: name.trim(), bio, avatar })) {
      close(); notify(text('资料已保存', 'Profile saved'));
    }
  };
  const changeTheme = async (value: ThemeName) => {
    if (account.profileBusy) return;
    if (!user) setTheme(value);
    else await account.updateProfile({ theme: value });
  };
  const changeLocale = async (value: 'zh' | 'en') => {
    if (account.profileBusy) return;
    if (!user) setLocale(value);
    else await account.updateProfile({ locale: value === 'zh' ? 'zh-CN' : 'en' });
  };
  const arrow = (value: string) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <Type muted>{value}</Type><ChevronRight size={16} color={colors.muted} />
  </View>;
  return <>
    <Page title={text('设置', 'Settings')} description="">
      <View style={{ maxWidth: 680, width: '100%', gap: 24 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View accessibilityElementsHidden style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' }}>
            <Avatar size={27} color={colors.accent} strokeWidth={1.5} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Type size={18} weight="500">{user?.display_name ?? text('未登录', 'Signed out')}</Type>
            <Type muted selectable>{user ? `@${user.handle}` : text('登录后，与朋友保持联系', 'Sign in to connect with friends')}</Type>
            {user?.bio ? <Type muted selectable>{user.bio}</Type> : null}
          </View>
          <Action kind="ghost" label={user ? text('编辑', 'Edit') : text('登录', 'Sign in')} onPress={edit} disabled={account.loading} />
        </View>
        {account.loading ? <Type muted>{text('正在读取账号…', 'Loading account…')}</Type> : null}
        {account.error ? <View accessibilityLiveRegion="polite"><Type color={colors.danger} selectable>{chatErrorMessage(account.error, text)}</Type>
          <Action kind="ghost" label={text('重试', 'Retry')} onPress={() => void account.refresh()} />
        </View> : null}
        {account.logoutPending ? <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
          <Type color={colors.danger}>{account.logoutBusy ? text('正在确认账号退出…', 'Confirming sign out…')
            : text('有一次退出尚未完成。重试只处理原账号，不会退出当前账号。', 'A previous sign out is unconfirmed. Retry it without signing out the current account.')}</Type>
          <Action kind="ghost" label={text('重试原退出', 'Retry previous sign out')} disabled={account.logoutBusy} onPress={() => void account.retryLogout()} />
        </View> : null}
        <View>
          <Divider />
          <Row title={text('我的 Q 号与邀请', 'My Q handle and invitation')} right={arrow(user ? `@${user.handle}` : text('登录', 'Sign in'))}
            onPress={() => user ? router.push('/social/add') : account.requestAuth()} />
          <Row title={text('外观', 'Appearance')} right={arrow(text(selectedTheme[1], selectedTheme[2]))} onPress={() => setSheet('theme')} />
          <Row title={text('语言', 'Language')} right={arrow(locale === 'zh' ? '中文' : 'English')} onPress={() => setSheet('language')} />
          <Row title={text('隐私政策', 'Privacy policy')} onPress={() => { void openPrivacyPolicy().catch(() => notify(text('暂时无法打开隐私政策，请稍后重试。', 'Unable to open the privacy policy. Try again later.'))); }} />
          <Row title={text('反馈与支持', 'Feedback and support')} subtitle={SUPPORT_EMAIL}
            onPress={() => { void openSupportEmail().catch(() => notify(text(`请发送邮件至 ${SUPPORT_EMAIL}`, `Email ${SUPPORT_EMAIL}`))); }} />
          <Row title={text('撤回 AI 数据发送许可', 'Revoke AI data-sharing permission')}
            subtitle={text('下次向 DeepSeek 发送消息前会再次征求同意', 'Ask again before sending another message to DeepSeek')}
            onPress={() => { revokeAiConsent(); notify(text('已撤回 AI 数据发送许可', 'AI data-sharing permission revoked')); }} />
          <DeletionSettings />
        </View>
        {user ? <Action kind="ghost" label={text('退出账号', 'Sign out')} disabled={account.authBusy || account.logoutBusy} onPress={() => { close(); void account.logout(); }} /> : null}
      </View>
    </Page>
    <Sheet visible={sheet === 'edit' && !!user && user.id === editOwner} title={text('编辑资料', 'Edit profile')} onClose={close}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {avatars.map(({ id, icon: Icon, zh, en }) => <Pressable key={id} accessibilityRole="button" accessibilityLabel={text(zh, en)}
          accessibilityState={{ selected: avatar === id, disabled: account.profileBusy }} disabled={account.profileBusy} onPress={() => setAvatar(id)}
          style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
            backgroundColor: avatar === id ? colors.accentBg : colors.soft, opacity: pressed ? 0.65 : 1 })}>
          <Icon size={23} color={avatar === id ? colors.accent : colors.muted} />
        </Pressable>)}
      </View>
      <Input label={text('昵称', 'Name')} value={name} onChangeText={setName} maxLength={40} editable={!account.profileBusy} />
      <Input label={text('简介', 'Bio')} value={bio} onChangeText={setBio} maxLength={160} multiline editable={!account.profileBusy} />
      {account.error ? <Type color={colors.danger} selectable>{chatErrorMessage(account.error, text)}</Type> : null}
      <Action label={account.profileBusy ? text('正在保存…', 'Saving…') : text('保存', 'Save')} disabled={!name.trim() || account.profileBusy} onPress={() => void save()} />
    </Sheet>
    <Sheet visible={sheet === 'theme'} title={text('外观', 'Appearance')} onClose={close}>
      {themes.map(([id, zh, en], index) => <Row key={id} title={text(zh, en)} last={index === themes.length - 1}
        right={theme === id ? <Check size={18} color={colors.accent} /> : undefined} onPress={() => void changeTheme(id)} />)}
      {account.error ? <Type color={colors.danger}>{chatErrorMessage(account.error, text)}</Type> : null}
    </Sheet>
    <Sheet visible={sheet === 'language'} title={text('语言', 'Language')} onClose={close}>
      {([['zh', '中文'], ['en', 'English']] as const).map(([id, label], index) => <Row key={id} title={label} last={index === 1}
        right={locale === id ? <Check size={18} color={colors.accent} /> : undefined} onPress={() => void changeLocale(id)} />)}
      {account.error ? <Type color={colors.danger}>{chatErrorMessage(account.error, text)}</Type> : null}
    </Sheet>
  </>;
}
