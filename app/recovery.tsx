// Rest-day light-session screen.
//
// Routed from the dashboard rest-day card. The user picks a category
// (Core / Calves / Forearms & Grip / Cardio / Mobility), the generator
// returns a deterministic session of up to 3 items, and on Finish we save
// a workout_sessions row + exercise_logs all flagged is_recovery=true.
//
// The 'ready' phase mirrors the active-workout presentation in
// app/workout.tsx (image, large title, dose, cue) — bodyweight/dose only,
// no weight input, no RIR input. Wiring either would feed the load engine
// and break the exclusion boundary documented in src/lib/recovery.ts.
//
// Why is_recovery=true on everything (incl. Core/Calves/Forearms&Grip):
// rest-day extras must never feed PR detection, load prescription, or RIR
// autoregulation. The streak still counts these days — that's the
// asymmetric rule wired into src/lib/recovery.ts. Treating every category
// as recovery keeps the exclusion boundary intact regardless of what the
// user picked.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../src/components/Button';
import { useTheme } from '../src/context/ThemeContext';
import { reportSilent } from '../src/lib/errorReporting';
import {
  trainingDaysForSplit,
  type Location,
  type SplitId,
} from '../src/lib/planGeneration';
import { runDurableSave, type PendingSave } from '../src/lib/pendingSync';
import {
  generateRecoverySession,
  type RecoveryMenuCategory,
  type RecoverySession,
  type RecoverySessionExercise,
} from '../src/lib/recoveryGeneration';
import { supabase } from '../src/lib/supabase';
import { layout, typography } from '../src/theme';

/** Local YYYY-MM-DD for "today". Matches getTodayStr in workout.tsx. */
function getTodayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

type Phase = 'loading' | 'alreadyDone' | 'choosing' | 'ready' | 'saving' | 'complete' | 'error';

/** Cached bootstrap inputs the generator needs. We fetch these ONCE up
 *  front so the user can pick a category, then re-pick another, without
 *  re-querying Supabase between picks. */
interface BootstrapArgs {
  userId: string;
  split: 'full_body' | 'upper_lower' | 'ppl' | 'bro_split';
  trainingDays: number;
  location: Location;
  recentlyTrainedAreas: string[];
}

/** The five user-facing menu cards in display order. */
const MENU_CARDS: readonly {
  key: RecoveryMenuCategory;
  title: string;
  reassurance: string;
}[] = [
  {
    key: 'core',
    title: 'Core / Abs',
    reassurance: "A few light abs — won't touch tomorrow's session.",
  },
  {
    key: 'forearms_grip',
    title: 'Forearms & Grip',
    reassurance: "Light wrist work and holds — won't compete with pulling day.",
  },
  {
    key: 'calves',
    title: 'Calves',
    reassurance: "A couple raises — easy dose, no soreness for leg day.",
  },
  {
    key: 'cardio',
    title: 'Cardio',
    reassurance: 'Easy conversational pace — circulation, not conditioning.',
  },
  {
    key: 'mobility',
    title: 'Mobility',
    reassurance: 'Move better, feel less stiff — no equipment needed.',
  },
];

/** Fallback glyph for items without an imageUrl. Keyed off the catalog's
 *  (category, area) — close to the menu category the user picked, but
 *  derived from the exercise itself so a mixed-bag multi-category session
 *  still gets per-item glyphs. */
function fallbackGlyphFor(ex: RecoverySessionExercise): string {
  if (ex.category === 'cardio') return '◐';
  if (ex.category === 'core') return '◆';
  if (ex.category === 'mobility') return '≈';
  // prehab — split by area
  if (ex.area === 'calves' || ex.area === 'ankles') return '▲';
  if (ex.area === 'forearms' || ex.area === 'grip') return '✦';
  return '◇';
}

/** Already-logged summary loaded for the alreadyDone phase. */
interface TodaysSession {
  workout_type: string | null;
  is_recovery: boolean | null;
}

export default function RecoveryScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [bootstrap, setBootstrap] = useState<BootstrapArgs | null>(null);
  const [session, setSession] = useState<RecoverySession | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [alreadyDone, setAlreadyDone] = useState<TodaysSession | null>(null);
  // URLs we've seen 404/fail. Mirrors the brokenImageUrls Set pattern in
  // app/workout.tsx — a remote-DB 404 should drop to a neutral block, not
  // a gap in the card.
  const [brokenImageUrls, setBrokenImageUrls] = useState<Set<string>>(() => new Set());
  const markImageBroken = (url: string) => {
    setBrokenImageUrls(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  // ── Bootstrap ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) {
            setErrorMsg('No user session — sign in to start a session.');
            setPhase('error');
          }
          return;
        }

        const todayStr = getTodayStr();

        // Guard: if the user already logged a completed session today,
        // skip the picker. The dashboard rest-day CTA also routes here,
        // so this screen owns the "already done today" state — they don't
        // get a fresh picker after they've already trained.
        try {
          const { data: todays } = await supabase
            .from('workout_sessions')
            .select('workout_type, is_recovery')
            .eq('user_id', user.id)
            .eq('planned_date', todayStr)
            .eq('completed', true)
            .limit(1);
          if (todays && todays.length > 0) {
            if (!cancelled) {
              setAlreadyDone(todays[0] as TodaysSession);
              setPhase('alreadyDone');
            }
            return;
          }
        } catch (e) {
          // Tolerated — fall through to the picker. A failed lookup
          // shouldn't block the user from logging.
          reportSilent(e, 'recovery:fetchTodaySession');
        }

        let split: SplitId = 'ppl';
        let trainingDays = 3;
        let location: Location = 'gym';
        let recentlyTrainedAreas: string[] = [];

        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('training_days, preferred_split')
            .eq('id', user.id)
            .maybeSingle();
          if (profile?.preferred_split) split = profile.preferred_split as SplitId;
          if (profile?.training_days && (profile.training_days as number) > 0) {
            trainingDays = profile.training_days as number;
          } else {
            trainingDays = trainingDaysForSplit(split);
          }
        } catch (e) {
          reportSilent(e, 'recovery:fetchProfile');
        }

        try {
          const storedLoc = await AsyncStorage.getItem('user:defaultLocation');
          location = storedLoc === 'Home' ? 'home' : 'gym';
        } catch (e) {
          reportSilent(e, 'recovery:fetchLocation');
        }

        try {
          const { data: recent } = await supabase
            .from('workout_sessions')
            .select('workout_type')
            .eq('user_id', user.id)
            .eq('completed', true)
            // EXCLUSION BOUNDARY: only training sessions inform the
            // "fatigued areas" bias; recovery sessions are irrelevant here.
            .eq('is_recovery', false)
            .order('planned_date', { ascending: false })
            .limit(3);
          recentlyTrainedAreas = (recent ?? [])
            .map((r: any) => String(r.workout_type ?? ''))
            .filter(Boolean);
        } catch (e) {
          reportSilent(e, 'recovery:fetchRecent');
        }

        if (cancelled) return;
        setBootstrap({
          userId: user.id,
          split,
          trainingDays,
          location,
          recentlyTrainedAreas,
        });
        setPhase('choosing');
      } catch (e) {
        reportSilent(e, 'recovery:bootstrap');
        if (!cancelled) {
          setErrorMsg('Could not load — try again later.');
          setPhase('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pickCategory = (category: RecoveryMenuCategory) => {
    if (!bootstrap) return;
    const generated = generateRecoverySession({
      category,
      split: bootstrap.split,
      trainingDays: bootstrap.trainingDays,
      location: bootstrap.location,
      recentlyTrainedAreas: bootstrap.recentlyTrainedAreas,
      seedKey: getTodayStr(),
    });
    setSession(generated);
    setErrorMsg('');
    setPhase('ready');
  };

  const backToMenu = () => {
    setSession(null);
    setErrorMsg('');
    setPhase('choosing');
  };

  // ── Finish ────────────────────────────────────────────────────────────
  // Every rest-day session writes is_recovery=true on the session AND
  // every exercise_logs row. weight_kg=0 and reps_in_reserve=null on
  // every log row — these never feed last-weights, PR detection, RIR
  // autoregulation, or the load coach (see src/lib/recovery.ts for the
  // read-side exclusion boundary). The session still counts toward the
  // streak — streak.ts intentionally does NOT filter is_recovery.
  const handleFinish = async () => {
    if (!session) return;
    setPhase('saving');
    setErrorMsg('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setErrorMsg('No user session — sign in to save.');
        setPhase('ready');
        return;
      }

      const todayStr = getTodayStr();
      const nowIso = new Date().toISOString();

      // No checklist — every exercise in the generated session is logged on
      // Finish. weight_kg=0 / reps_in_reserve=null on every row keeps the
      // exclusion boundary intact (see src/lib/recovery.ts).
      const logRows = session.exercises.map(ex => ({
        user_id: user.id,
        exercise_name: ex.name,
        weight_kg: 0,
        logged_date: todayStr,
        session_id: null as string | null,
        reps_in_reserve: null as number | null,
        is_recovery: true,
      }));

      const save: PendingSave = {
        userId: user.id,
        plannedDate: todayStr,
        session: {
          user_id: user.id,
          planned_date: todayStr,
          completed_at: nowIso,
          workout_type: session.workoutType,
          location: session.location,
          energy_level: 'normal',
          completed: true,
          exercises_done: session.exercises,
          replanned: false,
          is_recovery: true,
        },
        logRows,
        queuedAt: nowIso,
      };

      const result = await runDurableSave(save);
      if (result.ok) {
        setQueuedOffline(false);
        setPhase('complete');
      } else if (result.enqueued) {
        setQueuedOffline(true);
        setPhase('complete');
      } else {
        setErrorMsg('Could not save — please try again.');
        setPhase('ready');
      }
    } catch (e) {
      reportSilent(e, 'recovery:save');
      setErrorMsg('Could not save — please try again.');
      setPhase('ready');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.centerWrap}>
          <Text style={styles.kicker}>REST DAY</Text>
          <Text style={styles.loadingText}>One moment…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'alreadyDone') {
    const label = (alreadyDone?.workout_type || 'Today').trim();
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.centerWrap}>
          <Text style={[styles.kicker, { color: colors.accentPositive }]}>TODAY · {label.toUpperCase()}</Text>
          <Text style={styles.completeHeadline}>You've already trained today.</Text>
          <Text style={styles.completeBody}>
            Logged: {label}. Recovery counts toward your streak — come back tomorrow.
          </Text>
          <View style={{ height: layout.spacing.lg }} />
          <Button title="Back to Home" onPress={() => router.replace('/(tabs)/home')} />
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'choosing') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={styles.kicker}>REST DAY</Text>
          <Text style={styles.headline}>Train something light that won't wreck tomorrow.</Text>
          <Text style={styles.subhead}>Pick one.</Text>

          <View style={styles.menuList}>
            {MENU_CARDS.map(card => (
              <TouchableOpacity
                key={card.key}
                onPress={() => pickCategory(card.key)}
                activeOpacity={0.78}
                style={styles.menuCard}
                accessibilityRole="button"
                accessibilityLabel={`${card.title} — ${card.reassurance}`}
              >
                <Text style={styles.menuCardTitle}>{card.title}</Text>
                <Text style={styles.menuCardSubtitle}>{card.reassurance}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.footer}>
            <TouchableOpacity
              onPress={() => router.replace('/(tabs)/home')}
              activeOpacity={0.6}
              hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
              style={styles.backLinkWrap}
            >
              <Text style={styles.backLink}>Back to Home</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'error') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.centerWrap}>
          <Text style={styles.kicker}>REST DAY</Text>
          <Text style={styles.errorText}>{errorMsg || 'Something went wrong.'}</Text>
          <Button title="Back to Home" variant="ghost" onPress={() => router.replace('/(tabs)/home')} />
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'complete') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.centerWrap}>
          <Text style={[styles.kicker, { color: colors.accentPositive }]}>
            {(session?.workoutType || 'Session').toUpperCase()} · DONE
          </Text>
          <Text style={styles.completeHeadline}>Logged.</Text>
          <Text style={styles.completeBody}>
            {queuedOffline
              ? "Saved locally — we'll sync next time you open the app."
              : "Nice. Counts toward your streak."}
          </Text>
          <View style={{ height: layout.spacing.lg }} />
          <Button title="Back to Home" onPress={() => router.replace('/(tabs)/home')} />
        </View>
      </SafeAreaView>
    );
  }

  // phase === 'ready' or 'saving' — mirrors the active-workout exercise
  // presentation in app/workout.tsx. Stacked cards, one per exercise, each
  // with the same big-image + title + dose layout. No weight or RIR input
  // (would feed the load engine and break the exclusion boundary).
  const isSaving = phase === 'saving';
  const title = session?.workoutType || 'Session';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.preTitle}>Today</Text>
        <Text style={styles.preSubtitle}>{title.toUpperCase()}</Text>
        {session?.note ? (
          <Text style={[styles.note, { color: colors.accentPositive }]}>{session.note}</Text>
        ) : null}

        <TouchableOpacity
          onPress={backToMenu}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
          style={styles.repickLinkWrap}
          accessibilityRole="button"
          accessibilityLabel="Pick a different category"
        >
          <Text style={styles.repickLink}>← Pick a different category</Text>
        </TouchableOpacity>

        <View style={styles.list}>
          {session?.exercises.map((ex, idx) => (
            <RecoveryExerciseCard
              key={ex.name}
              ex={ex}
              index={idx}
              total={session.exercises.length}
              styles={styles}
              colors={colors}
              imageBroken={!!(ex.imageUrl && brokenImageUrls.has(ex.imageUrl))}
              onImageError={() => ex.imageUrl && markImageBroken(ex.imageUrl)}
            />
          ))}
        </View>

        {errorMsg ? <Text style={styles.errorInline}>{errorMsg}</Text> : null}

        <View style={styles.footer}>
          <TouchableOpacity
            style={[
              styles.finishBtn,
              { backgroundColor: colors.accentTeal },
              isSaving && { opacity: 0.6 },
            ]}
            onPress={handleFinish}
            disabled={isSaving}
            activeOpacity={0.8}
          >
            <Text style={styles.finishBtnText}>{isSaving ? 'SAVING…' : 'FINISH'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.replace('/(tabs)/home')}
            disabled={isSaving}
            activeOpacity={0.6}
            hitSlop={{ top: 10, bottom: 10, left: 12, right: 12 }}
            style={styles.backLinkWrap}
          >
            <Text style={styles.backLink}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Exercise card ────────────────────────────────────────────────────────
// Visual language mirrors the active-workout card in app/workout.tsx:
// large image at top, big title, dose + cue below. Image rendering reuses
// the brokenImageUrls + onError + neutral-placeholder pattern so a remote
// 404 falls through to a per-category fallback block, never a gap.

interface ExerciseCardProps {
  ex: RecoverySessionExercise;
  index: number;
  total: number;
  styles: ReturnType<typeof makeStyles>;
  colors: any;
  imageBroken: boolean;
  onImageError: () => void;
}

function RecoveryExerciseCard({
  ex, index, total, styles, colors, imageBroken, onImageError,
}: ExerciseCardProps) {
  const dose = ex.setsReps ?? ex.duration ?? '';
  const showImage = !!ex.imageUrl && !imageBroken;
  // Per-category monogram derived from the exercise's own (category, area)
  // — keeps a mixed-bag session showing per-item glyphs rather than one
  // shared category letter.
  const glyph = fallbackGlyphFor(ex);
  return (
    <View style={styles.exCard}>
      {showImage ? (
        <Image
          source={{ uri: ex.imageUrl }}
          style={styles.exImage}
          resizeMode="cover"
          onError={onImageError}
        />
      ) : (
        <View style={[styles.exImage, styles.exImageFallback]}>
          <Text style={styles.exImageGlyph}>{glyph}</Text>
        </View>
      )}

      <Text style={styles.exIndex}>{String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</Text>
      <Text style={[styles.exName, { color: colors.textPrimary }]} numberOfLines={2}>
        {ex.name}
      </Text>
      {dose ? (
        <Text style={[styles.exDose, { color: colors.textSecondary }]}>{dose}</Text>
      ) : null}
      <Text style={[styles.exCue, { color: colors.textMuted }]} numberOfLines={3}>
        {ex.cue}
      </Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────

function makeStyles(colors: any) {
  return StyleSheet.create({
    safeArea: { flex: 1 },
    scrollContent: {
      paddingHorizontal: layout.spacing.lg,
      paddingTop: layout.spacing.lg,
      paddingBottom: layout.spacing.xxl,
    },
    centerWrap: {
      flex: 1,
      paddingHorizontal: layout.spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: layout.spacing.md,
    },
    kicker: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      letterSpacing: 1.4,
      color: colors.accentPositive,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    headline: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s28,
      letterSpacing: -0.4,
      color: colors.textPrimary,
      marginBottom: 6,
    },
    note: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      lineHeight: 20,
      marginBottom: layout.spacing.lg,
      letterSpacing: 0.1,
    },
    subhead: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      color: colors.textSecondary,
      marginBottom: layout.spacing.lg,
      letterSpacing: 0.1,
    },
    menuList: { gap: 10 },
    menuCard: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      paddingVertical: layout.spacing.md,
      paddingHorizontal: layout.spacing.md,
    },
    menuCardTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s18,
      letterSpacing: 0.2,
      color: colors.textPrimary,
      marginBottom: 4,
    },
    menuCardSubtitle: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      lineHeight: 18,
      color: colors.textSecondary,
      letterSpacing: 0.1,
    },
    repickLinkWrap: {
      alignSelf: 'flex-start',
      paddingVertical: 6,
      marginBottom: layout.spacing.md,
    },
    repickLink: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      color: colors.textSecondary,
      letterSpacing: 0.3,
    },
    loadingText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    errorText: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s15,
      lineHeight: 21,
      color: colors.textPrimary,
      textAlign: 'center',
      marginBottom: layout.spacing.md,
    },
    errorInline: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      lineHeight: 18,
      color: colors.accentRed,
      marginTop: layout.spacing.md,
    },
    // ── Header (mirrors workout.tsx pre/active title styling) ─────────
    preTitle: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s28,
      letterSpacing: -0.4,
      color: colors.textPrimary,
      marginBottom: 4,
    },
    preSubtitle: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      letterSpacing: 2,
      color: colors.textMuted,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    // ── Exercise card (mirrors workout.tsx active card) ───────────────
    list: { gap: layout.spacing.md },
    exCard: {
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      paddingBottom: layout.spacing.md,
      overflow: 'hidden',
    },
    exImage: {
      width: '100%',
      height: 180,
      backgroundColor: colors.surfaceElevated,
      marginBottom: layout.spacing.md,
    },
    exImageFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    exImageGlyph: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s56,
      color: colors.textMuted,
    },
    exIndex: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s11,
      letterSpacing: 1.4,
      color: colors.textMuted,
      paddingHorizontal: layout.spacing.md,
      marginBottom: 4,
    },
    exName: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s22,
      letterSpacing: -0.2,
      paddingHorizontal: layout.spacing.md,
      marginBottom: 4,
    },
    exDose: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      letterSpacing: 0.1,
      paddingHorizontal: layout.spacing.md,
      marginBottom: 6,
    },
    exCue: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s12,
      lineHeight: 17,
      letterSpacing: 0.1,
      paddingHorizontal: layout.spacing.md,
    },
    // ── Footer ────────────────────────────────────────────────────────
    footer: {
      marginTop: layout.spacing.xl,
      gap: layout.spacing.sm,
    },
    finishBtn: {
      height: 52,
      borderRadius: layout.cardRadius,
      justifyContent: 'center',
      alignItems: 'center',
    },
    finishBtnText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s13,
      color: colors.background,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    completeHeadline: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.s28,
      color: colors.textPrimary,
      marginBottom: layout.spacing.sm,
      textAlign: 'center',
    },
    completeBody: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s14,
      lineHeight: 20,
      color: colors.textSecondary,
      textAlign: 'center',
      maxWidth: 320,
    },
    backLinkWrap: {
      alignSelf: 'center',
      paddingVertical: 6,
      marginTop: 4,
    },
    backLink: {
      fontFamily: typography.family.body,
      fontSize: typography.size.s13,
      color: colors.textSecondary,
      letterSpacing: 0.3,
    },
  });
}
