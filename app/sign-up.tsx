import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../src/components/Button';
import Input from '../src/components/Input';
import { supabase } from '../src/lib/supabase';
import { track } from '../src/lib/analytics';
import { layout, typography } from '../src/theme';
import { useTheme } from '../src/context/ThemeContext';

export default function SignUpScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  // Clean error state handling (no popups)
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [globalError, setGlobalError] = useState('');

  const validate = () => {
    let isValid = true;
    setEmailError('');
    setPasswordError('');
    setGlobalError('');

    if (!email) {
      setEmailError('Email is required');
      isValid = false;
    } else if (!email.includes('@')) {
      setEmailError('Please enter a valid email address');
      isValid = false;
    }

    if (!password) {
      setPasswordError('Password is required');
      isValid = false;
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      isValid = false;
    }

    return isValid;
  };

  const handleSignUp = async () => {
    if (!validate()) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });

      if (error) {
        if (error.message.includes('already registered')) {
          setGlobalError('This email is already registered. Try logging in.');
        } else if (error.message.includes('weak_password')) {
          setPasswordError('Password is too weak.');
        } else if (error.message.includes('format')) {
          setEmailError('Invalid email format.');
        } else {
          setGlobalError(error.message);
        }
      } else if (data.session || data.user) {
        if (data.user) {
          const { error: profileError } = await supabase
            .from('profiles')
            .upsert({ id: data.user.id, onboarding_complete: false });

          if (profileError) {
            // Profile creation issue — user can still proceed to onboarding
          }
        }

        // Wait for the SDK to actually persist the session before navigating.
        // signUp returns once the session is set, but on native AsyncStorage
        // writes are async — re-fetch until the session is visible.
        for (let i = 0; i < 20; i++) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) break;
          await new Promise(r => setTimeout(r, 100));
        }

        track('signup');
        router.replace('/onboarding');
      }
    } catch (e: any) {
      setGlobalError(e.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Create Account</Text>
        </View>

        <View style={styles.form}>
          <Input
            label="Email"
            placeholder="your@email.com"
            value={email}
            onChangeText={(t) => { setEmail(t); setEmailError(''); }}
            error={emailError}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <Input
            label="Password"
            placeholder="At least 6 characters"
            value={password}
            onChangeText={(t) => { setPassword(t); setPasswordError(''); }}
            error={passwordError}
            secureTextEntry
          />

          {globalError ? <Text style={styles.globalError}>{globalError}</Text> : null}
        </View>

        <View style={styles.actions}>
          <Button
            title="Sign Up"
            onPress={handleSignUp}
            loading={loading}
          />
          <View style={{ height: layout.spacing.md }} />
          <Button
            title="Back to Welcome"
            variant="ghost"
            onPress={() => router.back()}
            disabled={loading}
          />
        </View>
      </KeyboardAvoidingView>
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
    marginTop: layout.spacing.xl,
    marginBottom: layout.spacing.xxl,
  },
  title: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.lg,
    color: colors.textPrimary,
    letterSpacing: typography.size.lg * typography.letterSpacing.heading,
  },
  form: {
    flex: 1,
  },
  actions: {
    width: '100%',
  },
  globalError: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.sm,
    color: colors.accentCoral,
    marginTop: layout.spacing.xs,
    textAlign: 'center',
  }
});
