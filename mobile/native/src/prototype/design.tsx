import { createContext, use, useState, type ReactNode } from "react";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { selectionFeedback, usePressMotion } from "./motion";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  Text as NativeText,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  type TextInputProps,
} from "react-native";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type PageId =
  | "video"
  | "creators"
  | "chat"
  | "history"
  | "plugins"
  | "market-data"
  | "plugin-workbench"
  | "installments"
  | "insurance"
  | "finance"
  | "wallet"
  | "keys"
  | "profile";
export type ThemeId = "warm" | "light" | "dark";
export type LocaleId = "zh" | "en";
export interface Colors {
  bg: string;
  sidebar: string;
  surface: string;
  soft: string;
  line: string;
  ink: string;
  muted: string;
  faint: string;
  accent: string;
  accentBg: string;
  onAccent: string;
  green: string;
  greenBg: string;
  danger: string;
}
export const themes: Record<ThemeId, Colors> = {
  warm: {
    bg: "#FAF9F5",
    sidebar: "#F0EEE8",
    surface: "#FFFFFF",
    soft: "#F3F1EB",
    line: "#E3E0D8",
    ink: "#282720",
    muted: "#6D6B63",
    faint: "#8C8980",
    accent: "#AD573D",
    accentBg: "#F3E6DD",
    onAccent: "#FFFFFF",
    green: "#566D4B",
    greenBg: "#EAF0E5",
    danger: "#A13B32",
  },
  light: {
    bg: "#FFFFFF",
    sidebar: "#F7F9FA",
    surface: "#FFFFFF",
    soft: "#F4F7F9",
    line: "#E9EEF1",
    ink: "#202B33",
    muted: "#65737E",
    faint: "#7C8892",
    accent: "#087FA3",
    accentBg: "#EAF6FA",
    onAccent: "#FFFFFF",
    green: "#307968",
    greenBg: "#EDF7F3",
    danger: "#B74444",
  },
  dark: {
    bg: "#151C22",
    sidebar: "#11181D",
    surface: "#1B252D",
    soft: "#202C35",
    line: "#2E3A43",
    ink: "#EDF4F7",
    muted: "#A7B5BE",
    faint: "#7F929F",
    accent: "#72CBE5",
    accentBg: "#193944",
    onAccent: "#112B35",
    green: "#98D4BF",
    greenBg: "#1F382F",
    danger: "#F1A1A1",
  },
};
type DesignState = {
  theme: ThemeId;
  setTheme: (value: ThemeId) => void;
  locale: LocaleId;
  setLocale: (value: LocaleId) => void;
  colors: Colors;
  text: (zh: string, en: string) => string;
  phone: boolean;
  width: number;
  notice: string;
  notify: (text: string) => void;
  name: string;
  setName: (value: string) => void;
  profileBio: string;
  setProfileBio: (value: string) => void;
  profileAvatar: string;
  setProfileAvatar: (value: string) => void;
};
const Context = createContext<DesignState | null>(null);
export function DesignProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>("light");
  const [locale, setLocale] = useState<LocaleId>("zh");
  const [name, setName] = useState("访客");
  const [profileBio, setProfileBio] = useState("");
  const [profileAvatar, setProfileAvatar] = useState("orbit");
  const [notice, setNotice] = useState("");
  const { width } = useWindowDimensions();
  return (
    <Context
      value={{
        theme,
        setTheme,
        locale,
        setLocale,
        colors: themes[theme],
        text: (zh, en) => (locale === "zh" ? zh : en),
        phone: width < 760,
        width,
        notice,
        notify: setNotice,
        name,
        setName,
        profileBio,
        setProfileBio,
        profileAvatar,
        setProfileAvatar,
      }}
    >
      {children}
    </Context>
  );
}
export function useDesign() {
  const value = use(Context);
  if (!value) throw new Error("DesignProvider missing");
  return value;
}

export function Type({
  children,
  size = 15,
  weight = "400",
  muted = false,
  color,
  serif = false,
  mono = false,
  style,
  selectable = false,
  numberOfLines,
  header = false,
}: {
  children: ReactNode;
  size?: number;
  weight?: TextStyle["fontWeight"];
  muted?: boolean;
  color?: string;
  serif?: boolean;
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  numberOfLines?: number;
  header?: boolean;
}) {
  const { colors } = useDesign();
  const fontFamily = serif
    ? process.env.EXPO_OS === "ios"
      ? "Songti SC"
      : process.env.EXPO_OS === "android"
        ? "serif"
        : 'Georgia, "Songti SC", "SimSun", serif'
    : mono
      ? process.env.EXPO_OS === "ios"
        ? "Menlo"
        : process.env.EXPO_OS === "android"
          ? "monospace"
          : "ui-monospace, SFMono-Regular, Menlo, monospace"
      : undefined;
  return (
    <NativeText
      accessibilityRole={header ? "header" : undefined}
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[
        {
          fontSize: size,
          fontWeight: weight,
          lineHeight: size * (serif ? 1.35 : 1.55),
          color: color ?? (muted ? colors.muted : colors.ink),
          fontFamily,
        },
        style,
      ]}
    >
      {children}
    </NativeText>
  );
}
export function Action({
  label,
  onPress,
  icon: Icon,
  kind = "primary",
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: LucideIcon;
  kind?: "primary" | "secondary" | "ghost" | "accent";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useDesign();
  const motion = usePressMotion();
  const fill =
    kind === "primary" || kind === "accent"
      ? colors.accent
      : kind === "secondary"
        ? colors.soft
        : "transparent";
  const color =
    kind === "primary" || kind === "accent" ? colors.onAccent : colors.ink;
  return (
    <Animated.View style={[style, motion.style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          selectionFeedback();
          onPress();
        }}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        style={{
          minHeight: 46,
          paddingHorizontal: 18,
          paddingVertical: 11,
          borderRadius: 13,
          backgroundColor: fill,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {Icon ? <Icon size={16} strokeWidth={1.7} color={color} /> : null}
        <Type size={14} weight="500" color={color}>
          {label}
        </Type>
      </Pressable>
    </Animated.View>
  );
}
export function IconAction({
  label,
  icon: Icon,
  onPress,
  selected = false,
  disabled = false,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed || selected ? colors.accentBg : "transparent",
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Icon size={19} strokeWidth={1.6} color={colors.muted} />
    </Pressable>
  );
}
export function Tag({
  children,
  accent = false,
}: {
  children: ReactNode;
  accent?: boolean;
}) {
  const { colors } = useDesign();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: 6,
        paddingHorizontal: 7,
        paddingVertical: 2,
        backgroundColor: accent ? colors.accentBg : colors.soft,
      }}
    >
      <Type size={11} color={accent ? colors.accent : colors.muted}>
        {children}
      </Type>
    </View>
  );
}
export function Divider() {
  const { colors } = useDesign();
  return <View style={{ height: 1, backgroundColor: colors.line }} />;
}
export function Input({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const { colors } = useDesign();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Type size={13} weight="500">
        {label}
      </Type>
      <TextInput
        {...props}
        accessibilityLabel={label}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        placeholderTextColor={colors.faint}
        selectionColor={colors.accent}
        style={[
          {
            minHeight: 48,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 16,
            color: colors.ink,
            backgroundColor: colors.soft,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: focused ? colors.accent : "transparent",
            textAlignVertical: props.multiline ? "top" : "center",
          },
          props.style,
        ]}
      />
      {hint ? (
        <Type size={12} muted>
          {hint}
        </Type>
      ) : null}
    </View>
  );
}
export function Choice({
  label,
  selected,
  onPress,
  disabled = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useDesign();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: disabled ? 0.5 : 1,
        minHeight: 44,
        paddingVertical: 10,
        paddingHorizontal: 15,
        borderRadius: 11,
        backgroundColor: selected
          ? colors.accentBg
          : pressed
            ? colors.soft
            : "transparent",
        borderWidth: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      })}
    >
      <Type
        style={{ flexShrink: 1, minWidth: 0 }}
        size={13}
        weight={selected ? "500" : "400"}
        muted={!selected}
      >
        {label}
      </Type>
      {selected ? <Check size={13} color={colors.accent} /> : null}
    </Pressable>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { colors } = useDesign();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 24 }}
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: item.id === value }}
          onPress={() => onChange(item.id)}
          style={{
            paddingVertical: 13,
            borderBottomWidth: 2,
            borderBottomColor: item.id === value ? colors.ink : "transparent",
            minHeight: 46,
          }}
        >
          <Type
            size={14}
            weight={item.id === value ? "500" : "400"}
            muted={item.id !== value}
          >
            {item.label}
          </Type>
        </Pressable>
      ))}
    </ScrollView>
  );
}
export function Surface({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useDesign();
  return (
    <View
      style={[
        {
          backgroundColor: colors.soft,
          borderRadius: 16,
          borderWidth: 0,
          padding: 22,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function Page({
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { phone } = useDesign();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: phone ? 24 : 48,
        paddingTop: phone ? 20 : 35,
        paddingBottom: 48,
        maxWidth: 1010,
        width: "100%",
        alignSelf: "center",
        gap: 26,
      }}
    >
      <View style={{ gap: 7 }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <Type
            size={phone ? 27 : 31}
            weight="600"
            header
            style={{ letterSpacing: -0.6 }}
          >
            {title}
          </Type>
          {action}
        </View>
        {description ? (
          <Type size={14} muted style={{ maxWidth: 580, lineHeight: 23 }}>
            {description}
          </Type>
        ) : null}
      </View>
      {children}
    </ScrollView>
  );
}
export function Row({
  title,
  subtitle,
  icon: Icon,
  onPress,
  right,
  last = false,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  onPress?: () => void;
  right?: ReactNode;
  last?: boolean;
}) {
  const { colors, phone } = useDesign();
  const body = (
    <>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          gap: 15,
          alignItems: "center",
          minWidth: 0,
        }}
      >
        {Icon ? (
          <View
            style={{
              width: 40,
              height: 40,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              backgroundColor: colors.soft,
            }}
          >
            <Icon size={19} color={colors.muted} strokeWidth={1.5} />
          </View>
        ) : null}
        <View style={{ flex: 1, gap: 4 }}>
          <Type size={phone ? 16 : 15} weight="500">
            {title}
          </Type>
          {subtitle ? (
            <Type size={13} muted>
              {subtitle}
            </Type>
          ) : null}
        </View>
      </View>
      {right ??
        (onPress ? <ChevronRight size={17} color={colors.faint} /> : null)}
    </>
  );
  const style: ViewStyle = {
    paddingVertical: 17,
    borderBottomWidth: last ? 0 : 1,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  };
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [style, { opacity: pressed ? 0.65 : 1 }]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}
export function Sheet({
  visible,
  title,
  children,
  onClose,
  onShow,
  onDismiss,
  wide = false,
  footer,
  automaticallyAdjustKeyboardInsets = true,
}: {
  visible: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onShow?: () => void;
  onDismiss?: () => void;
  wide?: boolean;
  footer?: ReactNode;
  automaticallyAdjustKeyboardInsets?: boolean;
}) {
  const { colors, phone, text } = useDesign();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  return (
    <Modal
      transparent
      visible={visible}
      animationType={
        reduced || process.env.EXPO_OS === "web" ? "none" : "slide"
      }
      onRequestClose={onClose}
      onShow={onShow}
      onDismiss={onDismiss}
    >
      <KeyboardAvoidingView
        behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          backgroundColor: "#15253128",
          justifyContent: phone ? "flex-end" : "center",
          alignItems: "center",
          paddingHorizontal: phone ? 0 : 28,
          paddingTop: insets.top + 24,
          paddingBottom: phone ? 0 : 24,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text("关闭弹窗", "Close dialog")}
          onPress={onClose}
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: wide ? 720 : 500,
            maxHeight: "90%",
            backgroundColor: colors.bg,
            borderRadius: phone ? 28 : 22,
            paddingBottom: insets.bottom,
            overflow: "hidden",
          }}
        >
          {phone ? (
            <View style={{ alignItems: "center", paddingTop: 9 }}>
              <View
                style={{
                  width: 32,
                  height: 4,
                  borderRadius: 4,
                  backgroundColor: colors.line,
                }}
              />
            </View>
          ) : null}
          <View
            style={{
              paddingLeft: 24,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: 4,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Type size={18} weight="600" style={{ flex: 1 }}>
              {title}
            </Type>
            <IconAction
              icon={X}
              label={text("关闭", "Close")}
              onPress={onClose}
            />
          </View>
          <ScrollView
            automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 24, paddingTop: 16, gap: 20 }}
          >
            {children}
          </ScrollView>
          {footer ? (
            <View
              style={{
                paddingHorizontal: 24,
                paddingVertical: 12,
                borderTopWidth: 1,
                borderColor: colors.line,
              }}
            >
              {footer}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
export function Back({ onPress }: { onPress: () => void }) {
  const { text } = useDesign();
  return (
    <Action
      label={text("返回", "Back")}
      icon={ArrowLeft}
      kind="ghost"
      onPress={onPress}
      style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}
    />
  );
}
