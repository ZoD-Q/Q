import { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Check, CheckCheck, LogOut } from 'lucide-react-native';
import type { AvatarName, Locale, ThemeName } from '@xiaoq/shared';
import { useApp } from '@/providers/app-provider';
import { Avatar, Button, Card, Input, Notice, Type } from '@/components/ui';
import { errorKey } from '@/services/api';

export function ProfilePanel() {
  const { user, colors, t, updateProfile, logout } = useApp();
  const wide = useWindowDimensions().width >= 1100;
  const [name, setName] = useState(user!.display_name);
  const [bio, setBio] = useState(user!.bio);
  const [avatar, setAvatar] = useState<AvatarName>(user!.avatar);
  const [theme, setTheme] = useState<ThemeName>(user!.theme);
  const [locale, setLocale] = useState<Locale>(user!.locale);
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const change = () => { setSaved(false); setError(''); };
  const save = async () => {
    if (!name.trim() || Array.from(name.trim()).length > 40 || Array.from(bio).length > 160) return setError(t.invalidProfile);
    setBusy(true); setError(''); setSaved(false);
    try { await updateProfile({ display_name: name.trim(), bio, avatar, theme, locale }); setSaved(true); }
    catch (err) { setError(t[errorKey(err)]); }
    finally { setBusy(false); }
  };
  const exit = async () => {
    setLoggingOut(true); setError('');
    try { await logout(); } catch (err) { setError(t[errorKey(err)]); } finally { setLoggingOut(false); }
  };
  return <View style={{ gap: 28 }}>
    <View style={{ gap: 7 }}><Type muted size={11} weight="600" style={{ letterSpacing: 1.5 }}>{t.workspace}</Type><Type size={32} weight="500" accessibilityRole="header">{t.profileTitle}</Type><Type muted>{t.profileSub}</Type></View>
    <View style={{ flexDirection: wide ? 'row' : 'column', alignItems: 'stretch', gap: 22 }}>
      <Card style={{ flex: 1.2 }}>
        <Type size={17} weight="600">{t.personal}</Type>
        <View style={{ flexDirection: 'row', gap: 17, alignItems: 'center' }}><Avatar name={avatar} size={64} selected /><View style={{ gap: 3 }}><Type size={18} weight="600">{name || user!.display_name}</Type><Type muted selectable>@{user!.handle}</Type></View></View>
        <View style={{ gap: 11 }}><Type size={12} muted>{t.avatar}</Type><View style={{ flexDirection: 'row', gap: 12 }}>{(['orbit', 'leaf', 'spark', 'wave'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={t[value]} accessibilityState={{ selected: avatar === value, disabled: busy }} disabled={busy} onPress={() => { setAvatar(value); change(); }} style={{ borderWidth: 1.5, borderColor: avatar === value ? colors.accent : 'transparent', borderRadius: 17, padding: 3 }}><Avatar name={value} selected={avatar === value} /></Pressable>)}</View></View>
        <Input label={t.displayName} value={name} onChangeText={value => { setName(value); change(); }} maxLength={40} editable={!busy} />
        <Input label={t.bio} value={bio} onChangeText={value => { setBio(value); change(); }} maxLength={160} multiline numberOfLines={3} style={{ minHeight: 96 }} placeholder={t.bioPlaceholder} editable={!busy} hint={`${Array.from(bio).length}/160`} />
        <View style={{ borderTopWidth: 1, borderColor: colors.line, paddingTop: 16, gap: 4 }}><Type size={12} muted>{t.handle} · @{user!.handle}</Type><Type size={11} muted>{t.identityFixed}</Type></View>
      </Card>
      <Card style={{ flex: 1, alignSelf: wide ? 'flex-start' : 'stretch' }}>
        <Type size={17} weight="600">{t.appearance}</Type>
        <View style={{ gap: 13 }}><Type size={12} muted>{t.theme}</Type><View style={{ flexDirection: 'row', gap: 10 }}>{(['warm', 'light', 'dark'] as const).map(value => <Pressable accessibilityRole="button" accessibilityLabel={t[value]} accessibilityState={{ selected: theme === value, disabled: busy }} disabled={busy} key={value} onPress={() => { setTheme(value); change(); }} style={{ flex: 1, gap: 9 }}>
          <View style={{ height: 77, borderRadius: 12, borderWidth: 2, borderColor: theme === value ? colors.accent : colors.line, overflow: 'hidden', backgroundColor: value === 'dark' ? '#1C1E1B' : value === 'light' ? '#FFFFFF' : '#F6F4EF', flexDirection: 'row', padding: 8, gap: 7 }}><View style={{ width: 15, borderRadius: 4, backgroundColor: value === 'dark' ? '#3C4037' : value === 'light' ? '#EBEBEB' : '#DDD9CD' }} /><View style={{ flex: 1, paddingTop: 5, gap: 6 }}><View style={{ height: 5, width: '80%', borderRadius: 4, backgroundColor: value === 'dark' ? '#9CA491' : '#9C9D94' }} /><View style={{ height: 4, width: '55%', borderRadius: 4, backgroundColor: value === 'dark' ? '#555D4F' : '#D4D5CE' }} /><View style={{ flex: 1 }} />{theme === value ? <Check size={15} color={colors.accent} style={{ alignSelf: 'flex-end' }} /> : null}</View></View>
          <Type size={11} weight={theme === value ? '600' : '400'} style={{ textAlign: 'center' }}>{t[value]}</Type>
        </Pressable>)}</View></View>
        <View style={{ gap: 11, marginTop: 10 }}><Type size={12} muted>{t.language}</Type><View style={{ flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 4, gap: 4 }}>{(['zh-CN', 'en'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === 'en' ? 'English' : '简体中文'} accessibilityState={{ selected: locale === value, disabled: busy }} disabled={busy} onPress={() => { setLocale(value); change(); }} style={{ flex: 1, alignItems: 'center', padding: 11, borderRadius: 8, backgroundColor: locale === value ? colors.subtle : 'transparent' }}><Type size={13} weight={locale === value ? '600' : '400'}>{value === 'en' ? 'English' : '简体中文'}</Type></Pressable>)}</View></View>
      </Card>
    </View>
    {error ? <Notice text={error} /> : saved ? <Notice text={t.saved} success /> : null}
    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}><Button label={busy ? t.saving : t.save} icon={CheckCheck} loading={busy} disabled={loggingOut} onPress={() => void save()} /><Button label={loggingOut ? t.logoutBusy : t.logout} icon={LogOut} variant="ghost" loading={loggingOut} disabled={busy} onPress={() => void exit()} /></View>
  </View>;
}
