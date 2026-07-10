import React, { useEffect } from 'react';
import { Easing as RNEasing, StyleProp, TextInput, TextStyle } from 'react-native';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { animation } from '../../theme';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

type Props = {
  value: number;
  duration?: number;
  style?: StyleProp<TextStyle>;
  /** Format the tweened number for display. Default rounds to integer. */
  format?: (n: number) => string;
};

const DEFAULT_FORMAT = (n: number): string => String(Math.round(n));

/**
 * Renders a single-line, non-editable numeric readout that tweens
 * between successive `value` prop values via a Reanimated shared
 * value + withTiming. Rendered through Animated.createAnimatedComponent
 * on TextInput because worklets can update the native `text` prop from
 * the UI thread — Text's `children` cannot be set from a worklet.
 */
export default function AnimatedCount({
  value,
  duration = animation.duration.progress,
  style,
  format = DEFAULT_FORMAT,
}: Props) {
  const shared = useSharedValue(value);

  useEffect(() => {
    shared.set(
      withTiming(value, {
        duration,
        easing: RNEasing.bezier(...animation.easing.standard),
      }),
    );
  }, [value, duration, shared]);

  const animatedProps = useAnimatedProps(() => {
    const text = format(shared.get());
    // `text` is the native prop Animated updates on TextInput; also
    // set `defaultValue` so the returned object is a valid subset of
    // TextInputProps for TypeScript.
    return { text, defaultValue: text };
  });

  return (
    <AnimatedTextInput
      editable={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      value={format(value)}
      style={style}
      animatedProps={animatedProps}
    />
  );
}
