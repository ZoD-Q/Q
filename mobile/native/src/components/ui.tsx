import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { Leaf, Orbit, Sparkles, Waves, type LucideIcon } from 'lucide-react-native';
import type { AvatarName } from '@xiaoq/shared';
import { useApp } from '@/providers/app-provider';

export function Type({ children, size = 14, weight = '400', muted = false, color, style, selectable = false, ...rest }: { children: ReactNode; size?: number; weight?: TextStyle['fontWeight']; muted?: boolean; color?: string; style?: StyleProp<TextStyle>; selectable?: boolean; accessibilityRole?: 'header' }) {
  const { colors } = useApp();
  return <Text selectable={selectable} style={[{ color: color || (muted ? colors.muted : colors.text), fontSize: size, fontWeight: weight, lineHeight: size * 1.5 }, style]} {...rest}>{children}</Text>;
}
export function Button({ label, onPress, icon: Icon, variant = 'primary', loading, disabled, style, testID }: { label: string; onPress: () => void; icon?: LucideIcon; variant?: 'primary' | 'secondary' | 'ghost'; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; testID?: string }) {
  const { colors } = useApp();
  const foreground = variant === 'primary' ? colors.inverse : colors.text;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled || !!loading, busy: !!loading }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [{ minHeight: 46, borderRadius: 12, borderCurve: 'continuous', paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: variant === 'primary' ? colors.text : variant === 'secondary' ? colors.surface : 'transparent', borderWidth: variant === 'secondary' ? 1 : 0, borderColor: colors.line, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }, style]}>
    {loading ? <ActivityIndicator size="small" color={foreground} /> : Icon ? <Icon size={17} color={foreground} strokeWidth={1.7} /> : null}
    <Type weight="600" color={foreground}>{label}</Type>
  </Pressable>;
}
export function IconButton({ label, onPress, icon: Icon, active = false }: { label: string; onPress: () => void; icon: LucideIcon; active?: boolean }) {
  const { colors } = useApp();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: active || pressed ? colors.subtle : 'transparent' })}><Icon size={21} strokeWidth={1.6} color={colors.text} /></Pressable>;
}
export function Input({ label, hint, style, ...props }: TextInputProps & { label: string; hint?: string }) {
  const { colors } = useApp();
  return <View style={{ gap: 8 }}>
    <Type size={13} weight="600">{label}</Type>
    <TextInput {...props} accessibilityLabel={label} placeholderTextColor={colors.soft} selectionColor={colors.accent} style={[{ minHeight: 49, borderWidth: 1, borderColor: colors.line, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 12, color: colors.text, fontSize: 15, backgroundColor: colors.surface, textAlignVertical: props.multiline ? 'top' : 'center' }, style]} />
    {hint ? <Type size={11} muted>{hint}</Type> : null}
  </View>;
}
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'accent' }) {
  const { colors } = useApp();
  return <View style={{ alignSelf: 'flex-start', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: tone === 'green' ? colors.successSoft : tone === 'accent' ? colors.accentSoft : colors.subtle }}><Type size={10} weight="600" color={tone === 'green' ? colors.success : tone === 'accent' ? colors.accent : colors.muted}>{children}</Type></View>;
}
export function Notice({ text, success = false }: { text: string; success?: boolean }) {
  const { colors } = useApp();
  return <View accessibilityRole="alert" style={{ padding: 14, borderRadius: 11, backgroundColor: success ? colors.successSoft : colors.dangerSoft }}><Type selectable size={13} color={success ? colors.success : colors.danger}>{text}</Type></View>;
}
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useApp();
  return <View style={[{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 20, borderCurve: 'continuous', padding: 25, gap: 20 }, style]}>{children}</View>;
}
export function Avatar({ name = 'orbit', size = 42, selected = false }: { name?: AvatarName; size?: number; selected?: boolean }) {
  const { colors } = useApp();
  const Icon = { orbit: Orbit, leaf: Leaf, spark: Sparkles, wave: Waves }[name];
  return <View style={{ width: size, height: size, borderRadius: size * .34, backgroundColor: selected ? colors.accentSoft : colors.subtle, alignItems: 'center', justifyContent: 'center' }}><Icon size={size * .51} strokeWidth={1.4} color={selected ? colors.accent : colors.text} /></View>;
}
export function QMark({ size = 34, inverse = false }: { size?: number; inverse?: boolean }) {
  const { colors } = useApp();
  const color = inverse ? colors.walletText : colors.text;
  return <View accessibilityElementsHidden style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: size * .64, height: size * .64, borderRadius: size, borderWidth: size * .085, borderColor: color }} />
    <View style={{ position: 'absolute', width: size * .36, height: size * .085, backgroundColor: color, borderRadius: 4, transform: [{ rotate: '43deg' }], right: size * .045, bottom: size * .12 }} />
  </View>;
}
export function DotGrid() {
  const { colors } = useApp();
  return <View style={{ width: 17, height: 17, flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>{Array.from({ length: 9 }, (_, i) => <View key={i} style={{ width: 3.5, height: 3.5, borderRadius: 1, backgroundColor: colors.text }} />)}</View>;
}
