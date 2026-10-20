import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { Action, Choice, Input, Sheet, Type, useDesign } from '../design';
import type { ChatController } from './use-chat';
import { chatErrorMessage } from './messages';
import { openPrivacyPolicy } from '../privacy';

export function ChatAuthSheet({ controller, description, onShow, onDismiss }: {
  controller: Pick<ChatController, 'authOpen' | 'authBusy' | 'authError' | 'authenticate' | 'closeAuth'>;
  description?: string;
  onShow?: () => void;
  onDismiss?: () => void;
}) {
  const { text, colors } = useDesign();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [privacyRead, setPrivacyRead] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => { if (value !== 'active') setPassword(''); });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    // Closing through another account surface must also release an unfinished password.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!controller.authOpen) setPassword('');
  }, [controller.authOpen]);
  const valid = /^[a-zA-Z0-9_]{3,24}$/.test(handle.trim()) && handle.trim().toLowerCase() !== 'xiaoq'
    && password.length >= (mode === 'register' ? 10 : 1) && password.length <= 128
    && (mode !== 'register' || (name.trim().length > 0 && privacyRead));
  const submit = () => {
    if (!valid || controller.authBusy) return;
    const fields = { handle: handle.trim().toLowerCase(), password, ...(mode === 'register' ? { display_name: name.trim() } : {}) };
    setPassword('');
    void controller.authenticate(mode, fields);
  };
  return <Sheet visible={controller.authOpen} title={text('登录小Q', 'Sign in to Q')} onClose={() => { setPassword(''); controller.closeAuth(); }} onShow={onShow} onDismiss={onDismiss}>
    <Type size={14} muted>{description ?? text('使用已有 Q 账号继续对话。登录后草稿仍在，点击发送即可开始。', 'Use your existing Q account. Your draft stays here; send it when you are signed in.')}</Type>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Choice label={text('登录', 'Sign in')} selected={mode === 'login'} disabled={controller.authBusy} onPress={() => { setMode('login'); setPassword(''); }} />
      <Choice label={text('注册', 'Create account')} selected={mode === 'register'} disabled={controller.authBusy} onPress={() => { setMode('register'); setPassword(''); }} />
    </View>
    <Input label={text('Q 账号', 'Q handle')} value={handle} onChangeText={setHandle} maxLength={24} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" editable={!controller.authBusy} placeholder={text('3–24 位字母、数字或下划线', '3–24 letters, digits, or underscores')} />
    {mode === 'register' ? <Input label={text('显示名称', 'Display name')} value={name} onChangeText={setName} maxLength={40} editable={!controller.authBusy} /> : null}
    <Input label={text('密码', 'Password')} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} editable={!controller.authBusy} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} textContentType={mode === 'register' ? 'newPassword' : 'password'} hint={mode === 'register' ? text('10–128 个字符', '10–128 characters') : undefined} onSubmitEditing={submit} />
    <Action kind="ghost" label={text('隐私政策与联系方式', 'Privacy policy and contact')} onPress={() => { void openPrivacyPolicy(); }} />
    {mode === 'register' ? <Choice label={text('我已阅读隐私政策', 'I have read the privacy policy')} selected={privacyRead} disabled={controller.authBusy} onPress={() => setPrivacyRead(value => !value)} /> : null}
    {controller.authError ? <View accessibilityLiveRegion="polite"><Type size={13} color={colors.danger}>{chatErrorMessage(controller.authError, text)}</Type></View> : null}
    <Action label={controller.authBusy ? text('正在登录…', 'Signing in…') : mode === 'register' ? text('注册并继续', 'Create account and continue') : text('登录并继续', 'Sign in and continue')} disabled={!valid || controller.authBusy} onPress={submit} />
  </Sheet>;
}
