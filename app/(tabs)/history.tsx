import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Button from '../../src/components/Button';
import EmptyState from '../../src/components/EmptyState';
import PillFilter from '../../src/components/PillFilter';
import WeekStrip from '../../src/components/WeekStrip';
import { MUSCLE_GROUP_ORDER, normalizeMuscle } from '../../src/utils/muscleGroups';
import { reportSilent } from '../../src/lib/errorReporting';
import { useTheme } from '../../src/context/ThemeContext';
import { supabase } from '../../src/lib/supabase';
import { layout, typography } from '../../src/theme';
import { calculateMonthlyConsistency, getLastSevenDays } from '../../src/utils/streak';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type WorkoutSession = {
  id: string;
  type?: string;
  workout_type: string;
  targets?: string;
  date?: string;
  planned_date: string;
  completed_at: string;
  completed: boolean;
  duration_minutes: number;
  exercises_done: any[];
};

type GroupedHistory = {
  monthLabel: string;
  sessions: WorkoutSession[];
};

const Skeleton = ({ width, height, style, borderRadius = 8, colors }: any) => {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true })
      ])
    ).start();
  }, [opacity]);
  return <Animated.View style={[{ width, height, backgroundColor: colors.textMuted + '30', borderRadius, opacity }, style]} />;
};

export default function HistoryScreen() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [consistency, setConsistency] = useState({ completedCount: 0, plannedCount: 0, percentage: 0 });
  const [lastSevenDays, setLastSevenDays] = useState<any[]>([]);
  const [historyGroups, setHistoryGroups] = useState<GroupedHistory[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filteredGroups, setFilteredGroups] = useState<GroupedHistory[]>([]);
  const [muscleGroups, setMuscleGroups] = useState<string[]>([]);
  const [selectedMuscle, setSelectedMuscle] = useState<string>('ALL');

  useEffect(() => { fetchHistoryData(); }, []);

  const fetchHistoryData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [consistencyRes, sevenDaysRes] = await Promise.all([
        calculateMonthlyConsistency(user.id),
        getLastSevenDays(user.id)
      ]);

      setConsistency(consistencyRes);
      setLastSevenDays(sevenDaysRes);

      const sessionsRes = await supabase
        .from('workout_sessions')
        .select('*')
        .eq('user_id', user.id)
        .eq('completed', true)
        .order('completed_at', { ascending: false });


      if (sessionsRes.data) {
        const groups = groupSessionsByMonth(sessionsRes.data as WorkoutSession[]);
        setHistoryGroups(groups);
        setFilteredGroups(groups);

        // Always show all five top-level groups; empty categories show the
        // "no matches" empty state when tapped.
        setMuscleGroups([...MUSCLE_GROUP_ORDER]);
      }
    } catch (e) {
      reportSilent(e, 'history:fetchSessions');
    } finally {
      setLoading(false);
    }
  };

  const groupSessionsByMonth = (sessions: WorkoutSession[]) => {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const groups: Record<string, WorkoutSession[]> = {};
    sessions.forEach(session => {
      const d = new Date(session.completed_at || session.date || '');
      const label = `${months[d.getMonth()]} ${d.getFullYear()}`;
      if (!groups[label]) groups[label] = [];
      groups[label].push(session);
    });
    return Object.keys(groups).map(key => ({ monthLabel: key, sessions: groups[key] }));
  };

  const toggleExpand = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Filter history by selected muscle group
  useEffect(() => {
    if (selectedMuscle === 'ALL') {
      setFilteredGroups(historyGroups);
      return;
    }
    const filtered = historyGroups.map(group => ({
      ...group,
      sessions: group.sessions.filter(s => {
        if (!s.exercises_done || !Array.isArray(s.exercises_done)) return false;
        return s.exercises_done.some((ex: any) =>
          normalizeMuscle(ex.primaryMuscle) === selectedMuscle
        );
      }),
    })).filter(g => g.sessions.length > 0);
    setFilteredGroups(filtered);
  }, [selectedMuscle, historyGroups]);

// ─── RENDER ─────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[styles.safeArea, { overflow: 'visible' }]} edges={['left', 'right']}>
      <ScrollView contentContainerStyle={[styles.scrollContent, { overflow: 'visible' }]} style={{ overflow: 'visible' }} showsVerticalScrollIndicator={false}>

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Your History</Text>
          <Text style={styles.headerSubtitle}>Every session counts</Text>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <Skeleton width="100%" height={120} borderRadius={layout.cardRadius} colors={colors} />
            <Skeleton width="100%" height={80} borderRadius={layout.cardRadius} style={{ marginTop: 24 }} colors={colors} />
            <Skeleton width="100%" height={200} borderRadius={layout.cardRadius} style={{ marginTop: 24 }} colors={colors} />
          </View>
        ) : (
          <>
            <View style={styles.consistencyBanner}>
              <Text style={styles.consistencyText}>
                This month: <Text style={{ fontWeight: 'bold' }}>{consistency.completedCount} of {consistency.plannedCount}</Text> planned sessions completed — {consistency.percentage}%
              </Text>
              <View style={styles.progressBarTrack}>
                <Animated.View style={[styles.progressBarFill, { width: `${consistency.percentage}%` }]} />
              </View>
            </View>

            <View style={{ marginBottom: layout.spacing.xl }}>
              <WeekStrip days={lastSevenDays} />
            </View>

            {/* Muscle-group pill filter */}
            {muscleGroups.length > 0 && (
              <View style={styles.pillFilterWrap}>
                <PillFilter
                  options={['ALL', ...muscleGroups]}
                  selected={selectedMuscle}
                  onSelect={(val) => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setSelectedMuscle(val);
                  }}
                />
              </View>
            )}

            <View style={styles.archiveContainer}>
              {filteredGroups.length === 0 ? (
                historyGroups.length === 0 ? (
                  <EmptyState
                    title="No sessions yet"
                    body="Your history starts with your first session."
                    ctaLabel="Start your first workout"
                    onCtaPress={() => router.replace('/(tabs)/home')}
                  />
                ) : (
                  <EmptyState
                    title="Nothing for this group"
                    body={`No ${selectedMuscle.toLowerCase()} sessions logged yet.`}
                  />
                )
              ) : (
                filteredGroups.map(group => (
                  <View key={group.monthLabel} style={styles.monthGroup}>
                    <Text style={styles.monthHeader}>{group.monthLabel}</Text>
                    <View style={styles.monthList}>
                      {group.sessions.map((session, index) => {
                          const isExpanded = expandedIds.has(session.id);
                          const exerciseCount = session.exercises_done?.length ?? 0;
                          return (
                          <TouchableOpacity
                            key={session.id || index}
                            style={styles.sessionCard}
                            onPress={() => toggleExpand(session.id)}
                            activeOpacity={0.8}
                          >
                            <View style={styles.sessionHeaderRow}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.sessionType}>{session.workout_type}</Text>
                                <Text style={styles.sessionDate}>
                                  {new Date(session.planned_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                                </Text>
                              </View>
                              {!isExpanded && exerciseCount > 0 && (
                                <Text style={styles.exerciseSummary}>{exerciseCount} exercise{exerciseCount !== 1 ? 's' : ''}</Text>
                              )}
                            </View>
                            {isExpanded && session.exercises_done?.map((ex: any, i: number) => (
                              <Text key={i} style={styles.exerciseRow}>
                                {ex.name} — {ex.sets} × {ex.reps}
                              </Text>
                            ))}
                          </TouchableOpacity>
                          );
                      })}
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingHorizontal: layout.spacing.lg,
    paddingTop: layout.spacing.xl,
    paddingBottom: layout.spacing.xxl + layout.spacing.xl,
  },
  header: {
    marginBottom: layout.spacing.xl,
  },
  headerTitle: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xl + 4,
    color: colors.textPrimary,
    letterSpacing: (typography.size.xl + 4) * typography.letterSpacing.heading,
  },
  headerSubtitle: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.md,
    color: colors.textSecondary,
    marginTop: layout.spacing.xs,
  },
  loadingContainer: {
    paddingTop: layout.spacing.md,
  },
  pillFilterWrap: {
    marginHorizontal: -layout.spacing.lg,
    marginBottom: layout.spacing.lg,
  },
  consistencyBanner: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: layout.cardRadius,
    padding: layout.spacing.lg,
    marginBottom: layout.spacing.xl,
  },
  consistencyText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.md,
    color: colors.textPrimary,
    lineHeight: 22,
    marginBottom: layout.spacing.md,
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: colors.sliderTrack,
    borderRadius: layout.radii.r3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 6,
    backgroundColor: colors.accentTeal,
    borderRadius: layout.radii.r3,
  },
  archiveContainer: {
    marginTop: layout.spacing.sm,
  },
  monthGroup: {
    marginBottom: layout.spacing.xl,
  },
  filterLabel: {
    marginBottom: layout.spacing.lg,
    alignSelf: 'flex-start',
  },
  filterLabelText: {
    fontFamily: typography.family.body,
    fontSize: typography.size.s11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  monthHeader: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.sm,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: layout.spacing.md,
  },
  monthList: {
    gap: layout.spacing.sm,
  },
  sessionCard: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: layout.cardRadius,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: colors.accentTeal,
  },
  sessionType: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.s17,
    color: colors.textPrimary,
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  sessionDate: {
    fontSize: typography.size.s14,
    color: colors.textMuted,
    fontFamily: typography.family.body,
  },
  exerciseRow: {
    fontSize: typography.size.s13,
    color: colors.textPrimary,
    marginTop: 4,
    fontFamily: typography.family.body,
  },
  sessionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  exerciseSummary: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xs,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: layout.pillRadius,
    overflow: 'hidden',
  },
});