import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Lightbulb,
  Paperclip,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  Square,
  RotateCcw,
  ChevronRight,
  X,
} from "lucide-react-native";
import {
  Action,
  Choice,
  IconAction,
  Input,
  Page,
  Row,
  Sheet,
  Type,
  useDesign,
} from "./design";
import { Reveal, selectionFeedback } from "./motion";

import type { Conversation } from "./ai-chat/state-model";
import { MODEL_NAMES, toolResultIsAnswered } from "./ai-chat/state-model";
import type { ChatController } from "./ai-chat/use-chat";
import { ChatAuthSheet } from "./ai-chat/auth-sheet";
import { chatErrorMessage, chatStatusErrorMessage, historyErrorMessage } from "./ai-chat/messages";
import { getMascotPresentation } from "./ai-chat/mascot-state";
import { QCompanion } from "./ai-chat/q-companion";
import type { AiModel } from "@xiaoq/shared";
import { ChatProposal } from './plugin-host/chat-proposal';
import { bankIdForPlugin } from './plugin-host/core';
import { BankTransferComposer } from './banking/transfer-composer';
import { openPrivacyPolicy } from './privacy';
export type { Conversation, ChatMessage } from "./ai-chat/state-model";

export function QGlyph({ size = 48 }: { size?: number }) {
  return <QCompanion size={size} showBadge={false} />;
}
export function ChatPage({ controller, onOpenPlugins }: {
  controller: ChatController;
  onOpenPlugins: () => void;
}) {
  const { conversation, draft, setDraft, model, setModel, think, setThink } = controller;
  const { colors, text, phone } = useDesign();
  const [models, setModels] = useState(false);
  const [tools, setTools] = useState(false);
  const [bankForm, setBankForm] = useState(false);
  const [focused, setFocused] = useState(false);
  const [details, setDetails] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(0);
  const { height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const reduced = useReducedMotion();
  const followEnd = useRef(true);
  useEffect(() => { followEnd.current = true; }, [conversation?.id]);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const hasMessages = !!conversation?.messages.length;
  const latestAnswer = conversation?.messages.at(-1);
  const presentation = getMascotPresentation({
    phase: controller.phase,
    message: latestAnswer,
    authBusy: controller.authBusy,
    historyBusy: controller.historyBusy,
    historyError: controller.historyError,
    statusPhase: controller.statusPhase,
    statusError: controller.statusError,
    messageError: controller.messageError,
    authError: controller.authOpen ? "" : controller.authError,
    hasSession: !!controller.session,
  });
  const statusTitle = text(presentation.title.zh, presentation.title.en);
  const statusDetail = text(presentation.detail.zh, presentation.detail.en);
  const hasNotice = !!(controller.historyError || controller.historyUnavailable || controller.messageError
    || (controller.authError && !controller.authOpen)
    || ["error", "unconfigured"].includes(controller.statusPhase));
  const noticeTitle = controller.historyError ? text("记录尚未同步", "History not synced")
    : controller.messageError ? text("发送需要处理", "Send needs attention")
    : controller.authError && !controller.authOpen ? text("登录需要处理", "Sign-in needs attention")
    : controller.statusPhase === "unconfigured" ? text("对话服务未配置", "Chat is not configured")
    : controller.statusPhase === "error" ? text("连接需要检查", "Check connection")
    : text("记录仅保留在本次会话", "History is kept for this session");
  const compactWelcome = keyboardVisible || height < 580 || fontScale > 1.4 || (availableHeight > 0 && availableHeight < 420);
  const dockMaxHeight = availableHeight > 0 ? Math.min(availableHeight, Math.max(96, availableHeight * (compactWelcome ? 0.85 : 0.6))) : undefined;
  const touchSize = process.env.EXPO_OS === "android" ? 48 : 44;
  const animateCompanion = presentation.busy && !details && !models && !tools && !bankForm
    && !controller.authOpen && !controller.aiConsentOpen;
  const bankPlugin = bankIdForPlugin(controller.plugin);
  const send = () => {
    if (!draft.trim() || controller.busy || controller.authBusy || controller.historyBusy) return;
    selectionFeedback();
    if (controller.send(draft.trim())) { followEnd.current = true; setDraft(""); }
  };
  const suggestion = (value: string) => {
    setDraft(value);
    input.current?.focus();
  };
  const composer = (
    <View
      style={{ width: "100%", maxWidth: 690, alignSelf: "center", gap: 8 }}
    >
      {hasMessages || compactWelcome ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingBottom: 4 }}>
          <QCompanion state={presentation.state} size={52} animated={animateCompanion} />
          <View accessible accessibilityLiveRegion="polite" accessibilityRole="text"
            accessibilityLabel={`${statusTitle}. ${statusDetail}`} accessibilityState={{ busy: presentation.busy }} aria-busy={presentation.busy} testID="q-task-status"
            style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Type size={13} weight="600">{statusTitle}</Type>
            {!compactWelcome && <Type size={12} muted>{statusDetail}</Type>}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={text("查看对话状态", "View chat status")}
            onPress={() => setDetails(true)} style={({ pressed }) => ({ minWidth: touchSize, minHeight: touchSize,
              alignItems: "center", justifyContent: "center", opacity: pressed ? 0.5 : 1 })}>
            <ChevronRight size={17} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}
      {controller.plugin && <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingLeft: 12, gap: 4, borderRadius: 16, backgroundColor: colors.soft }}><Type size={13} color={colors.accent}>{controller.plugin.title}</Type><IconAction icon={X} label={text('移除插件', 'Remove plugin')} disabled={controller.busy} onPress={() => controller.selectPlugin(null)} /></View>}
      <View
        style={{
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: focused ? colors.accent : colors.line,
          borderRadius: 22,
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 8,
        }}
      >
        <TextInput
          ref={input}
          accessibilityLabel={text("给小Q发送消息", "Message Q")}
          placeholder={text(
            "问小Q，或者说说你的想法…",
            "Ask Q, or share a thought…",
          )}
          placeholderTextColor={colors.faint}
          value={draft}
          onChangeText={setDraft}
          multiline
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          selectionColor={colors.accent}
          style={{
            minHeight: compactWelcome ? 32 : 48,
            maxHeight: compactWelcome ? 80 : 144,
            fontSize: 16,
            lineHeight: 25,
            color: colors.ink,
            textAlignVertical: "top",
            padding: 0,
            // The composer already provides the visible focus boundary on web.
            ...(process.env.EXPO_OS === "web" ? { outlineWidth: 0, outlineStyle: "solid" } : {}),
          }}
          onKeyPress={(event) => {
            const native = event.nativeEvent as unknown as {
              key: string;
              shiftKey?: boolean;
              isComposing?: boolean;
              keyCode?: number;
            };
            if (
              process.env.EXPO_OS === "web" &&
              native.key === "Enter" &&
              !native.shiftKey &&
              !native.isComposing &&
              native.keyCode !== 229
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginTop: 8,
            flexWrap: fontScale > 1.4 ? "wrap" : "nowrap",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            <IconAction
              icon={Plus}
              label={text("添加工具", "Add tools")}
              selected={tools}
              onPress={() => setTools(true)}
            />
            {think ? <Lightbulb size={15} color={colors.accent} /> : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, minWidth: 0 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text(
                `选择模型，当前${MODEL_NAMES[model]}`,
                `Choose model, currently ${MODEL_NAMES[model]}`,
              )}
              onPress={() => setModels(true)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: touchSize,
                paddingHorizontal: 4,
                flexShrink: 1,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Type size={13} muted>
                {phone ? model === "deepseek-flash" ? "Flash" : "Pro" : MODEL_NAMES[model]}
              </Type>
              <ChevronDown size={12} color={colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={controller.busy ? text("停止回答", "Stop answer") : text("发送消息", "Send message")}
              accessibilityState={{ disabled: !controller.busy && (!draft.trim() || controller.authBusy || controller.historyBusy) }}
              disabled={!controller.busy && (!draft.trim() || controller.authBusy || controller.historyBusy)}
              onPress={controller.busy ? controller.stop : send}
              style={({ pressed }) => ({
                width: touchSize,
                height: touchSize,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: controller.busy || draft.trim() ? colors.accent : colors.soft,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              {controller.busy ? <Square size={17} fill={colors.onAccent} color={colors.onAccent} /> : <ArrowUp
                size={21}
                strokeWidth={1.8}
                color={draft.trim() ? colors.onAccent : colors.faint}
              />}
            </Pressable>
          </View>
        </View>
      </View>
      {hasNotice ? (
        <Pressable accessibilityRole="button" accessibilityLabel={text(`${noticeTitle}，查看详情`, `${noticeTitle}, view details`)}
          onPress={() => setDetails(true)} testID="chat-notice"
          style={({ pressed }) => ({ minHeight: touchSize, flexDirection: "row", alignItems: "center", justifyContent: "center",
            gap: 6, paddingHorizontal: 8, opacity: pressed ? 0.6 : 1 })}>
          <View accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}><Type size={12} muted>{noticeTitle}</Type></View>
          <ChevronRight size={14} color={colors.muted} />
        </Pressable>
      ) : null}
      {!controller.session ? <View style={{ alignItems: "center" }}>
        <Action kind="ghost" label={text("登录后开始对话", "Sign in to start chatting")} onPress={controller.openAuth} disabled={controller.authBusy} />
      </View> : null}
    </View>
  );
  const welcome = (
    <View style={{ alignItems: "center", gap: 16 }}>
      <QCompanion state={presentation.state} size={phone ? 152 : 176} animated={animateCompanion} showBadge={presentation.state !== "ready"} />
      <View style={{ alignItems: "center", gap: 10, maxWidth: 420 }}>
        <Type size={phone ? 25 : 32} weight="500" header style={{ textAlign: "center", letterSpacing: -0.5 }}>
          {text("有什么想聊的？", "What’s on your mind?")}
        </Type>
        <View accessibilityLiveRegion="polite" testID="q-welcome-status">
          <Type size={14} muted style={{ textAlign: "center", lineHeight: 22 }}>
            {presentation.state === "ready" ? text("说说你的想法，我们一起想想。", "Share a thought. Let’s work through it.") : statusTitle}
          </Type>
        </View>
      </View>
    </View>
  );
  const prompts = (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "center",
        gap: phone ? 8 : 16,
        flexWrap: "wrap",
      }}
    >
      {[
        {
          label: text("写点什么", "Write"),
          value: text(
            "帮我写一段简短清楚的文字。",
            "Help me write something clear and concise.",
          ),
          icon: SquarePen,
        },
        {
          label: text("一起想想", "Think"),
          value: text("一起梳理一个想法。", "Help me think through an idea."),
          icon: Lightbulb,
        },
      ].map((item) => (
        <Pressable
          key={item.label}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() =>
            item.value ? suggestion(item.value) : onOpenPlugins()
          }
          style={({ pressed }) => ({
            minHeight: touchSize,
            paddingHorizontal: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 12,
            backgroundColor: pressed ? colors.accentBg : colors.soft,
          })}
        >
          <item.icon size={15} color={colors.muted} aria-hidden />
          <Type size={13} muted>
            {item.label}
          </Type>
        </Pressable>
      ))}
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={process.env.EXPO_OS === "ios" ? insets.top + (phone ? 60 : 70) : 0}
    >
      <View style={{ flex: 1, minHeight: 0 }} onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}>
      {hasMessages ? (
          <ScrollView
            ref={scroll}
            style={{ flex: 1 }}
            onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; followEnd.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 90; }}
            scrollEventThrottle={100}
            onContentSizeChange={() => { if (followEnd.current) scroll.current?.scrollToEnd({ animated: !reduced && !controller.busy }); }}
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{
              maxWidth: 740,
              width: "100%",
              alignSelf: "center",
              paddingHorizontal: phone ? 24 : 28,
              paddingTop: 24,
              paddingBottom: 30,
              gap: 28,
            }}
          >
            {conversation!.messages.map((message) => toolResultIsAnswered(conversation!, message.id) && message.toolProposalId && controller.session && conversation?.plugin
              ? <ChatProposal key={`${controller.session.token}:${message.toolProposalId}`} id={message.toolProposalId} token={controller.session.token} connectionId={conversation.plugin.id} mediaOnly /> : (
              <Reveal
                key={message.id}
                style={{
                  alignSelf: message.role === "user" ? "flex-end" : "stretch",
                  maxWidth: message.role === "user" ? "88%" : "100%",
                  backgroundColor:
                    message.role === "user" ? colors.soft : "transparent",
                  padding: message.role === "user" ? 16 : 0,
                  borderRadius: 18,
                  gap: 12,
                }}
              >
                {message.role === "assistant" ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <QCompanion size={30} showBadge={false} state={message.id === latestAnswer?.id ? presentation.state : getMascotPresentation({ phase: "idle", message }).state} />
                    <Type size={13} weight="500">
                      {message.bankCommand ? text("小Q · 银行插件", "Q · Bank plugin") : text("小Q", "Q")}
                    </Type>
                  </View>
                ) : null}
                {message.content ? <Type selectable size={16} style={{ lineHeight: 28 }}>{message.content}</Type> : null}
                {message.toolProposalId && controller.session && conversation?.plugin && <ChatProposal key={`${controller.session.token}:${message.toolProposalId}`} id={message.toolProposalId} token={controller.session.token} connectionId={conversation.plugin.id} disabled={controller.busy || controller.historyBusy || !!controller.historyError} onContinue={message.id === conversation.messages.at(-1)?.id && !controller.busy ? () => { void controller.resumeTool(message.id, message.toolProposalId!); } : undefined} />}
                {message.id === conversation?.messages.at(-1)?.id && message.id === controller.toolResumeTarget?.messageId && message.toolProposalId
                  ? <Action kind="ghost" label={text('继续回答', 'Continue answer')} disabled={controller.busy || controller.historyBusy || !!controller.historyError} onPress={() => { void controller.resumeTool(message.id, message.toolProposalId!); }} style={{ alignSelf: 'flex-start' }} /> : null}
                {message.status === "cancelled" ? <Type size={13} muted>{message.errorCode === "INTERRUPTED" ? text("上次回答已中断，已收到的内容保留。", "The previous answer was interrupted. Received text is preserved.") : text("已停止接收，已收到的内容保留。", "Stopped receiving. The text received so far is preserved.")}</Type> : null}
                {message.status === "error" ? <Type selectable size={13} color={colors.danger}>{chatErrorMessage(message.errorCode ?? "AI_UPSTREAM_ERROR", text)}</Type> : null}
                {message.status === "incomplete" ? <Type size={13} muted>{message.finishReason === "length"
                  ? text("回答达到本次长度上限，内容未完整结束。", "The answer reached this request’s length limit and is incomplete.")
                  : text("供应商未完整返回本次回答。", "The provider did not complete this answer.")}</Type> : null}
                {message.role === "assistant" && message.id === conversation?.messages.at(-1)?.id && ["error", "incomplete", "cancelled"].includes(message.status)
                  ? <Action kind="ghost" icon={RotateCcw} label={text("重试回答", "Retry answer")} onPress={controller.retry} disabled={controller.busy || controller.authBusy || controller.historyBusy} style={{ alignSelf: "flex-start" }} /> : null}
              </Reveal>
            ))}
          </ScrollView>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: phone ? 24 : 40,
            paddingVertical: compactWelcome ? 8 : 32,
          }}
        >
          {!compactWelcome ? <View style={{ width: "100%", maxWidth: 660, alignSelf: "center", gap: 28 }}>
            {welcome}
            {!draft.trim() ? prompts : null}
          </View> : null}
        </ScrollView>
      )}
      <ScrollView testID="chat-composer-dock" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={false}
        style={{ flexGrow: 0, flexShrink: 1, maxHeight: dockMaxHeight }}
        contentContainerStyle={{ paddingHorizontal: phone ? 16 : 36, paddingTop: compactWelcome ? 4 : 12, paddingBottom: phone ? 8 : 24 }}>
        {composer}
      </ScrollView>
      <Sheet visible={details} title={text("对话状态", "Chat status")} onClose={() => setDetails(false)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <QCompanion state={presentation.state} size={64} />
          <View style={{ flex: 1, gap: 4 }}><Type weight="600">{statusTitle}</Type><Type muted size={13}>{statusDetail}</Type></View>
        </View>
        {latestAnswer?.status === "error" ? <Type selectable color={colors.danger}>{chatErrorMessage(latestAnswer.errorCode ?? "AI_UPSTREAM_ERROR", text)}</Type> : null}
        {controller.messageError ? <Type selectable color={colors.danger}>{chatErrorMessage(controller.messageError, text)}</Type> : null}
        {controller.authError && !controller.authOpen ? <>
          <Type selectable color={colors.danger}>{chatErrorMessage(controller.authError, text)}</Type>
          <Action kind="ghost" label={text("重新检查登录", "Check sign-in again")} disabled={controller.authBusy} onPress={() => { void controller.restore(); }} />
        </> : null}
        {controller.statusPhase !== "ready" ? <View style={{ gap: 8 }}>
          <Type muted size={13}>{controller.statusBusy ? text("正在检查对话配置…", "Checking chat configuration…")
            : controller.statusPhase === "unconfigured" ? text("Q 对话服务尚未配置。", "Q chat has not been configured.")
            : chatStatusErrorMessage(controller.statusError, text)}</Type>
          {controller.statusPhase === "error" && controller.status?.configured ? <Type muted size={13}>{text("上次配置检查通过，仍可尝试发送。", "The last configuration check passed. You can still try sending.")}</Type> : null}
          <Action kind="ghost" label={text("重新检查连接", "Check connection again")} disabled={controller.statusBusy} onPress={controller.reconnect} />
        </View> : null}
        {controller.historyBusy ? <Type muted size={13}>{text("正在同步聊天记录…", "Syncing chat history…")}</Type> : null}
        {controller.historyUnavailable ? <Type muted size={13}>{text("当前服务器暂不支持云端历史，对话仅保留在本次会话。", "This server does not support cloud history yet. Chats are kept for this session only.")}</Type> : null}
        {controller.historyError ? <View style={{ gap: 12 }}>
          <Type selectable color={colors.danger}>{historyErrorMessage(controller.historyError, text)}</Type>
          <Action kind="ghost" label={text("重试同步", "Retry sync")} disabled={controller.historyBusy} onPress={() => { void controller.retryHistory(); }} />
          <Type muted size={13}>{text("如果发生版本冲突，可以重载云端记录；这会替换本机尚未保存的内容。", "For a version conflict, you can reload cloud history. This replaces unsaved changes on this device.")}</Type>
          <Action kind="ghost" label={text("重载云端版本（替换未保存内容）", "Reload cloud version (replace unsaved changes)")} disabled={controller.busy || controller.historyBusy} onPress={controller.reloadCloud} />
        </View> : null}
      </Sheet>
      {bankForm && bankPlugin ? <BankTransferComposer bankId={bankPlugin} onClose={() => setBankForm(false)} onDraft={suggestion} /> : null}
      <Sheet
        visible={models}
        title={text("选择模型", "Choose model")}
        onClose={() => setModels(false)}
      >
        {(["deepseek-flash", "deepseek-v4-pro"] as AiModel[]).map((item, index) => (
          <Row key={item} title={MODEL_NAMES[item]} subtitle={index === 0 ? text("日常问答，优先速度", "Everyday questions, faster responses") : text("更复杂的任务与分析", "More complex tasks and analysis")}
            right={model === item ? <Check size={18} color={colors.accent} /> : undefined}
            onPress={controller.busy ? undefined : () => { selectionFeedback(); setModel(item); setModels(false); }} last={index === 1} />
        ))}
        {controller.busy ? <Type size={13} muted>{text("先停止当前回答，再切换模型。", "Stop the current answer before switching models.")}</Type> : null}
      </Sheet>
      <Sheet
        visible={tools}
        title={text("对话工具", "Chat tools")}
        onClose={() => setTools(false)}
      >
        {bankPlugin ? <Row title={text('填写转账', 'Fill a transfer')} onPress={() => { setTools(false); setBankForm(true); }} /> : null}
        <Row
          icon={Paperclip}
          title={text("添加文件", "Attach a file")}
          subtitle={text("当前仅支持文字，附件尚未接入", "Text only for now; attachments are not connected")}

        />
        <Row
          icon={SlidersHorizontal}
          title={text("选择插件", "Choose a plugin")}
          onPress={() => {
            setTools(false);
            onOpenPlugins();
          }}
          last
        />
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <Choice
            label={text("深度思考", "Deep thinking")}
            selected={think}
            disabled={controller.busy || !!controller.plugin}
            onPress={() => { if (!controller.busy && !controller.plugin) setThink(!think); }}
          />

        </View>
        <Type size={13} muted>{text("当前 Q 尚未接入联网搜索。深度思考可能需要更长时间。", "Web search is not connected in Q yet. Thinking mode may take longer.")}</Type>
      </Sheet>
      {controller.authOpen ? <ChatAuthSheet controller={controller} /> : null}
      <Sheet visible={controller.aiConsentOpen} title={text('使用 DeepSeek 对话', 'Chat with DeepSeek')} onClose={controller.cancelAiSharing}>
        <Type>{text(
          '为了生成回答，小Q会将你发送的文字和本次对话所需的上下文，通过小Q服务器交给第三方 DeepSeek 处理。使用插件续答时，还会发送所选插件的工具说明、参数及相关文字结果。',
          'To generate a reply, Q sends your text and the relevant conversation context through its server to the third-party provider DeepSeek. Plugin conversations also share the selected tool descriptions, arguments, and relevant text results.',
        )}</Type>
        <Type muted size={13}>{text(
          '同意仅对本次登录会话有效。你可以在设置中撤回，停止当前响应；已经发送给服务方的内容无法撤回。不必同意也能使用账号和好友功能。',
          'Permission lasts for this signed-in session. Revoke it in Settings to stop the current response; data already sent cannot be recalled. Account and friend features remain available without AI sharing permission.',
        )}</Type>
        <Action kind="ghost" label={text('阅读隐私政策', 'Read the privacy policy')} onPress={() => { void openPrivacyPolicy(); }} />
        <Action label={text('同意并发送', 'Agree and send')} onPress={controller.confirmAiSharing} />
        <Action kind="ghost" label={text('暂不使用 AI 对话', 'Not now')} onPress={controller.cancelAiSharing} />
      </Sheet>
      </View>
    </KeyboardAvoidingView>
  );
}
export function HistoryPage({
  items,
  onOpen,
  onNew,
  controller,
}: {
  controller: ChatController;
  items: Conversation[];
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { text, colors } = useDesign();
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) =>
    item.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Page
      title={text("历史记录", "History")}
      action={
        <Action
          label={text("新聊天", "New chat")}
          icon={Plus}
          onPress={onNew}
        />
      }
    >
      {controller.historyUnavailable ? <Type size={13} muted>{text("当前仅显示本次会话的记录。云端历史需要后端升级。", "Only this session’s chats are shown. Cloud history requires a server update.")}</Type> : null}
      {controller.historyError ? <><Type color={colors.danger}>{historyErrorMessage(controller.historyError, text)}</Type><Action kind="ghost" label={text("重试同步", "Retry sync")} onPress={() => { void controller.retryHistory(); }} /></> : null}
      <Action kind="ghost" label={controller.historyBusy ? text("正在加载…", "Loading…") : text("刷新历史", "Refresh history")} disabled={controller.historyBusy} onPress={() => { void controller.loadHistory(); }} />
      <Input
        label={text("搜索对话", "Search conversations")}
        placeholder={text("搜索关键词", "Search a thought")}
        value={query}
        onChangeText={setQuery}
      />
      <View>
        {filtered.map((item, index) => (
          <Row
            key={item.id}
            icon={SquarePen}
            title={item.title}
            subtitle={text(
              item.messages.length ? `${item.messages.length} 条消息` : "点击加载记录",
              item.messages.length ? `${item.messages.length} messages` : "Open to load messages",
            )}
            onPress={() => onOpen(item.id)}
            last={index === filtered.length - 1}
          />
        ))}
        {!filtered.length ? (
          <View style={{ paddingVertical: 56, alignItems: "center", gap: 12 }}>
            <Search size={26} color={colors.faint} />
            <Type muted>
              {query
                ? text("没有找到这段对话", "No conversations found")
                : text(
                    "你的对话会出现在这里",
                    "Your conversations will appear here",
                  )}
            </Type>
            <Action
              kind="ghost"
              label={text("开始聊天", "Start a chat")}
              onPress={onNew}
            />
          </View>
        ) : null}
      </View>
      {controller.historyCursor ? <Action kind="ghost" label={text("加载更多历史", "Load more history")} disabled={controller.historyBusy} onPress={() => { void controller.loadHistory(true); }} /> : null}
    </Page>
  );
}
