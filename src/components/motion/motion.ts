import { FadeInDown } from 'react-native-reanimated';
import { animation } from '../../theme';

/**
 * Consistent entrance animations for lists of cards. Composes with
 * Reanimated's built-in FadeInDown layout animation and staggers by
 * `animation.stagger` per index so the eye can follow the sequence.
 *
 *   <Animated.View entering={MOTION.enter(0)}>…</Animated.View>
 *   <Animated.View entering={MOTION.enter(1)}>…</Animated.View>
 *
 * Do not hand-roll fade/slide entrances elsewhere — use this helper
 * so cadence stays consistent across screens.
 */
export const MOTION = {
  enter: (i: number = 0) =>
    FadeInDown.delay(i * animation.stagger).springify(),
};
