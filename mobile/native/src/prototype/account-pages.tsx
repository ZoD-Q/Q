import { useReducedMotion } from "react-native-reanimated";
import { useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import {
  ArrowUp,
  Bell,
  Check,
  ChevronRight,
  Leaf,
  Orbit,
  Search,
  ShieldCheck,
  Sparkles,
  Waves,
} from "lucide-react-native";
import {
  Action,
  Divider,
  Input,
  Page,
  Row,
  Sheet,
  Tabs,
  Type,
  useDesign,
} from "./design";

const avatarOptions = [
  { id: "orbit", icon: Orbit, zh: "星环", en: "Orbit" },
  { id: "leaf", icon: Leaf, zh: "叶片", en: "Leaf" },
  { id: "spark", icon: Sparkles, zh: "星光", en: "Spark" },
  { id: "wave", icon: Waves, zh: "涟漪", en: "Wave" },
] as const;

export function ProfilePage() {
  const {
    colors,
    text,
    phone,
    name,
    setName,
    theme,
    setTheme,
    locale,
    setLocale,
    notify,
    profileBio,
    setProfileBio,
    profileAvatar,
    setProfileAvatar,
  } = useDesign();
  const [draftName, setDraftName] = useState(name);
  const [bio, setBio] = useState(profileBio);
  const [avatar, setAvatar] = useState(profileAvatar);
  const [sheet, setSheet] = useState<
    "edit" | "theme" | "language" | "login" | null
  >(null);
  const [loginHandle, setLoginHandle] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const Avatar =
    avatarOptions.find((item) => item.id === profileAvatar)?.icon ?? Orbit;
  const themeOptions = [
    ["light", "白昼", "Light"],
    ["dark", "夜色", "Dark"],
    ["warm", "暖纸", "Warm"],
  ] as const;
  const currentTheme = themeOptions.find(([id]) => id === theme)!;
  const edit = () => {
    setDraftName(name);
    setBio(profileBio);
    setAvatar(profileAvatar);
    setSheet("edit");
  };
  const save = () => {
    if (!draftName.trim()) return;
    setName(draftName.trim());
    setProfileBio(bio);
    setProfileAvatar(avatar);
    setSheet(null);
    notify(text("资料已保存", "Profile saved"));
  };
  const close = () => {
    setSheet(null);
    setLoginPassword("");
  };
  const valueWithArrow = (value: string) => (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
      <Type size={phone ? 16 : 15} muted>
        {value}
      </Type>
      <ChevronRight size={16} color={colors.faint} />
    </View>
  );
  return (
    <>
      <Page title={text("设置", "Settings")} description="">
        <View style={{ maxWidth: 680, width: "100%", gap: 28 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 18,
                backgroundColor: colors.soft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Avatar size={27} strokeWidth={1.5} color={colors.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Type size={18} weight="500">
                {name}
              </Type>
              <Type size={phone ? 16 : 15} muted numberOfLines={2}>
                {profileBio ||
                  text("写一句关于你的话", "A few words about you")}
              </Type>
            </View>
            <Action kind="ghost" label={text("编辑", "Edit")} onPress={edit} />
          </View>
          <View>
            <Divider />
            <Row
              title={text("外观", "Appearance")}
              right={valueWithArrow(text(currentTheme[1], currentTheme[2]))}
              onPress={() => setSheet("theme")}
            />
            <Row
              title={text("语言", "Language")}
              right={valueWithArrow(locale === "zh" ? "中文" : "English")}
              onPress={() => setSheet("language")}
            />
            <Row
              title={text("账号", "Account")}
              right={valueWithArrow(text("登录", "Sign in"))}
              onPress={() => setSheet("login")}
              last
            />
          </View>
          <Type size={13} muted>
            {text(
              "预览设置仅保留在当前会话。",
              "Preview settings stay in this session.",
            )}
          </Type>
        </View>
      </Page>
      <Sheet
        visible={sheet === "edit"}
        title={text("编辑资料", "Edit profile")}
        onClose={close}
      >
        <View style={{ flexDirection: "row", gap: 12 }}>
          {avatarOptions.map(({ id, icon: Icon, zh, en }) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={text(zh, en)}
              accessibilityState={{ selected: avatar === id }}
              onPress={() => setAvatar(id)}
              style={({ pressed }) => ({
                width: 52,
                height: 52,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: avatar === id ? colors.accent : "transparent",
                backgroundColor: avatar === id ? colors.accentBg : colors.soft,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Icon
                size={23}
                color={avatar === id ? colors.accent : colors.muted}
                strokeWidth={1.5}
              />
            </Pressable>
          ))}
        </View>
        <Input
          label={text("昵称", "Name")}
          value={draftName}
          maxLength={40}
          onChangeText={setDraftName}
        />
        <Input
          label={text("简介", "Bio")}
          value={bio}
          maxLength={160}
          multiline
          numberOfLines={3}
          onChangeText={setBio}
          placeholder={text("介绍一下自己", "A little about you")}
        />
        <Action
          label={text("保存", "Save")}
          onPress={save}
          disabled={!draftName.trim()}
        />
      </Sheet>
      <Sheet
        visible={sheet === "theme"}
        title={text("外观", "Appearance")}
        onClose={close}
      >
        <View>
          {themeOptions.map(([id, zh, en], index) => (
            <Row
              key={id}
              title={text(zh, en)}
              right={
                theme === id ? (
                  <Check size={18} color={colors.accent} />
                ) : (
                  <View style={{ width: 18 }} />
                )
              }
              onPress={() => setTheme(id)}
              last={index === 2}
            />
          ))}
        </View>
      </Sheet>
      <Sheet
        visible={sheet === "language"}
        title={text("语言", "Language")}
        onClose={close}
      >
        <View>
          {(
            [
              ["zh", "中文"],
              ["en", "English"],
            ] as const
          ).map(([id, label], index) => (
            <Row
              key={id}
              title={label}
              right={
                locale === id ? (
                  <Check size={18} color={colors.accent} />
                ) : (
                  <View style={{ width: 18 }} />
                )
              }
              onPress={() => setLocale(id)}
              last={index === 1}
            />
          ))}
        </View>
      </Sheet>
      <Sheet
        visible={sheet === "login"}
        title={text("登录", "Sign in")}
        onClose={close}
      >
        <Type size={phone ? 16 : 15} muted>
          {text(
            "仅预览登录流程，请勿填写真实密码。",
            "Sign-in preview only. Do not enter a real password.",
          )}
        </Type>
        <Input
          label={text("账号", "Handle")}
          value={loginHandle}
          onChangeText={setLoginHandle}
          autoCapitalize="none"
          placeholder={text("示例账号", "Example handle")}
        />
        <Input
          label={text("密码", "Password")}
          value={loginPassword}
          onChangeText={setLoginPassword}
          secureTextEntry
          placeholder={text("示例密码", "Example password")}
        />
        <Action label={text("完成预览", "Done")} onPress={close} />
      </Sheet>
    </>
  );
}

const people = [
  {
    id: "lin",
    zh: "小林",
    en: "Lin",
    initial: "L",
    noteZh: "这个周末，一起去看展吗？",
    noteEn: "Want to visit an exhibition this weekend?",
    time: "10:24",
    roleZh: "设计与生活",
    roleEn: "Design & everyday life",
  },
  {
    id: "mia",
    zh: "米娅",
    en: "Mia",
    initial: "M",
    noteZh: "找到一个很棒的灵感插件，分享给你。",
    noteEn: "Found a lovely inspiration plugin to share.",
    time: "09:18",
    roleZh: "寻找日常灵感",
    roleEn: "Finding everyday inspiration",
  },
  {
    id: "alex",
    zh: "阿哲",
    en: "Alex",
    initial: "A",
    noteZh: "新作品做好了，想听听你的想法。",
    noteEn: "My new project is ready. Would love your thoughts.",
    time: "08:42",
    roleZh: "影像创作者",
    roleEn: "Visual creator",
  },
] as const;
type Message = { id: number; body: string };

export function MessagesPage() {
  const reduced = useReducedMotion();
  const { colors, text, phone } = useDesign();
  const conversationScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [tab, setTab] = useState("messages");
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const active = people.find((person) => person.id === activeId);
  const filtered = people.filter((person) =>
    `${person.zh} ${person.en}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const open = (id: string) => {
    setActiveId(id);
    setDraft("");
  };
  const send = () => {
    const body = draft.trim();
    if (!body || !activeId) return;
    setMessages((previous) => ({
      ...previous,
      [activeId]: [...(previous[activeId] ?? []), { id: Date.now(), body }],
    }));
    setDraft("");
  };
  const composer = (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
      <TextInput
        accessibilityLabel={text("消息内容", "Message")}
        value={draft}
        onChangeText={setDraft}
        maxLength={500}
        multiline
        placeholder={text("发消息…", "Message…")}
        placeholderTextColor={colors.faint}
        selectionColor={colors.accent}
        style={{
          flex: 1,
          minHeight: 44,
          maxHeight: 110,
          fontSize: 16,
          lineHeight: 23,
          paddingHorizontal: 14,
          paddingVertical: 11,
          borderRadius: 14,
          backgroundColor: colors.soft,
          color: colors.ink,
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text("发送消息", "Send message")}
        accessibilityState={{ disabled: !draft.trim() }}
        disabled={!draft.trim()}
        onPress={send}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: draft.trim() ? colors.accent : colors.soft,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <ArrowUp
          size={20}
          color={draft.trim() ? colors.onAccent : colors.faint}
        />
      </Pressable>
    </View>
  );
  return (
    <>
      <Page title={text("消息", "Messages")} description="">
        <View style={{ gap: 16, maxWidth: 720, width: "100%" }}>
          <Tabs
            items={[
              { id: "messages", label: text("消息", "Messages") },
              { id: "friends", label: text("好友", "Friends") },
              { id: "notifications", label: text("通知", "Notifications") },
            ]}
            value={tab}
            onChange={(value) => {
              setTab(value);
              setQuery("");
            }}
          />
          {tab !== "notifications" ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 13,
                borderRadius: 12,
                backgroundColor: colors.soft,
              }}
            >
              <Search size={18} color={colors.muted} />
              <TextInput
                accessibilityLabel={text("搜索联系人", "Search contacts")}
                value={query}
                onChangeText={setQuery}
                placeholder={text("搜索联系人", "Search contacts")}
                placeholderTextColor={colors.faint}
                selectionColor={colors.accent}
                autoCapitalize="none"
                style={{
                  flex: 1,
                  minHeight: 44,
                  paddingVertical: 10,
                  fontSize: 16,
                  color: colors.ink,
                }}
              />
            </View>
          ) : null}
          <View>
            {tab === "notifications" ? (
              <>
                <Row
                  icon={Bell}
                  title={text("欢迎来到小Q", "Welcome to Little Q")}
                  subtitle={text(
                    "开启你的第一段对话。",
                    "Start your first conversation.",
                  )}
                />
                <Row
                  icon={ShieldCheck}
                  title={text("设置你的偏好", "Make it yours")}
                  subtitle={text(
                    "在设置中选择外观和语言。",
                    "Choose your appearance and language in Settings.",
                  )}
                  last
                />
              </>
            ) : filtered.length ? (
              filtered.map((person, index) => (
                <Pressable
                  key={person.id}
                  accessibilityRole="button"
                  accessibilityLabel={text(person.zh, person.en)}
                  onPress={() => open(person.id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 13,
                    minHeight: 76,
                    paddingVertical: 15,
                    borderBottomWidth: index === filtered.length - 1 ? 0 : 1,
                    borderColor: colors.line,
                    opacity: pressed ? 0.65 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 15,
                      backgroundColor: colors.soft,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Type size={16} color={colors.accent}>
                      {person.initial}
                    </Type>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <Type size={16} weight="500" style={{ flex: 1 }}>
                        {text(person.zh, person.en)}
                      </Type>
                      {tab === "messages" ? (
                        <Type size={12} muted>
                          {person.time}
                        </Type>
                      ) : null}
                    </View>
                    <Type size={phone ? 16 : 14} muted numberOfLines={1}>
                      {tab === "friends"
                        ? text(person.roleZh, person.roleEn)
                        : (messages[person.id]?.at(-1)?.body ??
                          text(person.noteZh, person.noteEn))}
                    </Type>
                  </View>
                </Pressable>
              ))
            ) : (
              <View
                style={{ paddingVertical: 36, alignItems: "center", gap: 12 }}
              >
                <Type size={16}>
                  {text("没有找到联系人", "No contacts found")}
                </Type>
                <Action
                  kind="ghost"
                  label={text("清空搜索", "Clear search")}
                  onPress={() => setQuery("")}
                />
              </View>
            )}
          </View>
          <Type size={13} muted>
            {text(
              "示例联系人与通知，仅用于预览。",
              "Sample contacts and notifications for this preview.",
            )}
          </Type>
        </View>
      </Page>
      <Sheet
        visible={!!active}
        title={
          active ? text(active.zh, active.en) : text("聊天", "Conversation")
        }
        onClose={() => setActiveId(null)}
        footer={composer}
      >
        <Type size={13} muted>
          {text(
            "示例聊天，不会向他人发送消息。",
            "Sample chat. Messages are not sent to anyone.",
          )}
        </Type>
        <ScrollView
          ref={conversationScroll}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: phone ? 240 : 340 }}
          contentContainerStyle={{ gap: 12, paddingBottom: 4 }}
          onContentSizeChange={() =>
            conversationScroll.current?.scrollToEnd({ animated: !reduced })
          }
        >
          <View
            style={{
              alignSelf: "flex-start",
              maxWidth: "86%",
              padding: 12,
              borderRadius: 14,
              backgroundColor: colors.soft,
            }}
          >
            <Type size={16}>
              {active ? text(active.noteZh, active.noteEn) : ""}
            </Type>
          </View>
          {(activeId ? (messages[activeId] ?? []) : []).map((message) => (
            <View
              key={message.id}
              style={{
                alignSelf: "flex-end",
                maxWidth: "86%",
                padding: 12,
                borderRadius: 14,
                backgroundColor: colors.accentBg,
              }}
            >
              <Type size={16} selectable>
                {message.body}
              </Type>
            </View>
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}
