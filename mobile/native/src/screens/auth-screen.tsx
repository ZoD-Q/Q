import { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { ArrowRight, Globe, Leaf, ShieldCheck, Sparkles } from 'lucide-react-native';
import { DEMO_ACCOUNTS } from '@xiaoq/shared';
import { useApp } from '@/providers/app-provider';
import { errorKey } from '@/services/api';
import { Button, Input, Notice, Pill, QMark, Type } from '@/components/ui';
import type { CopyKey } from '@/i18n';

export function AuthScreen() {
  const { t, colors, locale, setGuestLocale, authenticate, sessionExpired } = useApp();
  const wide = useWindowDimensions().width >= 950;
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const normalized = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(normalized)) return setError('invalidHandle');
    if (password.length < 10 || password.length > 128) return setError('invalidPassword');
    if (mode === 'register' && (!name.trim() || Array.from(name.trim()).length > 40)) return setError('invalidName');
    setError(null); setBusy(true);
    try { await authenticate(mode, { handle: normalized, password, ...(mode === 'register' ? { display_name: name.trim() } : {}) }); }
    catch (err) { setError(errorKey(err)); }
    finally { setBusy(false); }
  };
  return <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.background }}>
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ paddingHorizontal: wide ? 48 : 24, paddingTop: 26, paddingBottom: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><QMark /><Type weight="600" size={14}>{t.tagline}</Type></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t.language} onPress={() => setGuestLocale(locale === 'en' ? 'zh-CN' : 'en')} style={{ flexDirection: 'row', gap: 7, minHeight: 44, alignItems: 'center', padding: 8 }}><Globe size={16} color={colors.muted} /><Type muted size={12}>{locale === 'en' ? '中文' : 'EN'}</Type></Pressable>
      </View>
      <View style={{ flex: 1, width: '100%', maxWidth: 1240, alignSelf: 'center', paddingHorizontal: wide ? 48 : 24, paddingTop: wide ? 64 : 25, paddingBottom: 60, flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch', gap: wide ? 90 : 30 }}>
        {wide ? <View style={{ flex: 1, gap: 23, paddingBottom: 20 }}>
          <Pill tone="accent">{t.welcomeBadge}</Pill>
          <Type size={49} weight="500" style={{ lineHeight: 1.35 * 49, letterSpacing: -1.8 }}>{t.welcome}</Type>
          <Type muted size={16} style={{ maxWidth: 360, lineHeight: 27 }}>{t.welcomeSub}</Type>
          <View accessibilityElementsHidden style={{ height: 240, width: 350, marginTop: 20 }}>
            <View style={{ position: 'absolute', top: 0, left: 32, width: 218, height: 218, borderRadius: 140, borderWidth: 1, borderColor: colors.line }} />
            <View style={{ position: 'absolute', top: 28, left: 60, width: 162, height: 162, borderRadius: 100, borderWidth: 1, borderColor: colors.line }} />
            <View style={{ position: 'absolute', top: 44, left: 88, width: 108, height: 124, borderRadius: 34, transform: [{ rotate: '-11deg' }], backgroundColor: colors.wallet, alignItems: 'center', justifyContent: 'center', boxShadow: '0 12px 32px #0000000C' }}><QMark size={70} inverse /></View>
            <View style={{ position: 'absolute', top: 8, left: 220, width: 46, height: 46, borderRadius: 23, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' }}><Sparkles size={23} color={colors.accent} strokeWidth={1.4} /></View>
            <View style={{ position: 'absolute', top: 166, left: 30, width: 46, height: 46, borderRadius: 23, backgroundColor: colors.successSoft, alignItems: 'center', justifyContent: 'center' }}><Leaf size={23} color={colors.success} strokeWidth={1.4} /></View>
            <View style={{ position: 'absolute', top: 157, left: 237, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent }} />
          </View>
        </View> : null}
        <View style={{ width: wide ? 420 : '100%', maxWidth: 440, alignSelf: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 24, padding: wide ? 34 : 25, gap: 22, boxShadow: '0 8px 32px #00000003' }}>
          <View style={{ gap: 6 }}><Type size={29} weight="500" accessibilityRole="header">{mode === 'login' ? t.loginTitle : t.registerTitle}</Type><Type size={13} muted>{mode === 'login' ? t.loginSub : t.registerSub}</Type></View>
          {sessionExpired && !error ? <Notice text={t.sessionExpired} /> : null}
          <View style={{ gap: 18 }}>
            <Input label={t.handle} placeholder={t.handleHint} value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} autoComplete="username" editable={!busy} maxLength={24} />
            {mode === 'register' ? <Input label={t.displayName} placeholder={t.displayNameHint} value={name} onChangeText={setName} editable={!busy} maxLength={40} /> : null}
            <Input label={t.password} placeholder={t.passwordHint} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} editable={!busy} maxLength={128} onSubmitEditing={() => void submit()} />
          </View>
          {error ? <Notice text={t[error]} /> : null}
          <Button label={mode === 'login' ? t.signIn : t.signUp} onPress={() => void submit()} loading={busy} icon={ArrowRight} testID="auth-submit" />
          <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center' }}><Type muted size={12}>{mode === 'login' ? t.noAccount : t.hasAccount}</Type><Pressable accessibilityRole="button" disabled={busy} onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }} style={{ paddingVertical: 8 }}><Type size={12} color={colors.accent} weight="600">{mode === 'login' ? t.register : t.login}</Type></Pressable></View>
          {mode === 'login' ? <View style={{ gap: 11, paddingTop: 20, borderTopWidth: 1, borderColor: colors.line }}><Type size={12} muted>{t.demoAccounts}</Type><View style={{ flexDirection: 'row', gap: 10 }}>{DEMO_ACCOUNTS.map(account => <Button key={account.handle} variant="secondary" label={`${account.display_name} · @${account.handle}`} onPress={() => { setHandle(account.handle); setPassword(account.password); setError(null); }} style={{ flex: 1, paddingHorizontal: 10 }} disabled={busy} />)}</View><Type size={10} muted>{t.demoAccountHint}</Type></View> : <Type size={11} muted>{t.authFootnote}</Type>}
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, alignItems: 'center', paddingBottom: 24 }}><ShieldCheck size={13} color={colors.muted} /><Type size={11} muted>{t.demoOnly}</Type></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
