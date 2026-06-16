import React, { useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../src/lib/supabase';
import { signInWithGoogle } from '../src/lib/googleAuth';
import Button from '../src/components/Button';
import Input from '../src/components/Input';
import { typography, layout } from '../src/theme';
import { useTheme } from '../src/context/ThemeContext';

export default function LogInScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const [globalError, setGlobalError] = useState('');

  const handleGoogle = async () => {
    if (googleLoading) return;
    setGlobalError('');
    setGoogleLoading(true);
    const result = await signInWithGoogle();
    setGoogleLoading(false);

    if (result.kind === 'cancel') return;
    if (result.kind === 'error') {
      setGlobalError(result.message || 'Google sign-in failed.');
      return;
    }
    router.replace(result.isNewUser ? '/onboarding' : '/(tabs)/home');
  };

  const handleLogIn = async () => {
    setGlobalError('');
    if (!email || !password) {
      setGlobalError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setGlobalError(error.message); // Clean inline error display
      } else if (data.session) {
        // Check profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('onboarding_complete')
          .eq('id', data.session.user.id)
          .single();
        
        if (profile?.onboarding_complete) {
          router.replace('/home');
        } else {
          router.replace('/onboarding');
        }
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
          <Text style={styles.title}>Welcome Back</Text>
        </View>

        <View style={styles.form}>
          <Input 
            label="Email"
            placeholder="your@email.com"
            value={email}
            onChangeText={(t) => { setEmail(t); setGlobalError(''); }}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <Input 
            label="Password"
            placeholder="Your password"
            value={password}
            onChangeText={(t) => { setPassword(t); setGlobalError(''); }}
            secureTextEntry
          />

          {globalError ? <Text style={styles.globalError}>{globalError}</Text> : null}
        </View>

        <View style={styles.actions}>
          <Button
            title="Log In"
            onPress={handleLogIn}
            loading={loading}
          />
          <View style={{ height: layout.spacing.sm }} />
          <Button
            title={googleLoading ? 'Opening Google…' : 'Continue with Google'}
            variant="secondary"
            onPress={handleGoogle}
            disabled={loading || googleLoading}
          />
          <View style={{ height: layout.spacing.sm }} />
          <Button
            title="Back to Welcome"
            variant="ghost"
            onPress={() => router.back()}
            disabled={loading || googleLoading}
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
    color: colors.accentTeal,
    marginTop: layout.spacing.xs,
    textAlign: 'center',
  }
});
