import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Path, Circle } from "react-native-svg";
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
import { MODEL_NAMES } from "./ai-chat/state-model";
import type { ChatController } from "./ai-chat/use-chat";
import { ChatAuthSheet } from "./ai-chat/auth-sheet";
import { chatErrorMessage, chatStatusErrorMessage } from "./ai-chat/messages";
import type { AiModel } from "@xiaoq/shared";
import { ChatProposal } from './plugin-host/chat-proposal';
import { bankIdForPlugin } from './plugin-host/core';
import { BankTransferComposer } from './banking/transfer-composer';
import { openPrivacyPolicy } from './privacy';
export type { Conversation, ChatMessage } from "./ai-chat/state-model";

export function QGlyph({ size = 48 }: { size?: number }) {
  const { colors } = useDesign();
  return (
    <Svg aria-hidden={true} width={size} height={size} viewBox="0 0 48 48">
      <Circle
        cx="22"
        cy="22"
        r="15"
        fill="none"
        stroke={colors.accent}
        strokeWidth="3.2"
      />
      <Path
        d="M26 27C29 27 30 35 37 36"
        fill="none"
        stroke={colors.accent}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <Circle cx="38" cy="38" r="2.3" fill={colors.accent} />
    </Svg>
  );
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
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const reduced = useReducedMotion();
  const followEnd = useRef(true);
  useEffect(() => { followEnd.current = true; }, [conversation?.id]);
  const hasMessages = !!conversation?.messages.length;
  const bankPlugin = bankIdForPlugin(controller.plugin);
  const send = () => {
    if (!draft.trim() || controller.busy || controller.authBusy) return;
    selectionFeedback();
    if (controller.send(draft.trim())) { followEnd.current = true; setDraft(""); }
  };
  const suggestion = (value: string) => {
    setDraft(value);
    input.current?.focus();
  };
  const composer = (
    <View
      style={{ width: "100%", maxWidth: 690, alignSelf: "center", gap: 10 }}
    >
      {bankPlugin ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}><Action kind="ghost" label={text("填写转账", "Fill transfer")} disabled={controller.busy} onPress={() => setBankForm(true)} /><Action kind="ghost" label={text("查询余额", "Check balance")} disabled={controller.busy} onPress={() => suggestion(text("查询余额", "Show balance"))} /></View> : null}
      {controller.plugin && <View style={{ gap: 3 }}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Type size={13} color={colors.accent}>{controller.plugin.title}</Type><Action kind="ghost" label={text('移除插件', 'Remove plugin')} disabled={controller.busy} onPress={() => controller.selectPlugin(null)} /></View><Type size={11} muted>{bankPlugin ? text('银行插件 · 模拟港币。明确的转账指令直接准备工具提案，确认后才记账。', 'Bank plugin · Simulated HKD. Transfer commands prepare a tool proposal; only confirmation posts it.') : text('插件对话关闭深度思考；执行工具前会请你确认。', 'Plugin chat uses standard mode and asks before executing tools.')}</Type></View>}
      <View
        style={{
          backgroundColor: colors.bg,
          borderWidth: 1,
          borderColor: focused ? colors.accent : colors.line,
          borderRadius: 24,
          paddingHorizontal: 18,
          paddingTop: 18,
          paddingBottom: 10,
          boxShadow: focused ? "0 4px 24px #087FA30A" : "0 4px 24px #20334206",
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
            minHeight: phone ? 34 : 46,
            maxHeight: 160,
            fontSize: 16,
            lineHeight: 25,
            color: colors.ink,
            textAlignVertical: "top",
            padding: 0,
            // The composer already provides the visible focus boundary on web.
            ...(process.env.EXPO_OS === "web" ? { outlineWidth: 0 } : {}),
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
            marginTop: 5,
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
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
                minHeight: 44,
                paddingHorizontal: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Type size={13} muted>
                {MODEL_NAMES[model]}
              </Type>
              <ChevronDown size={12} color={colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={controller.busy ? text("停止回答", "Stop answer") : text("发送消息", "Send message")}
              accessibilityState={{ disabled: !controller.busy && (!draft.trim() || controller.authBusy) }}
              disabled={!controller.busy && (!draft.trim() || controller.authBusy)}
              onPress={controller.busy ? controller.stop : send}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
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
      {controller.historyUnavailable ? <Type size={12} muted>{text("当前服务器暂不支持云端历史，对话仅保留在本次会话。", "This server does not support cloud history yet. Chats are kept for this session only.")}</Type> : null}
      {controller.historyBusy ? <Type size={12} muted>{text("正在读取历史…", "Loading history…")}</Type> : null}
      {controller.historyError ? <View accessibilityLiveRegion="polite" style={{ gap: 8 }}><Type size={13} color={colors.danger}>{text("聊天记录尚未同步，请重试；版本冲突时请重新登录加载服务器记录。", "History is not synced. Retry; for a version conflict, sign in again to load server history.")} ({controller.historyError})</Type><Action kind="ghost" label={text("重试同步", "Retry sync")} onPress={() => { void controller.retryHistory(); }} /><Action kind="ghost" label={text("重载云端版本（替换本机未保存内容）", "Reload cloud version (replace unsaved changes)")} disabled={controller.busy || controller.historyBusy} onPress={controller.reloadCloud} /></View> : null}
      {controller.messageError ? <View accessibilityLiveRegion="polite"><Type size={13} color={colors.danger}>{chatErrorMessage(controller.messageError, text)}</Type></View> : null}
      {controller.authBusy ? <Type size={11} muted style={{ textAlign: "center" }}>{text("正在恢复登录…", "Restoring session…")}</Type> : null}
      {!bankPlugin && controller.statusPhase !== "ready" ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          <Type size={11} muted>{controller.statusBusy
            ? text("正在检查 Q 对话配置…", "Checking Q chat configuration…")
            : controller.statusPhase === "unconfigured"
              ? text("Q 对话服务尚未配置", "Q chat has not been configured")
              : chatStatusErrorMessage(controller.statusError, text)}</Type>
          {controller.statusPhase === "error" && controller.status?.configured ? <Type size={11} muted>{text("上次配置检查正常，你仍可尝试发送。", "The last configuration check succeeded. You can still try sending.")}</Type> : null}
          {!controller.statusBusy ? <Action kind="ghost" label={text("重新检查", "Check again")} onPress={controller.reconnect} /> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 10 }}>
        {controller.session ? <><Type size={12} muted>@{controller.session.user.handle}</Type><Action kind="ghost" label={text("退出登录", "Sign out")} onPress={() => { void controller.logout(); }} disabled={controller.authBusy} /></>
          : <Action kind="ghost" label={text("登录后开始对话", "Sign in to start chatting")} onPress={controller.openAuth} disabled={controller.authBusy} />}
      </View>
      {controller.authError && !controller.authOpen ? <Type size={12} color={colors.danger}>{chatErrorMessage(controller.authError, text)}</Type> : null}
    </View>
  );
  const welcome = (
    <Type
      size={phone ? 27 : 34}
      weight="500"
      header
      style={{ textAlign: "center", letterSpacing: -0.7 }}
    >
      {text("有什么想聊的？", "What’s on your mind?")}
    </Type>
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
            minHeight: 44,
            paddingHorizontal: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderRadius: 12,
            backgroundColor: pressed ? colors.soft : "transparent",
          })}
        >
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
    >
      {hasMessages ? (
        <>
          <ScrollView
            ref={scroll}
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
            {conversation!.messages.map((message) => (
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
                    <QGlyph size={23} />
                    <Type size={13} weight="500">
                      {message.bankCommand ? text("小Q · 银行插件", "Q · Bank plugin") : message.model ? MODEL_NAMES[message.model] : "小Q"}
                    </Type>
                  </View>
                ) : null}
                {message.content ? <Type selectable size={16} style={{ lineHeight: 28 }}>{message.content}</Type> : null}
                {message.toolProposalId && controller.session && conversation?.plugin && <ChatProposal key={`${controller.session.token}:${message.toolProposalId}`} id={message.toolProposalId} token={controller.session.token} connectionId={conversation.plugin.id} onContinue={message.id === conversation.messages.at(-1)?.id && !controller.busy ? () => controller.resumeTool(message.id, message.toolProposalId!) : undefined} />}
                {message.role === "assistant" && ["pending", "streaming"].includes(message.status) ? <View accessibilityLiveRegion="polite"><Type size={13} muted>
                  {controller.phase === "thinking" ? text("正在思考…", "Thinking…") : controller.phase === "waiting" ? message.bankCommand ? text("正在准备银行插件提案…", "Preparing the bank plugin proposal…") : text("正在连接 DeepSeek…", "Connecting to DeepSeek…") : text("正在回答…", "Answering…")}
                </Type></View> : null}
                {message.status === "cancelled" ? <Type size={13} muted>{text("已停止接收，已收到的内容保留。", "Stopped receiving. The text received so far is preserved.")}</Type> : null}
                {message.status === "error" ? <Type selectable size={13} color={colors.danger}>{chatErrorMessage(message.errorCode ?? "AI_UPSTREAM_ERROR", text)}</Type> : null}
                {message.status === "incomplete" ? <Type size={13} muted>{message.finishReason === "length"
                  ? text("回答达到本次长度上限，内容未完整结束。", "The answer reached this request’s length limit and is incomplete.")
                  : text("供应商未完整返回本次回答。", "The provider did not complete this answer.")}</Type> : null}
                {message.contextLimited ? <Type size={11} muted>{text("本次使用了最近的完整对话作为上下文。", "This answer used the most recent complete turns as context.")}</Type> : null}
                {message.role === "assistant" && message.id === conversation?.messages.at(-1)?.id && ["error", "incomplete", "cancelled"].includes(message.status)
                  ? <Action kind="ghost" icon={RotateCcw} label={text("重试回答", "Retry answer")} onPress={controller.retry} disabled={controller.busy || controller.authBusy} style={{ alignSelf: "flex-start" }} /> : null}
              </Reveal>
            ))}
          </ScrollView>
          <View
            style={{
              paddingHorizontal: phone ? 16 : 36,
              paddingTop: 10,
              paddingBottom: phone ? 10 : 24,
            }}
          >
            {composer}
          </View>
        </>
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: phone ? 22 : 40,
            paddingBottom: phone ? 85 : 100,
            paddingTop: 20,
          }}
        >
          <View
            style={{
              width: "100%",
              maxWidth: 660,
              alignSelf: "center",
              gap: 24,
            }}
          >
            {welcome}
            {composer}
            {!draft.trim() ? prompts : null}
          </View>
        </ScrollView>
      )}
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
      {controller.historyError ? <><Type color={colors.danger}>{text("历史加载或保存失败", "History load or save failed")} ({controller.historyError})</Type><Action kind="ghost" label={text("重试同步", "Retry sync")} onPress={() => { void controller.retryHistory(); }} /></> : null}
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
