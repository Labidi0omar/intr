import React, { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '../context/ThemeContext';
import { animation, layout, typography } from '../theme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: any;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const PRESSED_SCALE = 0.96;
const RELEASED_SCALE = 1;

/**
 * Shared button primitive. Every use site of <Button /> — every
 * primary/secondary/ghost CTA in the app — automatically press-scales
 * on touch: a smooth spring shrinks to 0.96 on press-in, springs back
 * on release. VISUAL only, no haptic. Reduce-motion skips the scale.
 * The scale replaces the earlier pressed-state background flash — a
 * single, physical, consistent affordance instead of a color hint that
 * only kicked in on the secondary/ghost variants.
 */
export default function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
}: ButtonProps) {
  const { colors } = useTheme();

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
    (_e: GestureResponderEvent) => {
      if (!reduceMotion) {
        scale.set(withSpring(PRESSED_SCALE, animation.spring.press));
      }
    },
    [reduceMotion, scale],
  );

  const handlePressOut = useCallback(
    (_e: GestureResponderEvent) => {
      if (!reduceMotion) {
        scale.set(withSpring(RELEASED_SCALE, animation.spring.press));
      }
    },
    [reduceMotion, scale],
  );

  const getContainerStyle = () => {
    const base = { backgroundColor: 'transparent', borderWidth: 1 };
    switch (variant) {
      case 'primary':
        return [{ ...base, backgroundColor: colors.accentTeal, borderColor: colors.accentTeal }];
      case 'secondary':
        return [{ ...base, borderColor: colors.border }];
      case 'ghost':
        return [{ ...base, borderColor: 'transparent' }];
    }
  };

  const getTextStyle = () => {
    switch (variant) {
      case 'primary': return { color: colors.background };
      case 'secondary': return { color: colors.textPrimary };
      case 'ghost': return { color: colors.accentTeal };
    }
  };

  return (
    <AnimatedPressable
      style={[
        animatedStyle,
        styles.container,
        ...getContainerStyle(),
        (disabled || loading) && { opacity: 0.35 },
        style,
      ]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? colors.background : colors.accentTeal}
        />
      ) : (
        <Text style={[styles.text, getTextStyle()]}>{title}</Text>
      )}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 52,
    borderRadius: layout.cardRadius,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: layout.spacing.lg,
    width: '100%',
  },
  text: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.sm,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
