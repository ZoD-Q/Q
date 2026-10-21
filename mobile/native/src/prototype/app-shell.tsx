import { useEffect, useReducer, useState } from "react";
import { AppState, BackHandler, Modal, Pressable, ScrollView, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Reveal, selectionFeedback } from "./motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import {
  MessageCircle,
  Clapperboard,
  ChevronRight,
  CreditCard,
  Code2,
  History,
  KeyRound,
  Layers3,
  Menu,
  PanelLeftClose,
  ShieldCheck,
  SquarePen,
  TrendingUp,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { Divider, IconAction, Type, useDesign, type PageId } from "./design";
import { ChatPage, HistoryPage, type Conversation } from "./chat";
import { ProfilePage } from "./account-pages";
import { ServicePage } from "./services";
import { VideoCreate } from "./video/video-create";
import { CreatorFeed } from "./video/creator-feed";
import { useChat } from "./ai-chat/use-chat";
import { PluginWorkbenchPage } from "./plugin-workbench/workbench";
import { PluginHostPage } from "./plugin-host/page";
import { pluginEntryIntentReducer } from "./plugin-host/core";
import { useQAccount } from "./account/account-state";
import { useSocial } from "./social";

const serviceNavigation: {
  id: PageId;
  zh: string;
  en: string;
  icon: LucideIcon;
}[] = [
  { id: "video", zh: "视频创作", en: "Video studio", icon: Clapperboard },
  { id: "plugins", zh: "插件", en: "Plugins", icon: Layers3 },
  { id: "plugin-workbench", zh: "插件工作台", en: "Plugin workbench", icon: Code2 },
  { id: "installments", zh: "分期", en: "Installments", icon: CreditCard },
  { id: "insurance", zh: "保险", en: "Insurance", icon: ShieldCheck },
  { id: "finance", zh: "理财", en: "Financial services", icon: TrendingUp },
  { id: "wallet", zh: "钱包", en: "Wallet", icon: Wallet },
  { id: "keys", zh: "API 工作台", en: "API workbench", icon: KeyRound },
];
export function QSymbol({ size = 25 }: { size?: number }) {
  const { colors } = useDesign();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size,
        height: size,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <View
        style={{
          width: size * 0.65,
          height: size * 0.65,
          borderWidth: 1.8,
          borderColor: colors.ink,
          borderRadius: size,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: size * 0.35,
          height: 1.8,
          backgroundColor: colors.ink,
          transform: [{ rotate: "45deg" }],
          bottom: size * 0.1,
          right: size * 0.06,
        }}
      />
    </View>
  );
}
function Dots() {
  const { colors } = useDesign();
  return (
    <View
      style={{
        width: 18,
        height: 18,
        gap: 3,
        flexWrap: "wrap",
        flexDirection: "row",
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <View
          key={i}
          style={{
            width: 3.5,
            height: 3.5,
            borderRadius: 1,
            backgroundColor: colors.muted,
          }}
        />
      ))}
    </View>
  );
}
function Sidebar({
  page,
  navigate,
  newChat,
  close,
  items,
  onOpen,
}: {
  page: PageId;
  navigate: (page: PageId) => void;
  newChat: () => void;
  close: () => void;
  items: Conversation[];
  onOpen: (id: string) => void;
}) {
  const { colors, text, name, phone } = useDesign();
  const account = useQAccount();
  const nav = (
    id: PageId,
    label: string,
    Icon: LucideIcon,
    action?: () => void,
  ) => (
    <Pressable
      key={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: page === id }}
      onPress={action ?? (() => navigate(id))}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        minHeight: 45,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor:
          page === id ? colors.accentBg : pressed ? colors.soft : "transparent",
      })}
    >
      <Icon
        size={17}
        strokeWidth={1.5}
        color={page === id ? colors.accent : colors.muted}
      />
      <Type
        size={14}
        color={page === id ? colors.accent : colors.muted}
        weight={page === id ? "500" : "400"}
      >
        {label}
      </Type>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.sidebar }}>
      <View
        style={{
          paddingLeft: 20,
          paddingRight: 9,
          height: 70,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text("账户详情", "Account details")}
          onPress={() => navigate("profile")}
          style={{
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Dots />
          <Type size={16} weight="500">
            小Q
          </Type>
        </Pressable>
        <IconAction
          label={text("收起侧栏", "Collapse sidebar")}
          icon={phone ? X : PanelLeftClose}
          onPress={close}
        />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 13,
          paddingTop: 7,
          paddingBottom: 20,
          gap: 25,
        }}
      >
        <View style={{ gap: 4 }}>
          {nav("chat", text("新聊天", "New chat"), SquarePen, newChat)}
          {nav("history", text("历史记录", "History"), History)}
        </View>
        <View style={{ gap: 8 }}>
          <Type size={11} muted style={{ paddingHorizontal: 12 }}>
            {text("服务", "Services")}
          </Type>
          <View style={{ gap: 3 }}>
            {serviceNavigation.map((item) =>
              nav(item.id, text(item.zh, item.en), item.icon),
            )}
          </View>
        </View>
        {items.length ? (
          <View style={{ gap: 7 }}>
            <Type size={11} muted style={{ paddingHorizontal: 12 }}>
              {text("最近对话", "Recent")}
            </Type>
            {items.slice(0, 3).map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                onPress={() => onOpen(item.id)}
                style={{
                  minHeight: 40,
                  paddingHorizontal: 12,
                  justifyContent: "center",
                }}
              >
                <Type size={12} muted numberOfLines={1}>
                  {item.title}
                </Type>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={{ flex: 1 }} />
      <View
        style={{ paddingHorizontal: 23, paddingBottom: 12, paddingTop: 10 }}
      >
        <Divider />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text("个人资料与设置", "Profile and settings")}
          onPress={() => navigate("profile")}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minHeight: 70,
          }}
        >
          <View
            style={{
              height: 32,
              width: 32,
              borderRadius: 18,
              backgroundColor: colors.line,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Type size={13} weight="500">
              {name.slice(0, 1)}
            </Type>
          </View>
          <View style={{ flex: 1 }}>
            <Type size={13} weight="500">
              {account.session?.user.display_name ?? text("账号", "Account")}
            </Type>
            <Type size={11} muted>
              {account.session ? `@${account.session.user.handle}` : text("登录以继续", "Sign in to continue")}
            </Type>
          </View>
          <ChevronRight size={15} color={colors.faint} />
        </Pressable>
        <Type size={10} muted>
          {text("小Q · 设计预览", "Q · Design preview")}
        </Type>
      </View>
    </View>
  );
}
function Rail({
  page,
  navigate,
  newChat,
  expand,
}: {
  page: PageId;
  navigate: (page: PageId) => void;
  newChat: () => void;
  expand: () => void;
}) {
  const { colors, text, name } = useDesign();
  const [hover, setHover] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const entries = [
    { id: "chat" as PageId, zh: "新聊天", en: "New chat", icon: SquarePen },
    { id: "history" as PageId, zh: "历史记录", en: "History", icon: History },
    ...serviceNavigation,
  ];
  const selected = entries.find((item) => item.id === hover);
  const hoverIndex = entries.findIndex((item) => item.id === hover);
  return (
    <View
      style={{
        width: 76,
        backgroundColor: colors.sidebar,
        alignItems: "center",
        paddingTop: 14,
        paddingBottom: 18,
        gap: 17,
        zIndex: 10,
      }}
    >
      <IconAction
        label={text("展开侧栏", "Expand sidebar")}
        icon={Menu}
        onPress={expand}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, width: "100%" }}
        contentContainerStyle={{
          gap: 9,
          alignItems: "center",
          paddingBottom: 10,
        }}
        scrollEventThrottle={16}
        onScroll={(event) => {
          setOffset(event.nativeEvent.contentOffset.y);
          setHover(null);
        }}
      >
        {entries.map((item, index) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={text(item.zh, item.en)}
            accessibilityState={{ selected: page === item.id }}
            onHoverIn={() => setHover(item.id)}
            onHoverOut={() => setHover(null)}
            onFocus={() => setHover(item.id)}
            onBlur={() => setHover(null)}
            onPress={() => (item.id === "chat" ? newChat() : navigate(item.id))}
            style={({ pressed }) => ({
              marginTop: index === 2 ? 13 : 0,
              width: 44,
              height: 44,
              borderRadius: 14,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor:
                page === item.id
                  ? colors.accentBg
                  : pressed
                    ? colors.soft
                    : "transparent",
            })}
          >
            <item.icon
              size={20}
              strokeWidth={1.6}
              color={page === item.id ? colors.accent : colors.muted}
            />
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text("个人资料与设置", "Profile and settings")}
        onPress={() => navigate("profile")}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.soft,
        }}
      >
        <Type size={15} weight="500" color={colors.muted}>
          {name.slice(0, 1)}
        </Type>
      </Pressable>
      {selected ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 68,
            top: Math.max(
              70,
              81 + hoverIndex * 53 + (hoverIndex >= 2 ? 13 : 0) - offset,
            ),
            backgroundColor: colors.ink,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 9,
            minWidth: 95,
          }}
        >
          <Type color={colors.bg} size={12}>
            {text(selected.zh, selected.en)}
          </Type>
        </View>
      ) : null}
    </View>
  );
}
export function PrototypeApp({ initialPage = "chat" }: { initialPage?: PageId }) {
  const { colors, text, phone, notice, notify } = useDesign();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<PageId>(initialPage);
  const [sidebar, setSidebar] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [pendingPluginIntent, updatePluginIntent] = useReducer(pluginEntryIntentReducer, null);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const social = useSocial();
  const active = focused && foreground;
  const chat = useChat(active && (page === "chat" || page === "plugins"));
  const items = chat.items;
  const reduced = useReducedMotion();
  const navigate = (next: PageId) => {
    selectionFeedback();
    setPage(next);
    setDrawer(false);
  };
  const newChat = () => { chat.newConversation(); navigate("chat"); };
  const open = (id: string) => { chat.openConversation(id); navigate("chat"); };
  useEffect(() => {
    const subscription = AppState.addEventListener("change", value => setForeground(value === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => notify(""), 4000);
    return () => clearTimeout(timer);
  }, [notice, notify]);
  useEffect(() => {
    if (process.env.EXPO_OS !== "android" || !focused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (drawer) {
        setDrawer(false);
        return true;
      }
      if (page !== "chat") {
        setPage(page === "creators" ? "video" : page === "plugin-workbench" ? "plugins" : "chat");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [drawer, page, focused]);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        flexDirection: "row",
      }}
    >
      {!phone ? (
        sidebar ? (
          <View style={{ width: 208 }}>
            <Sidebar
              {...{ page, navigate, newChat, items }}
              onOpen={open}
              close={() => setSidebar(false)}
            />
          </View>
        ) : (
          <Rail
            page={page}
            navigate={navigate}
            newChat={newChat}
            expand={() => setSidebar(true)}
          />
        )
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View
          style={{
            height: phone ? 60 : 70,
            paddingLeft: phone ? 12 : sidebar ? 26 : 14,
            paddingRight: phone ? 12 : 26,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: phone ? 4 : 10,
              flex: 1,
              minWidth: 0,
            }}
          >
            {phone ? (
              <IconAction
                label={text("打开侧栏", "Open sidebar")}
                icon={Menu}
                onPress={() => (phone ? setDrawer(true) : setSidebar(true))}
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("回到新聊天", "Back to new chat")}
              onPress={newChat}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                minHeight: 44,
              }}
            >
              {phone ? <QSymbol size={22} /> : null}
              <Type size={phone ? 12 : 13} muted>
                Q makes kai smile
              </Type>
            </Pressable>
          </View>
          <View>
            <IconAction
              icon={MessageCircle}
              label={social.unreadCount ? text(`消息，${social.unreadCount} 条未读`, `Messages, ${social.unreadCount} unread`) : text("消息", "Messages")}
              onPress={() => { selectionFeedback(); setDrawer(false); router.push("/social"); }}
            />
            {social.unreadCount > 0 ? <View pointerEvents="none" accessibilityElementsHidden
              style={{ position: "absolute", top: 3, right: 2, minWidth: 18, minHeight: 18, paddingHorizontal: 4,
                borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
              <Type size={10} color={colors.onAccent}>{social.unreadCount > 99 ? "99+" : String(social.unreadCount)}</Type>
            </View> : null}
          </View>
        </View>
        <Reveal key={page} style={{ flex: 1 }}>
          {!active ? <View style={{ flex: 1 }} /> : page === "chat" ? (
            <ChatPage controller={chat} onOpenPlugins={() => navigate("plugins")} />
          ) : page === "video" ? (
            <VideoCreate onOpenFeed={() => navigate("creators")} onOpenApi={() => navigate("keys")} />
          ) : page === "creators" ? (
            <CreatorFeed onBack={() => navigate("video")} />
          ) : page === "history" ? (
            <HistoryPage items={items} onOpen={open} onNew={newChat} />
          ) : page === "profile" ? (
            <ProfilePage />
          ) : page === "plugin-workbench" ? (
            <PluginWorkbenchPage onBack={() => navigate("plugins")} onConnect={intent => { updatePluginIntent({ type: "received", intent }); navigate("plugins"); }} />
          ) : page === "plugins" ? (
            <PluginHostPage chat={chat} initialIntent={pendingPluginIntent} onIntentHandled={(intent, outcome) => updatePluginIntent({ type: "settled", intent, outcome })} onOpenWorkbench={() => navigate("plugin-workbench")} onSelect={connection => { chat.selectPlugin({ id: connection.id, title: connection.title || connection.name, endpoint_url: connection.endpoint_url }); navigate("chat"); }} />
          ) : (
            <ServicePage page={page} onOpenWorkbench={() => navigate("plugin-workbench")} />
          )}
        </Reveal>
      </View>
      <Modal
        transparent
        visible={phone && drawer}
        animationType={reduced ? "none" : "fade"}
        onRequestClose={() => setDrawer(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "#15253128",
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
            flexDirection: "row",
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("关闭侧栏", "Close sidebar")}
            onPress={() => setDrawer(false)}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            }}
          />
          <View
            style={{
              width: "83%",
              maxWidth: 300,
              backgroundColor: colors.sidebar,
              borderTopRightRadius: 16,
              borderBottomRightRadius: 16,
              overflow: "hidden",
            }}
          >
            <Sidebar
              {...{ page, navigate, newChat, items }}
              onOpen={open}
              close={() => setDrawer(false)}
            />
          </View>
        </View>
      </Modal>
      {!!notice ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            bottom: insets.bottom + 24,
            left: 20,
            right: 20,
            alignItems: "center",
          }}
        >
          <View
            accessibilityRole="alert"
            style={{
              paddingLeft: 17,
              paddingRight: 8,
              paddingVertical: 7,
              maxWidth: 520,
              backgroundColor: colors.ink,
              borderRadius: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Type color={colors.bg} size={13} style={{ flexShrink: 1 }}>
              {notice}
            </Type>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("关闭提示", "Dismiss notice")}
              onPress={() => notify("")}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <X size={17} color={colors.bg} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
