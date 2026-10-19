import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { Type, useDesign } from "../design";

export function Button({ label, onPress, disabled, kind = "primary", icon: Icon }: {
  label: string; onPress: () => void; disabled?: boolean; kind?: "primary" | "secondary" | "ghost" | "danger"; icon?: LucideIcon;
}) {
  const { colors } = useDesign();
  const foreground = kind === "primary" ? colors.onAccent : kind === "danger" ? colors.danger : colors.ink;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8,
      backgroundColor: kind === "primary" ? colors.accent : kind === "secondary" ? colors.soft : "transparent", opacity: disabled ? 0.45 : pressed ? 0.7 : 1 })}>
    {Icon ? <Icon size={18} color={foreground} aria-hidden /> : null}
    <Type size={14} weight="500" color={foreground} style={{ flexShrink: 1, textAlign: "center" }}>{label}</Type>
  </Pressable>;
}

export function Option({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const { colors } = useDesign();
  return <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
      backgroundColor: selected ? colors.accentBg : colors.soft, opacity: disabled ? 0.45 : pressed ? 0.65 : 1 })}>
    <Type size={14} color={selected ? colors.accent : colors.muted} weight={selected ? "600" : "400"}>{label}</Type>
  </Pressable>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const { colors } = useDesign();
  return <View accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion="polite" style={{ padding: 16, borderRadius: 12, backgroundColor: colors.soft, gap: 12 }}>
    <Type selectable size={14} color={error ? colors.danger : colors.muted}>{children}</Type>
  </View>;
}
