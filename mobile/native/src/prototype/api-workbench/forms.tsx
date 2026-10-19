import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, KeyboardAvoidingView, View } from "react-native";
import { KeyRound } from "lucide-react-native";
import type { VideoConnectionRequest } from "@xiaoq/shared";
import { Input, Page, Sheet, Type, useDesign } from "../design";
import { Button, Notice, Option } from "./components";
import { errorMessage } from "./messages";

export function AuthForm({ busy, error, authenticate, restore }: {
  busy: string | null; error: unknown;
  authenticate: (mode: "login" | "register", fields: { handle: string; password: string; display_name?: string }) => Promise<boolean>;
  restore: () => Promise<boolean>;
}) {
  const { text, colors } = useDesign();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") setPassword(""); });
    return () => subscription.remove();
  }, []);
  const validHandle = /^[a-zA-Z0-9_]{3,24}$/.test(handle.trim()) && handle.trim().toLowerCase() !== "xiaoq";
  const validPassword = password.length >= (mode === "register" ? 10 : 1) && password.length <= 128;
  const canSubmit = validHandle && validPassword && (mode !== "register" || name.trim().length > 0);
  const submit = () => {
    const fields = { handle: handle.trim().toLowerCase(), password, ...(mode === "register" ? { display_name: name.trim() } : {}) };
    setPassword("");
    void authenticate(mode, fields);
  };
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}>
    <Page title={text("API 工作台", "API workbench")} description={text("用你自己的可灵 API 创作视频。", "Create videos with your own Kling API.")}>
      <View style={{ maxWidth: 480, width: "100%", gap: 24 }}>
        <View style={{ gap: 8 }}><Type size={20} weight="600">{text("登录 Q，保存你的连接与作品", "Sign in to Q to keep connections and videos")}</Type>
          <Type size={14} muted>{text("使用已有 Q 账号。可灵按你的供应商账户计费，Q 演示余额不参与支付。", "Use your existing Q account. Kling bills your supplier account; Q demo credits are not used.")}</Type></View>
        {busy === "restore" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><ActivityIndicator color={colors.accent} /><Type muted>{text("正在恢复登录…", "Restoring your session…")}</Type></View> : null}
        {error ? <Notice error>{errorMessage(error, text)}</Notice> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Option label={text("登录", "Sign in")} selected={mode === "login"} disabled={!!busy} onPress={() => { setMode("login"); setPassword(""); }} />
          <Option label={text("注册 Q 账号", "Create Q account")} selected={mode === "register"} disabled={!!busy} onPress={() => { setMode("register"); setPassword(""); }} />
        </View>
        <Input label={text("Q 账号", "Q handle")} value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={24} editable={!busy} placeholder={text("3–24 位字母、数字或下划线", "3–24 letters, digits or underscores")} />
        {mode === "register" ? <Input label={text("显示名称", "Display name")} value={name} onChangeText={setName} maxLength={40} editable={!busy} autoComplete="nickname" /> : null}
        <Input label={text("密码", "Password")} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === "register" ? "new-password" : "current-password"} textContentType={mode === "register" ? "newPassword" : "password"} maxLength={128} editable={!busy} onSubmitEditing={() => { if (canSubmit && !busy) submit(); }} hint={mode === "register" ? text("10–128 个字符", "10–128 characters") : undefined} />
        <Button label={busy === "auth" ? text("正在登录…", "Signing in…") : mode === "register" ? text("注册并继续", "Create account and continue") : text("登录并继续", "Sign in and continue")} disabled={!!busy || !canSubmit} onPress={submit} />
        {error ? <Button label={text("重新恢复已有会话", "Retry saved session")} kind="ghost" disabled={!!busy} onPress={() => void restore()} /> : null}
      </View>
    </Page>
  </KeyboardAvoidingView>;
}

export function ConnectionForm({ busy, error, save, close }: {
  busy: boolean; error: unknown; save: (body: VideoConnectionRequest) => Promise<boolean>; close: () => void;
}) {
  const { text } = useDesign();
  const [name, setName] = useState("");
  const [region, setRegion] = useState<"cn" | "global">("cn");
  const [apiKey, setApiKey] = useState("");
  const clearAndClose = () => { setApiKey(""); close(); };
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => { if (state !== "active") setApiKey(""); });
    return () => subscription.remove();
  }, []);
  const submit = async () => {
    const body: VideoConnectionRequest = { name: name.trim(), region, api_key: apiKey.trim() };
    setApiKey("");
    if (await save(body)) close();
  };
  return <Sheet visible title={text("添加可灵连接", "Add Kling connection")} onClose={clearAndClose} automaticallyAdjustKeyboardInsets={false}>
    <View style={{ gap: 8 }}><Type size={16} weight="500">{text("连接你自己的 API 账户", "Connect your own API account")}</Type>
      <Type size={14} muted>{text("从可灵开放平台获取 API Key，并选择该账户对应的接口区域。", "Get an API key from the Kling developer platform and choose the region for that account.")}</Type></View>
    {error ? <Notice error>{errorMessage(error, text)}</Notice> : null}
    <Input label={text("连接名称", "Connection name")} placeholder={text("例如：我的可灵账户", "For example: My Kling account")} value={name} onChangeText={setName} maxLength={48} editable={!busy} />
    <View style={{ gap: 8 }}><Type size={13} weight="500">{text("接口区域", "API region")}</Type>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Option label={text("中国内地接口", "Mainland China API")} selected={region === "cn"} onPress={() => setRegion("cn")} disabled={busy} />
        <Option label={text("国际接口", "International API")} selected={region === "global"} onPress={() => setRegion("global")} disabled={busy} />
      </View></View>
    <Input label="API Key" value={apiKey} onChangeText={setApiKey} placeholder={text("输入可灵 API Key", "Enter your Kling API key")} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" maxLength={512} editable={!busy} />
    <Type size={13} muted>{text("密钥加密保存在 Q 服务端，不会返回客户端。保存连接不会验证可灵权限或发起生成。", "Q stores the key encrypted on its server and never returns it. Saving does not verify Kling access or generate a video.")}</Type>
    <Button label={busy ? text("正在保存…", "Saving…") : text("保存连接", "Save connection")} icon={KeyRound} disabled={busy || !name.trim() || !apiKey.trim()} onPress={() => void submit()} />
  </Sheet>;
}
