import React, { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { animation } from '../../theme';
import * as haptics from '../../lib/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const PRESSED_SCALE = 0.96;
const RELEASED_SCALE = 1;

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Optional haptic fired on pressIn — same moment the finger lands. */
  haptic?: 'tap' | 'select';
  children: React.ReactNode;
};

/**
 * Pressable that springs its own scale down on press and back on
 * release. Optional haptic fires on pressIn (not release) — same
 * moment the user feels contact.
 *
 * Respects reduce-motion: if the OS reports it enabled, the scale
 * animation is skipped. Haptic and onPress still fire.
 */
export default function PressableScale({
  style,
  haptic,
  onPressIn,
  onPressOut,
  onPress,
  disabled,
  children,
  ...rest
}: Props) {
  const scale = useSharedValue(RELEASED_SCALE);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => {
        if (mounted) setReduceMotion(v);
      })
      .catch(() => {
        // Default (false) is already in state; nothing to do.
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => {
      setReduceMotion(v);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      if (!reduceMotion) {
        scale.set(withSpring(PRESSED_SCALE, animation.spring.press));
      }
      if (haptic === 'tap') haptics.tap();
      else if (haptic === 'select') haptics.select();
      onPressIn?.(e);
    },
    [haptic, onPressIn, reduceMotion, scale],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      if (!reduceMotion) {
        scale.set(withSpring(RELEASED_SCALE, animation.spring.press));
      }
      onPressOut?.(e);
    },
    [onPressOut, reduceMotion, scale],
  );

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={onPress}
      disabled={disabled}
      style={[animatedStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
