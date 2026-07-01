import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import EmptyState from '../../src/components/EmptyState';
import { useTheme } from '../../src/context/ThemeContext';
import {
  CoachMessage,
  loadCoachMessages,
  markCoachMessagesSeen,
} from '../../src/lib/coachMessages';
import { reportSilent } from '../../src/lib/errorReporting';
import { supabase } from '../../src/lib/supabase';
import { layout, typography } from '../../src/theme';

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    const diffWk = Math.floor(diffDay / 7);
    if (diffWk < 5) return `${diffWk}w ago`;
    const d = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  } catch {
    return '';
  }
}

export default function CoachScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            if (!cancelled) {
              setMessages([]);
              setLoading(false);
            }
            return;
          }
          const msgs = await loadCoachMessages(user.id);
          if (!cancelled) {
            setMessages(msgs);
            setLoading(false);
          }
          // Fire-and-forget: clearing the "new" dot is now solely the
          // Coach tab's job. Dashboard no longer touches it.
          markCoachMessagesSeen(user.id);
        } catch (e) {
          reportSilent(e, 'coach:load');
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.header}>Coach</Text>
        <Text style={styles.subhead}>Every message, newest first.</Text>

        {!loading && messages.length === 0 ? (
          <EmptyState
            title="No coach messages yet"
            body="Finish a workout to hear from your coach. Reflections and observations land here."
          />
        ) : (
          <View style={styles.list}>
            {messages.map(m => (
              <View key={m.id} style={styles.card}>
                <Text style={styles.timestamp}>{formatRelative(m.createdAt)}</Text>
                <Text style={styles.body}>{m.text}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scrollContent: {
      paddingHorizontal: layout.spacing.lg,
      paddingTop: layout.spacing.lg,
      paddingBottom: layout.spacing.xxl,
    },
    header: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xl,
      color: colors.textPrimary,
      letterSpacing: -0.5,
    },
    subhead: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      marginTop: 4,
      marginBottom: layout.spacing.lg,
    },
    list: {
      gap: layout.spacing.sm,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      paddingVertical: layout.spacing.md,
      paddingHorizontal: layout.spacing.md,
    },
    timestamp: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      color: colors.accentTeal,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      marginBottom: 6,
    },
    body: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s15,
      lineHeight: 21,
      color: colors.textPrimary,
      letterSpacing: 0.1,
    },
  });
