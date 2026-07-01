import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../src/components/Button';
import { useTheme } from '../src/context/ThemeContext';
import { signInWithGoogle } from '../src/lib/googleAuth';
import { layout, typography } from '../src/theme';

export default function WelcomeScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();

  const [googleLoading, setGoogleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleGoogle = async () => {
    if (googleLoading) return;
    setErrorMsg('');
    setGoogleLoading(true);
    const result = await signInWithGoogle();
    setGoogleLoading(false);

    if (result.kind === 'cancel') return; // silent — user closed the browser
    if (result.kind === 'error') {
      setErrorMsg(result.message || 'Sign-in failed. Try again.');
      return;
    }

    // Success — route based on whether onboarding is complete.
    router.replace(result.isNewUser ? '/onboarding' : '/(tabs)/home');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.logo}>Intr</Text>
          <Text style={styles.tagline}>Your coach. Your call.</Text>
          <Text style={styles.taglineSub}>
            Pick a day, lift, repeat.
          </Text>
        </View>

        <View style={styles.actions}>
          {/* Primary: Google */}
          <TouchableOpacity
            style={styles.googleBtn}
            onPress={handleGoogle}
            activeOpacity={0.85}
            disabled={googleLoading}
          >
            {googleLoading ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <>
                <View style={styles.googleGlyphWrap}>
                  <Text style={styles.googleGlyph}>G</Text>
                </View>
                <Text style={styles.googleBtnText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Secondary: email */}
          <Button title="Sign up with email" onPress={() => router.push('/sign-up')} />
          <View style={{ height: layout.spacing.sm }} />
          <Button title="Log in" variant="ghost" onPress={() => router.push('/log-in')} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: layout.spacing.lg,
    paddingBottom: layout.spacing.xxl,
    justifyContent: 'space-between',
  },
  header: {
    marginTop: 100,
    alignItems: 'center',
  },
  logo: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl,
    color: colors.textPrimary,
    letterSpacing: 6,
  },
  tagline: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    marginTop: layout.spacing.lg,
    letterSpacing: -0.2,
  },
  taglineSub: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.textMuted,
    marginTop: 6,
    letterSpacing: 0.3,
  },
  actions: {
    width: '100%',
  },
  // Google brand colors (#FFFFFF / #E0E0E0 / #1A73E8 / #1F1F1F) are
  // intentional and kept as literals — they match Google's sign-in
  // button spec and must not drift with the app theme.
  googleBtn: {
    height: 52,
    borderRadius: layout.cardRadius,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  googleGlyphWrap: {
    width: 22,
    height: 22,
    borderRadius: layout.radii.r11,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  googleGlyph: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s13,
    color: '#1A73E8',
    lineHeight: 16,
  },
  googleBtnText: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.sm,
    color: '#1F1F1F',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  errorText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.sm,
    color: colors.accentCoral,
    textAlign: 'center',
    marginTop: layout.spacing.sm,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: layout.spacing.lg,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.cardBorder,
  },
  dividerText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s10,
    letterSpacing: 2,
    color: colors.textMuted,
    paddingHorizontal: layout.spacing.md,
  },
});
