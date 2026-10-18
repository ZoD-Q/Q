import { useRef, useState, type ComponentRef } from "react";
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
  Globe2,
  Lightbulb,
  Paperclip,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}
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
export function ChatPage({
  conversation,
  onSend,
  onOpenPlugins,
  draft,
  setDraft,
  model,
  setModel,
  think,
  setThink,
  search,
  setSearch,
}: {
  model: string;
  setModel: (value: string) => void;
  think: boolean;
  setThink: (value: boolean) => void;
  search: boolean;
  setSearch: (value: boolean) => void;
  conversation: Conversation | null;
  onSend: (value: string) => void;
  onOpenPlugins: () => void;
  draft: string;
  setDraft: (value: string) => void;
}) {
  const { colors, text, phone } = useDesign();
  const [models, setModels] = useState(false);
  const [tools, setTools] = useState(false);
  const [focused, setFocused] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const reduced = useReducedMotion();
  const hasMessages = !!conversation?.messages.length;
  const send = () => {
    if (!draft.trim()) return;
    selectionFeedback();
    onSend(draft.trim());
    setDraft("");
  };
  const suggestion = (value: string) => {
    setDraft(value);
    input.current?.focus();
  };
  const composer = (
    <View
      style={{ width: "100%", maxWidth: 690, alignSelf: "center", gap: 10 }}
    >
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
            {think || search ? (
              <View style={{ flexDirection: "row", gap: 6 }}>
                {think ? <Lightbulb size={15} color={colors.accent} /> : null}
                {search ? <Globe2 size={15} color={colors.accent} /> : null}
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text(
                `选择模型，当前${model}`,
                `Choose model, currently ${model}`,
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
                {model}
              </Type>
              <ChevronDown size={12} color={colors.muted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("发送消息", "Send message")}
              accessibilityState={{ disabled: !draft.trim() }}
              disabled={!draft.trim()}
              onPress={send}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: draft.trim() ? colors.accent : colors.soft,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <ArrowUp
                size={21}
                strokeWidth={1.8}
                color={draft.trim() ? colors.onAccent : colors.faint}
              />
            </Pressable>
          </View>
        </View>
      </View>
      <Type size={11} muted style={{ textAlign: "center" }}>
        {text(
          "界面预览，尚未连接模型",
          "Interface preview. Model not connected.",
        )}
      </Type>
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
            onContentSizeChange={() =>
              scroll.current?.scrollToEnd({ animated: !reduced })
            }
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
                      小Q
                    </Type>
                  </View>
                ) : null}
                <Type selectable size={16} style={{ lineHeight: 28 }}>
                  {message.content}
                </Type>
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
      <Sheet
        visible={models}
        title={text("选择模型", "Choose model")}
        onClose={() => setModels(false)}
      >
        {["DeepSeek", "Claude", "GPT"].map((item, index) => (
          <Row
            key={item}
            title={item}
            subtitle={
              [
                text("通用对话与推理", "Conversation and reasoning"),
                text("写作与长文分析", "Writing and analysis"),
                text("创意与知识探索", "Creativity and knowledge"),
              ][index]
            }
            right={
              model === item ? (
                <Check size={18} color={colors.accent} />
              ) : undefined
            }
            onPress={() => {
              selectionFeedback();
              setModel(item);
              setModels(false);
            }}
            last={index === 2}
          />
        ))}
      </Sheet>
      <Sheet
        visible={tools}
        title={text("对话工具", "Chat tools")}
        onClose={() => setTools(false)}
      >
        <Row
          icon={Paperclip}
          title={text("添加文件", "Attach a file")}
          subtitle={text("附件入口预览", "Attachment preview")}
          onPress={() => {
            setTools(false);
            setDraft(text("请帮我阅读这份文件。", "Help me read this file."));
          }}
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
            onPress={() => setThink(!think)}
          />
          <Choice
            label={text("联网搜索", "Web search")}
            selected={search}
            onPress={() => setSearch(!search)}
          />
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
export function HistoryPage({
  items,
  onOpen,
  onNew,
}: {
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
              `${item.messages.length} 条消息`,
              `${item.messages.length} messages`,
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
    </Page>
  );
}
