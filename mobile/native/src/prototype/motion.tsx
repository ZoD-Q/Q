import { type ReactNode } from "react";
import { type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

/** Small, interaction-driven motion. Never add looping decoration to the reading surface. */
export function Reveal({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
export function usePressMotion() {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return {
    style,
    onPressIn: () => {
      scale.set(
        withTiming(0.975, { duration: 90, reduceMotion: ReduceMotion.System }),
      );
    },
    onPressOut: () => {
      scale.set(
        withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System }),
      );
    },
  };
}
export function selectionFeedback() {
  if (process.env.EXPO_OS === "ios")
    void Haptics.selectionAsync().catch(() => {});
}
