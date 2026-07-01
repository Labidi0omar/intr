import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../src/context/ThemeContext';
import { supabase } from '../../src/lib/supabase';
import { typography, layout } from '../../src/theme';
import EmptyState from '../../src/components/EmptyState';
import { reportSilent } from '../../src/lib/errorReporting';
import { hasEntryForDate } from '../../src/lib/journalLock';

const JOURNAL_PREFIX = 'journal:';

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${dayNames[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
}

interface JournalEntry {
  date: string;
  userText: string;
  aiResponse: string;
  createdAt: string;
}

type ViewMode = 'loading' | 'input' | 'history';

export default function JournalScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [viewMode, setViewMode] = useState<ViewMode>('loading');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [hasTodayEntry, setHasTodayEntry] = useState(false);
  const [journalTab, setJournalTab] = useState<'write' | 'history'>('write');

  // Input state
  const [userText, setUserText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadJournalData();
    }, [])
  );

  const loadJournalData = async () => {
    setViewMode('loading');
    setErrorMsg('');
    try {
      const { data: { user } } = await supabase.auth.getUser();

      // ── One-time migration: any AsyncStorage entries get backfilled to Supabase
      // and then read back from the server. Guarded by a flag so it only runs once.
      if (user) {
        const migrated = await AsyncStorage.getItem('intr:journal:migratedToSupabase');
        if (!migrated) {
          try {
            const allKeys = await AsyncStorage.getAllKeys();
            const journalKeys = allKeys.filter(k => k.startsWith(JOURNAL_PREFIX));
            const rows: { user_id: string; date: string; user_text: string; ai_response: string | null }[] = [];
            for (const key of journalKeys) {
              const raw = await AsyncStorage.getItem(key);
              if (!raw) continue;
              try {
                const e = JSON.parse(raw) as JournalEntry;
                if (e?.date && e?.userText) {
                  rows.push({
                    user_id: user.id,
                    date: e.date,
                    user_text: e.userText,
                    ai_response: e.aiResponse ?? null,
                  });
                }
              } catch (e) {
                // skip corrupt entries
                reportSilent(e, 'journal:parseCachedEntry');
              }
            }
            if (rows.length > 0) {
              await supabase.from('journal_entries').upsert(rows, { onConflict: 'user_id,date' });
            }
            await AsyncStorage.setItem('intr:journal:migratedToSupabase', '1');
          } catch (e) {
            // Migration is best-effort; don't block loading
            console.warn('[journal] migration failed', e);
          }
        }
      }

      // ── Primary read: Supabase
      let loaded: JournalEntry[] = [];
      if (user) {
        const { data } = await supabase
          .from('journal_entries')
          .select('date, user_text, ai_response, created_at')
          .eq('user_id', user.id)
          .order('date', { ascending: false })
          .limit(60);

        if (data) {
          loaded = data.map((row: any) => ({
            date: row.date,
            userText: row.user_text,
            aiResponse: row.ai_response ?? '',
            createdAt: row.created_at,
          }));
          // Write-through cache so offline reads still work
          try {
            for (const e of loaded) {
              await AsyncStorage.setItem(`${JOURNAL_PREFIX}${e.date}`, JSON.stringify(e));
            }
          } catch (e) {
            // cache failures are non-fatal
            reportSilent(e, 'journal:cacheWrite');
          }
        }
      }

      // ── Fallback: if offline / no user, fall back to AsyncStorage cache
      if (loaded.length === 0) {
        const allKeys = await AsyncStorage.getAllKeys();
        const journalKeys = allKeys.filter(k => k.startsWith(JOURNAL_PREFIX));
        for (const key of journalKeys) {
          const raw = await AsyncStorage.getItem(key);
          if (!raw) continue;
          try {
            loaded.push(JSON.parse(raw) as JournalEntry);
          } catch (e) {
            // skip corrupt entries
            reportSilent(e, 'journal:parseStoredEntry');
          }
        }
        loaded.sort((a, b) => b.date.localeCompare(a.date));
      }

      setEntries(loaded);

      const today = todayDateStr();
      const todayEntry = loaded.find(e => e.date === today);

      if (todayEntry) {
        setHasTodayEntry(true);
        setUserText(todayEntry.userText || '');
        // Clear any in-session reflection so a reload shows the read-only
        // "you've journaled today" lock rather than a stale reflection card.
        setAiResponse(null);
        setViewMode('input');
        setJournalTab('write');
      } else {
        setHasTodayEntry(false);
        setUserText('');
        setAiResponse(null);
        setViewMode('input');
      }
    } catch (e) {
      console.error('Journal load error:', e);
      setViewMode('input');
    }
  };

  const handleStartWrite = () => {
    const today = todayDateStr();
    const existing = entries.find(e => e.date === today);
    setUserText(existing?.userText || '');
    setAiResponse(null);
    setHasTodayEntry(false);
    setViewMode('input');
    setJournalTab('write');
  };

  const handleSubmit = async () => {
    const trimmed = userText.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setErrorMsg('');
    setAiResponse(null);

    try {
      // Try to derive today's energy from the most recent workout session.
      // The dead daily_checkins table is gone; rest-day energy + mood aren't
      // captured anywhere today (moodTag is always null here).
      let energyScore: number | undefined;
      const moodTag: string | null = null;
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: session } = await supabase
            .from('workout_sessions')
            .select('energy_level')
            .eq('user_id', user.id)
            .eq('planned_date', todayDateStr())
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (session?.energy_level) {
            energyScore = session.energy_level === 'low' ? 2 : session.energy_level === 'high' ? 4 : 3;
          }
        }
      } catch (e) {
        // proceed without context
        reportSilent(e, 'journal:fetchEnergyContext');
      }

      // 8s client-side timeout via Promise.race. Independent of the gate —
      // fixes the pre-existing submit-hang when the edge function is slow.
      const TIMEOUT_SENTINEL: unique symbol = Symbol('daily-reflection-timeout') as any;
      type InvokeResult = { data: { content?: string; gate?: string } | null; error: unknown };
      let data: { content?: string; gate?: string } | null = null;
      let invokeError: unknown = null;
      try {
        const invokePromise = supabase.functions.invoke('daily-reflection', {
          body: {
            type: 'journal',
            user_text: trimmed,
            energy_score: energyScore,
            mood_tag: moodTag,
          },
        }) as Promise<InvokeResult>;
        const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>(resolve => {
          setTimeout(() => resolve(TIMEOUT_SENTINEL), 8000);
        });
        const raced = await Promise.race([invokePromise, timeoutPromise]);
        if (raced === TIMEOUT_SENTINEL) {
          invokeError = new Error('daily-reflection timed out');
        } else {
          data = raced.data;
          invokeError = raced.error;
        }
      } catch (e) {
        invokeError = e;
      }

      // Decide what to render. Three cases:
      //   1. gate === 'off'   → save entry, show "reflection coming later".
      //   2. content present   → save entry with reflection, render bubble.
      //   3. anything else     → save entry, no reflection card, no spinner.
      //                          (timeout, network error, empty body, 5xx)
      const gateOff = data?.gate === 'off';
      const realContent =
        typeof data?.content === 'string' && data.content.trim().length > 0
          ? data.content
          : '';
      // Persisted on disk: empty when gated off or when we got nothing usable.
      // The gate-off display copy lives ONLY in state so a later gate-on
      // doesn't show "coming back later" as that day's permanent reflection.
      const persistedAi = gateOff || !realContent ? '' : realContent;
      const displayedAi = gateOff
        ? 'Saved. Your reflection will come back when the coach is ready.'
        : realContent;

      const today = todayDateStr();
      const entry: JournalEntry = {
        date: today,
        userText: trimmed,
        aiResponse: persistedAi,
        createdAt: new Date().toISOString(),
      };

      // Dual-write: Supabase first (so the replanner can read it), then AsyncStorage cache.
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase.from('journal_entries').upsert(
            {
              user_id: user.id,
              date: today,
              user_text: trimmed,
              ai_response: persistedAi || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,date' }
          );
        }
      } catch (e) {
        reportSilent(e, 'journal:supabaseWrite');
      }

      try {
        await AsyncStorage.setItem(`${JOURNAL_PREFIX}${today}`, JSON.stringify(entry));
      } catch (e) {
        reportSilent(e, 'journal:cacheWrite');
      }

      const updated = [entry, ...entries.filter(e => e.date !== today)];
      updated.sort((a, b) => b.date.localeCompare(a.date));
      setEntries(updated);

      setHasTodayEntry(true);
      setAiResponse(displayedAi || null);
      setViewMode('history');

      // Invoke errors are downgraded to Sentry — the entry still saved, the
      // UI still moves forward, no banner shown. Gate-off is success, not error.
      if (invokeError && !gateOff) {
        reportSilent(invokeError, 'journal:invoke');
      }
    } catch (e: any) {
      console.error('Journal submit error:', e);
      setErrorMsg(e?.message || 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const todayKey = todayDateStr();

  // Once-per-day lock, derived at render time from the loaded entries against
  // the LIVE local date (todayKey) — so a yesterday entry never locks today,
  // the lock clears at local midnight, and it works offline (entries come
  // from the Supabase read OR the AsyncStorage fallback). Deciding from
  // `entries` (not the hasTodayEntry flag) makes the rollover self-correcting.
  const todaysEntry = entries.find(e => e.date === todayKey) ?? null;
  const lockedToday = hasEntryForDate(entries, todayKey);

  // --- Render helpers ---

  const renderLoading = () => (
    <View style={styles.centerState}>
      <ActivityIndicator size="small" color={colors.accentTeal} />
    </View>
  );

  const renderInputView = () => (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.inputContainer}
    >
      {aiResponse ? (
        // Reflection shown after submit, before auto-redirect
        <View style={styles.reflectionCard}>
          <Text style={styles.reflectionLabel}>Your reflection</Text>
          <Text style={styles.reflectionText}>{aiResponse}</Text>
          <TouchableOpacity
            style={[styles.submitBtn, { marginTop: layout.spacing.lg }]}
            onPress={() => setViewMode('history')}
            activeOpacity={0.8}
          >
            <Text style={styles.submitBtnText}>See history</Text>
          </TouchableOpacity>
        </View>
      ) : lockedToday && todaysEntry ? (
        // Already journaled today → read-only lock. No editor, no submit, no
        // overwrite until the local date rolls over.
        <View style={styles.lockedCard}>
          <Text style={styles.lockedNote}>You've journaled today — come back tomorrow.</Text>
          <View style={styles.lockedEntryBox}>
            <Text style={styles.lockedEntryDate}>{formatDisplayDate(todaysEntry.date)}</Text>
            <Text style={styles.lockedEntryText}>{todaysEntry.userText}</Text>
            {todaysEntry.aiResponse ? (
              <View style={styles.entryAiBox}>
                <Text style={styles.entryAiText}>{todaysEntry.aiResponse}</Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : (
        <>
          <Text style={styles.prompt}>How are things?</Text>

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

          <TextInput
            style={styles.textInput}
            placeholder="what's on your mind"
            placeholderTextColor={colors.textSecondary + '80'}
            multiline
            textAlignVertical="top"
            value={userText}
            onChangeText={setUserText}
            editable={!submitting}
          />

          <TouchableOpacity
            style={[styles.submitBtn, (!userText.trim() || submitting) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            activeOpacity={0.8}
            disabled={!userText.trim() || submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={styles.submitBtnText}>Write</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </KeyboardAvoidingView>
  );

  const renderHistoryView = () => (
    <View style={styles.historyContainer}>
      {hasTodayEntry && !lockedToday ? (
        <TouchableOpacity
          style={styles.writeTodayBtn}
          onPress={handleStartWrite}
          activeOpacity={0.8}
        >
          <Text style={styles.writeTodayBtnText}>Write today</Text>
        </TouchableOpacity>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.historyList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {entries.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            body="When you reflect, it lives here. Quiet, private, your own."
          />
        ) : (
          entries.map((entry, idx) => (
            <View key={entry.date + idx} style={styles.entryCard}>
              <Text style={styles.entryDate}>{formatDisplayDate(entry.date)}</Text>
              <Text style={styles.entryUserText} numberOfLines={4}>{entry.userText}</Text>
              {entry.aiResponse ? (
                <View style={styles.entryAiBox}>
                  <Text style={styles.entryAiText}>{entry.aiResponse}</Text>
                </View>
              ) : null}
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
      <Text style={styles.heading}>Journal</Text>

      {/* Journal tab bar */}
      <View style={[styles.journalTabBar, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        {(['write', 'history'] as const).map(tab => {
          const isActive = journalTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.journalTabItem, isActive && { borderBottomColor: colors.accentTeal, borderBottomWidth: 2 }]}
              onPress={() => setJournalTab(tab)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.journalTabText,
                  { color: isActive ? colors.accentTeal : colors.textSecondary },
                  isActive && { fontWeight: '700' },
                  !isActive && { opacity: 0.6 },
                ]}
              >
                {tab === 'write' ? 'Write' : 'History'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {viewMode === 'loading' ? renderLoading() : null}
      {viewMode !== 'loading' && journalTab === 'write' ? renderInputView() : null}
      {viewMode !== 'loading' && journalTab === 'history' ? renderHistoryView() : null}
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: colors.background,
    },
    heading: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s32,
      color: colors.textPrimary,
      paddingHorizontal: layout.spacing.lg,
      paddingTop: layout.spacing.xl,
      paddingBottom: layout.spacing.md,
      letterSpacing: -0.5,
    },
    centerState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 60,
    },
    emptyText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
    },
    emptySubtext: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      marginTop: 4,
    },
    journalTabBar: {
      flexDirection: 'row',
      minHeight: 48,
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    journalTabItem: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
      minHeight: 48,
      paddingBottom: 8,
    },
    journalTabText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.s15,
      paddingHorizontal: 12,
    },

    // Input view
    inputContainer: {
      flex: 1,
      paddingHorizontal: layout.spacing.lg,
    },
    prompt: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
      marginBottom: layout.spacing.lg,
    },
    errorText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.accentRed,
      marginBottom: layout.spacing.sm,
    },
    textInput: {
      flex: 1,
      fontFamily: typography.family.body,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: layout.cardRadius,
      padding: layout.spacing.lg,
      minHeight: 160,
      maxHeight: '65%',
      lineHeight: 22,
    },
    submitBtn: {
      backgroundColor: colors.accentTeal,
      borderRadius: layout.cardRadius,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: layout.spacing.lg,
      marginBottom: layout.spacing.xxl,
    },
    submitBtnDisabled: {
      opacity: 0.4,
    },
    submitBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.md,
      color: colors.background,
    },

    // Reflection after submit
    reflectionCard: {
      flex: 1,
      justifyContent: 'center',
      paddingBottom: 80,
    },
    reflectionLabel: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xs,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.md,
    },
    reflectionText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      lineHeight: 24,
    },

    // Read-only "already journaled today" lock
    lockedCard: {
      flex: 1,
      paddingTop: layout.spacing.lg,
    },
    lockedNote: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.md,
      color: colors.textSecondary,
      marginBottom: layout.spacing.lg,
      lineHeight: 22,
    },
    lockedEntryBox: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: layout.cardRadius,
      padding: layout.spacing.lg,
    },
    lockedEntryDate: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xs,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.sm,
    },
    lockedEntryText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.md,
      color: colors.textPrimary,
      lineHeight: 22,
    },

    // History view
    historyContainer: {
      flex: 1,
      paddingHorizontal: layout.spacing.lg,
    },
    writeTodayBtn: {
      backgroundColor: colors.accentTeal,
      borderRadius: layout.cardRadius,
      paddingVertical: 12,
      alignItems: 'center',
      marginBottom: layout.spacing.xl,
    },
    writeTodayBtnText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.md,
      color: colors.background,
    },
    historyList: {
      gap: layout.spacing.lg,
    },
    entryCard: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      padding: layout.spacing.lg,
      borderWidth: 1,
      borderColor: colors.cardBorder,
    },
    entryDate: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.xs,
      color: colors.textSecondary,
      textTransform: 'uppercase',
      marginBottom: layout.spacing.sm,
    },
    entryUserText: {
      fontFamily: typography.family.bodyMedium,
      fontSize: typography.size.sm,
      color: colors.textPrimary,
      lineHeight: 20,
      marginBottom: layout.spacing.md,
    },
    entryAiBox: {
      backgroundColor: colors.surfaceElevated,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      borderRadius: layout.cardRadius,
      padding: layout.spacing.md,
    },
    entryAiText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 20,
    },
  });
