import { DMSans_400Regular, DMSans_500Medium } from '@expo-google-fonts/dm-sans';
import { Syne_700Bold, useFonts } from '@expo-google-fonts/syne';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider, useTheme } from '../src/context/ThemeContext';
import { supabase } from '../src/lib/supabase';
import { configurePurchases } from '../src/lib/purchases';
import { BUILD_TAG } from '../src/constants/buildInfo';
import {
  scheduleComebackNotification,
  syncWorkoutNotifications,
} from '../src/utils/notifications';

// Display banners/sound for foreground notifications. Set at module load
// so the SDK has the handler before any notification could arrive. Skipped
// in Expo Go SDK 53+ where local notifications aren't supported.
if (Constants.appOwnership !== 'expo') {
  // Fire-and-forget; failures are non-fatal and reported by the util.
  import('expo-notifications')
    .then((Notifications) => {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
    })
    .catch(() => { /* expo-notifications missing in this runtime; ignore */ });
}

// Logged once at module load so a fresh JS bundle prints the new tag in
// Metro the moment it boots. If you reload and don't see the bumped tag in
// the Metro log, the bundle didn't actually update.
console.log('[build]', BUILD_TAG);

// ── Sentry crash + error reporting ────────────────────────────────────
// Initialised at module load so the SDK catches the very first frame.
// DSN comes from EXPO_PUBLIC_SENTRY_DSN — when unset (local dev / no
// dashboard yet) Sentry no-ops cleanly instead of throwing.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Performance tracing — keep low in dogfood to stay inside free tier.
    tracesSampleRate: 0.1,
    // Don't ship session replays yet — they need more configuration.
    enableAutoSessionTracking: true,
    // Don't capture noisy dev errors as breadcrumbs.
    enableNativeCrashHandling: true,
    debug: __DEV__,
  });
}

function RootLayoutInner() {
  const { colors } = useTheme();
  const router = useRouter();
  const segments = useSegments();
  const lastUserId = useRef<string | null>(null);

  // Fire-and-forget RC init. No-ops if EXPO_PUBLIC_RC_*_KEY env vars
  // are unset (i.e., before the dashboard is wired in Sprint 6).
  useEffect(() => {
    void configurePurchases();
  }, []);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const newUserId = session?.user?.id ?? null;

      // Tag every Sentry event with the current user so crashes can be
      // traced back to a specific account. PII = just the UUID; nothing
      // identifying about the person.
      if (newUserId) {
        Sentry.setUser({ id: newUserId });
      } else {
        Sentry.setUser(null);
      }

      if (event === 'SIGNED_OUT' || (lastUserId.current && !newUserId)) {
        // Token expired or explicit sign-out — bounce to welcome unless
        // already on a public screen. Widened to string[] because typed
        // routes can't express the root index route (`/`), where
        // useSegments() returns [] at runtime.
        const currentSegments: string[] = segments;
        const onPublicScreen =
          currentSegments.length === 0 ||
          currentSegments[0] === 'welcome' ||
          currentSegments[0] === 'log-in' ||
          currentSegments[0] === 'sign-up';
        if (!onPublicScreen) router.replace('/welcome');
      }

      lastUserId.current = newUserId;
    });

    return () => sub.subscription.unsubscribe();
  }, [router, segments]);

  // Foreground → resync weekly reminders against the live plan and push the
  // comeback nudge another 3 days out. Net effect: reminders never go stale
  // when the plan changes, and the comeback nudge only fires after a real
  // ~3-day absence. Both no-op in Expo Go / when permission isn't granted.
  useEffect(() => {
    const onChange = (state: string) => {
      if (state !== 'active') return;
      void syncWorkoutNotifications();
      void scheduleComebackNotification();
    };
    // Fire once on mount too (the app is already 'active' here).
    onChange('active');
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="sign-up" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="log-in" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="workout" />
        <Stack.Screen name="recovery" />
        <Stack.Screen name="onboarding" />
        {/* DEV-ONLY routes. The screen file itself renders a guard view
            in production (so a release build that somehow navigates here
            sees a "not available" notice, never the wipe affordance) and
            the only entry point is a __DEV__-gated long-press on the
            profile username. Registering the screen unconditionally is
            fine — Expo Router won't auto-navigate to it. */}
        <Stack.Screen name="dev-scenarios" options={{ animation: 'slide_from_right' }} />
      </Stack>
    </>
  );
}

function RootLayout() {
  const [fontsLoaded] = useFonts({
    Syne_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
  });

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <RootLayoutInner />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap registers an error boundary at the root so even render-time
// crashes get captured. When DSN is unset this is still a safe pass-through.
export default Sentry.wrap(RootLayout);
