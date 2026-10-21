import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, PanResponder, Pressable, View } from 'react-native';
import { ArrowRight, Check } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Type, useDesign } from '../design';

const THUMB_SIZE = 56;
const TRACK_PADDING = 4;
const CONFIRM_THRESHOLD = 0.85;

/** A deliberate simulated-bank confirmation; both controls share one synchronous latch. */
export function SlideConfirm({ disabled = false, busy = false, onConfirm }: {
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const { colors, text } = useDesign();
  const reduced = useReducedMotion();
  const [position] = useState(() => new Animated.Value(0));
  const travel = useRef(0);
  const dragging = useRef(false);
  const confirmed = useRef(false);
  const wasBusy = useRef(false);
  const mounted = useRef(true);
  const [width, setWidth] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [responder, setResponder] = useState<ReturnType<typeof PanResponder.create> | null>(null);
  const latest = useRef({ disabled, busy, onConfirm, reduced });
  useLayoutEffect(() => { latest.current = { disabled, busy, onConfirm, reduced }; }, [disabled, busy, onConfirm, reduced]);

  const returnToStart = useCallback(() => {
    dragging.current = false;
    position.stopAnimation();
    if (latest.current.reduced) position.setValue(0);
    else Animated.spring(position, { toValue: 0, stiffness: 280, damping: 28, mass: 1, useNativeDriver: false }).start();
  }, [position]);

  const confirm = useCallback(() => {
    if (!mounted.current || latest.current.disabled || latest.current.busy || confirmed.current) return;
    confirmed.current = true;
    dragging.current = false;
    position.stopAnimation();
    position.setValue(travel.current);
    setSubmitted(true);
    try {
      latest.current.onConfirm();
    } catch (error) {
      confirmed.current = false;
      if (mounted.current) setSubmitted(false);
      returnToStart();
      throw error;
    }
  }, [position, returnToStart]);

  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      dragging.current = false;
    } else if (wasBusy.current) {
      // A failed attempt can be retried after its owner finishes handling it.
      // A successful attempt is replaced by its receipt in the parent view.
      wasBusy.current = false;
      confirmed.current = false;
      setSubmitted(false);
      returnToStart();
    }
    if (disabled && !confirmed.current) returnToStart();
  }, [busy, disabled, returnToStart]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dragging.current = false; position.stopAnimation(); };
  }, [position]);

  useEffect(() => { setResponder(PanResponder.create({
    onStartShouldSetPanResponder: () => !latest.current.disabled && !latest.current.busy && !confirmed.current && travel.current > 0,
    onMoveShouldSetPanResponder: (_event, gesture) => !latest.current.disabled && !latest.current.busy && !confirmed.current && travel.current > 0 && gesture.dx > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderGrant: () => {
      if (latest.current.disabled || latest.current.busy || confirmed.current) return;
      position.stopAnimation();
      position.setValue(0);
      dragging.current = true;
    },
    onPanResponderMove: (_event, gesture) => {
      if (!dragging.current) return;
      if (latest.current.disabled || latest.current.busy || gesture.numberActiveTouches !== 1 || Math.abs(gesture.dy) > THUMB_SIZE) {
        returnToStart();
        return;
      }
      position.setValue(Math.max(0, Math.min(travel.current, gesture.dx)));
    },
    onPanResponderRelease: (_event, gesture) => {
      if (!dragging.current) return;
      dragging.current = false;
      if (!latest.current.disabled && !latest.current.busy && travel.current > 0 && gesture.dx >= travel.current * CONFIRM_THRESHOLD && Math.abs(gesture.dy) <= THUMB_SIZE) confirm();
      else returnToStart();
    },
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: () => { if (dragging.current) returnToStart(); },
  })); }, [confirm, position, returnToStart]);

  const unavailable = disabled || busy || submitted;
  const distance = Math.max(1, width - THUMB_SIZE - TRACK_PADDING * 2);
  const labelOpacity = position.interpolate({ inputRange: [0, distance * 0.55, distance], outputRange: [1, 0.15, 0], extrapolate: 'clamp' });
  const actionLabel = text('点击确认模拟转账', 'Click to confirm demo transfer');

  return <View style={{ gap: 4 }}>
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      onLayout={event => {
        const nextWidth = event.nativeEvent.layout.width;
        if (nextWidth === width) return;
        travel.current = Math.max(0, nextWidth - THUMB_SIZE - TRACK_PADDING * 2);
        setWidth(nextWidth);
        if (confirmed.current) position.setValue(travel.current);
        else returnToStart();
      }}
      style={{ minHeight: THUMB_SIZE + TRACK_PADDING * 2, borderRadius: 32, overflow: 'hidden', backgroundColor: colors.accentBg, opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: Animated.add(position, THUMB_SIZE + TRACK_PADDING * 2), backgroundColor: colors.accent, opacity: 0.12 }} />
      <Animated.View pointerEvents="none" style={{ minHeight: THUMB_SIZE + TRACK_PADDING * 2, paddingLeft: THUMB_SIZE + 18, paddingRight: 20, paddingVertical: 8, justifyContent: 'center', opacity: labelOpacity }}>
        <Type size={14} weight="600" color={colors.accent} style={{ textAlign: 'center' }}>{text('向右滑动，确认模拟转账', 'Slide right to confirm demo transfer')}</Type>
      </Animated.View>
      <Animated.View
        {...responder?.panHandlers}
        pointerEvents={unavailable ? 'none' : 'auto'}
        style={{ position: 'absolute', top: TRACK_PADDING, left: TRACK_PADDING, width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: THUMB_SIZE / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, transform: [{ translateX: position }] }}
      >
        {busy ? <ActivityIndicator color={colors.onAccent} /> : submitted ? <Check size={25} color={colors.onAccent} aria-hidden /> : <ArrowRight size={25} color={colors.onAccent} aria-hidden />}
      </Animated.View>
    </View>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={actionLabel}
      accessibilityHint={text('确认后更新服务端模拟账户，不会转移真实资金。', 'Updates server-side simulated accounts only. No real money is transferred.')}
      accessibilityState={{ disabled: unavailable, busy }}
      disabled={unavailable}
      onPress={confirm}
      style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: pressed ? colors.accentBg : 'transparent', opacity: disabled ? 0.45 : 1 })}
    >
      <Type size={13} weight="500" color={unavailable ? colors.muted : colors.accent} style={{ textAlign: 'center', textDecorationLine: unavailable ? 'none' : 'underline' }}>{busy ? text('正在确认模拟转账…', 'Confirming demo transfer…') : submitted ? text('确认已提交', 'Confirmation submitted') : actionLabel}</Type>
    </Pressable>
  </View>;
}
