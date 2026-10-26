import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { useDesign } from '../design';
import type { MascotState } from './mascot-state';

// The cyan glass is Q's brand material, independent of the surrounding UI theme.
// Status badges use the host's semantic colors below.
const bubble = {
  white: '#FFFFFF',
  ice: '#E7FBFF',
  pale: '#BDEFF8',
  cyan: '#59D7EE',
  rim: '#18B5D5',
  deepRim: '#1388B1',
  eye: '#073C5B',
  eyeLight: '#176D91',
};
const body = 'M77 16C43 16 17 42 17 76C17 109 43 135 77 135C91 135 100 129 110 132C119 135 126 143 137 139C149 135 139 122 133 116C126 109 133 103 136 90C144 54 118 16 77 16Z';

function subscribeToForeground(onChange: () => void) {
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
}
const noSubscription = () => () => {};
const readForeground = () => AppState.currentState === 'active';
const serverForeground = () => false;
const AnimatedGroup = Animated.createAnimatedComponent(G);

function Face({ state, eyeFill }: { state: MascotState; eyeFill: string }) {
  const concerned = state === 'error' || state === 'interrupted' || state === 'offline';
  const thinking = state === 'thinking';
  const paused = state === 'paused';
  const eyeY = state === 'offline' ? 82 : thinking ? 74 : 79;
  const eyeHeight = paused ? 5.5 : state === 'interrupted' ? 11 : 9.5;
  const eyeShift = thinking ? 2 : 0;

  if (state === 'complete') {
    return (
      <G stroke={bubble.eye} strokeWidth={3.5} strokeLinecap="round" fill="none">
        <Path d="M49 79Q56 71 63 79M87 79Q94 71 101 79" />
        <Path d="M70 96Q80 110 90 96Q80 100 70 96Z" fill={bubble.eye} strokeWidth={2} />
      </G>
    );
  }

  return (
    <G>
      {[56, 94].map((x) => (
        <G key={x}>
          <Ellipse
            cx={x + eyeShift}
            cy={eyeY}
            rx={state === 'streaming' ? 6.5 : 7}
            ry={eyeHeight}
            fill={eyeFill}
          />
          <Ellipse
            cx={x + eyeShift + 1.8}
            cy={eyeY - eyeHeight * 0.38}
            rx={paused ? 1.7 : 2.4}
            ry={paused ? 1.5 : 2.8}
            fill={bubble.white}
            opacity={0.95}
          />
        </G>
      ))}
      {concerned ? (
        <G stroke={bubble.eye} strokeWidth={2.5} strokeLinecap="round" fill="none" opacity={0.85}>
          <Path d={state === 'error' ? 'M48 67Q55 67 61 62M89 62Q96 66 102 66' : 'M48 68Q55 68 61 64M89 64Q96 68 102 68'} />
          <Path d="M71 101Q80 94 89 101" strokeWidth={3.2} />
        </G>
      ) : thinking ? (
        <G stroke={bubble.eye} strokeWidth={2.8} strokeLinecap="round" fill="none">
          <Path d="M88 59Q94 56 101 59" />
          <Ellipse cx={83} cy={98} rx={3.5} ry={2.6} />
        </G>
      ) : paused ? (
        <Path d="M73 98H87" stroke={bubble.eye} strokeWidth={3.2} strokeLinecap="round" />
      ) : (
        <Path
          d={state === 'streaming' ? 'M72 97Q80 101 88 96' : 'M70 96Q80 106 90 95'}
          stroke={bubble.eye}
          strokeWidth={3.6}
          strokeLinecap="round"
          fill="none"
        />
      )}
    </G>
  );
}

function Badge({ state, activity }: { state: MascotState; activity: SharedValue<number> }) {
  const { colors } = useDesign();
  const activityProps = useAnimatedProps(() => ({ opacity: activity.get() }));
  const color = state === 'complete' ? colors.green
    : state === 'error' || state === 'offline' || state === 'interrupted' ? colors.danger
      : state === 'paused' ? colors.muted : colors.accent;
  return (
    <G>
      <Circle cx={128} cy={29} r={18} fill={colors.surface} stroke={colors.bg} strokeWidth={3} />
      <AnimatedGroup animatedProps={activityProps} transform="translate(116 17)" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        {state === 'ready' ? <Path d="M2 12H6L9 6L13 19L16 12H22" /> : null}
        {state === 'thinking' ? [5, 12, 19].map((x) => <Circle key={x} cx={x} cy={12} r={1.7} fill={color} stroke="none" />) : null}
        {state === 'streaming' ? <Path d="M2 12H21M15 6L21 12L15 18M3 7H7M3 17H7" /> : null}
        {state === 'interrupted' ? <Path d="M2 12H7M15 12H22M17 7L22 12L17 17M12 6L9 11L13 13L10 18" /> : null}
        {state === 'paused' ? <Path d="M8 5V19M16 5V19" strokeWidth={3.5} /> : null}
        {state === 'offline' ? (
          <G>
            <Path d="M2 8Q12 0 22 8M6 12Q12 7 18 12M9 16Q12 13 15 16M3 3L21 21" />
            <Circle cx={12} cy={20} r={1} fill={color} stroke="none" />
          </G>
        ) : null}
        {state === 'error' ? (
          <G>
            <Path d="M12 3L22 21H2ZM12 9V14" />
            <Circle cx={12} cy={17.5} r={1} fill={color} stroke="none" />
          </G>
        ) : null}
        {state === 'complete' ? <Path d="M4 12L9 17L20 6" strokeWidth={2.8} /> : null}
      </AnimatedGroup>
    </G>
  );
}

/** Decorative companion. The neighboring status label supplies its accessible meaning. */
export function QCompanion({
  state = 'ready',
  size = 128,
  animated = false,
  showBadge = true,
}: {
  state?: MascotState;
  size?: number;
  animated?: boolean;
  showBadge?: boolean;
}) {
  const { theme } = useDesign();
  const id = `q-bubble-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reducedAtMount = useReducedMotion();
  const [reduced, setReduced] = useState(reducedAtMount);
  const progress = useSharedValue(0);
  const activity = useSharedValue(1);
  const active = animated && (state === 'thinking' || state === 'streaming');
  const foreground = useSyncExternalStore(active ? subscribeToForeground : noSubscription, readForeground, serverForeground);
  const small = size < 48;

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    }).catch(() => {});
    return () => {
      mounted = false;
      motion.remove();
    };
  }, [active]);

  useEffect(() => {
    cancelAnimation(progress);
    progress.set(0);
    if (active && foreground && !reduced) {
      // Two gentle pulses, 2.6 seconds total; never loop while the user reads.
      progress.set(withRepeat(withTiming(1, {
        duration: 650,
        easing: Easing.inOut(Easing.sin),
        reduceMotion: ReduceMotion.System,
      }), 4, true));
    }
    return () => {
      cancelAnimation(progress);
      progress.set(0);
    };
  }, [active, foreground, progress, reduced, state]);

  useEffect(() => {
    cancelAnimation(activity);
    activity.set(1);
    if (active && foreground && !reduced && showBadge && !small) {
      // Only the live task indicator pulses continuously. A quiet body must not
      // suggest that an ongoing response has stalled after its entrance ends.
      activity.set(withRepeat(withTiming(0.6, {
        duration: 850,
        easing: Easing.inOut(Easing.sin),
        reduceMotion: ReduceMotion.System,
      }), -1, true));
    }
    return () => {
      cancelAnimation(activity);
      activity.set(1);
    };
  }, [active, activity, foreground, reduced, showBadge, small]);

  const motionStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -2 * progress.get() },
      { scale: 1 + progress.get() * 0.012 },
    ],
  }));

  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={[{ width: size, height: size, flexShrink: 0 }, motionStyle]}
    >
      <Svg width={size} height={size} viewBox="0 0 160 160" aria-hidden focusable={false}>
        <Defs>
          <RadialGradient id={`${id}-body`} cx="42%" cy="37%" r="70%">
            <Stop offset="0" stopColor={bubble.ice} stopOpacity={0.96} />
            <Stop offset="0.48" stopColor={bubble.pale} stopOpacity={theme === 'dark' ? 0.94 : 0.8} />
            <Stop offset="0.79" stopColor={bubble.cyan} stopOpacity={0.62} />
            <Stop offset="1" stopColor={bubble.rim} stopOpacity={0.84} />
          </RadialGradient>
          <LinearGradient id={`${id}-rim`} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0" stopColor={bubble.cyan} />
            <Stop offset="0.24" stopColor={bubble.white} />
            <Stop offset="0.45" stopColor={bubble.rim} />
            <Stop offset="0.72" stopColor={bubble.white} />
            <Stop offset="1" stopColor={bubble.cyan} />
          </LinearGradient>
          <LinearGradient id={`${id}-shine`} x1="0%" y1="0%" x2="75%" y2="100%">
            <Stop offset="0" stopColor={bubble.white} stopOpacity={0.96} />
            <Stop offset="1" stopColor={bubble.white} stopOpacity={0.05} />
          </LinearGradient>
          <LinearGradient id={`${id}-eye`} x1="20%" y1="0%" x2="70%" y2="100%">
            <Stop offset="0" stopColor={bubble.eyeLight} />
            <Stop offset="0.38" stopColor={bubble.eye} />
            <Stop offset="1" stopColor={bubble.eyeLight} />
          </LinearGradient>
          <RadialGradient id={`${id}-ground`} cx="50%" cy="50%" rx="50%" ry="50%">
            <Stop offset="0" stopColor={bubble.deepRim} stopOpacity={theme === 'dark' ? 0.22 : 0.14} />
            <Stop offset="1" stopColor={bubble.deepRim} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {!small ? <Ellipse cx={80} cy={149} rx={46} ry={7} fill={`url(#${id}-ground)`} /> : null}
        <Path d={body} fill={`url(#${id}-body)`} stroke={`url(#${id}-rim)`} strokeWidth={2.7} />
        <Path
          d="M27 58C34 33 57 20 81 21C107 21 127 38 132 59"
          fill="none"
          stroke={bubble.white}
          strokeWidth={1.7}
          strokeLinecap="round"
          opacity={0.85}
        />
        <Path
          d="M25 85C30 113 51 128 77 129C92 129 105 122 113 128C122 135 131 138 136 133"
          fill="none"
          stroke={bubble.ice}
          strokeWidth={2.8}
          strokeLinecap="round"
          opacity={0.74}
        />
        <Path
          d="M37 43C44 34 56 28 63 30C70 33 62 43 52 50C42 58 30 55 37 43Z"
          fill={`url(#${id}-shine)`}
        />
        <Path
          d="M106 31C119 37 128 49 129 60C120 50 118 42 106 31Z"
          fill={bubble.white}
          opacity={0.54}
        />
        {!small ? <Path d="M25 67C23 75 25 86 29 91C29 78 28 73 25 67Z" fill={bubble.white} opacity={0.62} /> : null}
        <Face state={state} eyeFill={`url(#${id}-eye)`} />
        {showBadge && !small ? <Badge state={state} activity={activity} /> : null}
      </Svg>
    </Animated.View>
  );
}
