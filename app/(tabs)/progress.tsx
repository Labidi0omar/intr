import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../../src/context/ThemeContext';
import { supabase } from '../../src/lib/supabase';
import { EXERCISES } from '../../src/constants/exercises';
import { layout, typography } from '../../src/theme';
import EmptyState from '../../src/components/EmptyState';
import PillFilter from '../../src/components/PillFilter';
import { MUSCLE_GROUP_ORDER, normalizeMuscle } from '../../src/utils/muscleGroups';
import { computeEffortZoneFromLogs } from '../../src/utils/dashboardStats';

type ExerciseLog = {
    id: string;
    exercise_name: string;
    weight_kg: number;
    logged_date: string;
    created_at: string;
    reps_in_reserve?: number | null;
};

type ExerciseGroup = {
    name: string;
    logs: ExerciseLog[];
};

const CHART_WIDTH = 300;
const CHART_HEIGHT = 120;
const PADDING = 16;

function computeCurvePath(pts: { x: number; y: number }[]) {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;
    let d = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const cpx = (p0.x + p1.x) / 2;
        d += ` C ${cpx},${p0.y} ${cpx},${p1.y} ${p1.x},${p1.y}`;
    }
    return d;
}

function ExerciseChart({ logs, colors }: { logs: ExerciseLog[]; colors: any }) {
    const sorted = [...logs].sort(
        (a, b) => new Date(a.logged_date).getTime() - new Date(b.logged_date).getTime()
    );

    const weights = sorted.map(l => l.weight_kg);
    const minW = Math.min(...weights);
    const maxW = Math.max(...weights);
    const range = maxW - minW === 0 ? 1 : maxW - minW;

    const points = sorted.map((log, i) => {
        const x = PADDING + (i / Math.max(sorted.length - 1, 1)) * (CHART_WIDTH - PADDING * 2);
        const y = CHART_HEIGHT - PADDING - ((log.weight_kg - minW) / range) * (CHART_HEIGHT - PADDING * 2);
        return { x, y, log };
    });

    const curvePath = computeCurvePath(points);
    const bottomY = CHART_HEIGHT - PADDING;
    const areaPath = points.length > 1
        ? `${computeCurvePath(points)} L ${points[points.length - 1].x},${bottomY} L ${points[0].x},${bottomY} Z`
        : '';

    const firstDate = sorted[0].logged_date;
    const lastDate = sorted[sorted.length - 1].logged_date;
    const formatDate = (d: string) => {
        const parts = d.split('-');
        return `${parts[2]}/${parts[1]}`;
    };

    const styles = makeStyles(colors);

    return (
        <View style={styles.chartContainer}>
            <Svg width={CHART_WIDTH} height={CHART_HEIGHT}>
                <Defs>
                    <LinearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <Stop offset="0" stopColor={colors.accentTeal} stopOpacity="0.25" />
                        <Stop offset="1" stopColor={colors.accentTeal} stopOpacity="0" />
                    </LinearGradient>
                </Defs>
                <Line
                    x1={PADDING} y1={CHART_HEIGHT - PADDING}
                    x2={CHART_WIDTH - PADDING} y2={CHART_HEIGHT - PADDING}
                    stroke={colors.textSecondary + '20'} strokeWidth={1}
                />
                {areaPath ? (
                    <Path
                        d={areaPath}
                        fill="url(#chartGrad)"
                    />
                ) : null}
                <Path
                    d={curvePath}
                    stroke={colors.accentTeal}
                    strokeWidth={2}
                    fill="none"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
                {points.map((p, i) => (
                    <Circle
                        key={i} cx={p.x} cy={p.y} r={3}
                        fill={colors.accentTeal}
                        stroke={colors.background} strokeWidth={1.5}
                    />
                ))}
                <SvgText x={PADDING} y={CHART_HEIGHT} fontSize={10} fill={colors.textSecondary} fontFamily={typography.family.body}>
                    {formatDate(firstDate)}
                </SvgText>
                {sorted.length > 1 ? (
                    <SvgText x={CHART_WIDTH - PADDING} y={CHART_HEIGHT} fontSize={10} fill={colors.textSecondary} fontFamily={typography.family.body} textAnchor="end">
                        {formatDate(lastDate)}
                    </SvgText>
                ) : null}
            </Svg>

            <View style={styles.chartMeta}>
                <Text style={styles.chartMetaText}>
                    Start: <Text style={styles.chartMetaValue}>{sorted[0].weight_kg} kg</Text>
                </Text>
                <Text style={styles.chartMetaText}>
                    Latest: <Text style={[styles.chartMetaValue, { color: colors.accentTeal }]}>
                        {sorted[sorted.length - 1].weight_kg} kg
                    </Text>
                </Text>
                {maxW > sorted[0].weight_kg ? (
                    <Text style={styles.chartMetaText}>
                        PR: <Text style={[styles.chartMetaValue, { color: colors.accentAmber }]}>{maxW} kg</Text>
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

function ExerciseCard({ group, colors }: { group: ExerciseGroup; colors: any }) {
    const styles = makeStyles(colors);

    if (group.logs.length === 1) {
        return (
            <View style={styles.card}>
                <Text style={styles.exerciseName}>{group.name}</Text>
                <Text style={styles.singleLogText}>Only 1 session logged — keep going!</Text>
            </View>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.exerciseName}>{group.name}</Text>
            <View style={styles.sessionBadge}>
                <Text style={styles.sessionCount}>{group.logs.length} sessions</Text>
            </View>
            <ExerciseChart logs={group.logs} colors={colors} />
        </View>
    );
}

export default function ProgressScreen() {
    const { colors } = useTheme();
    const styles = makeStyles(colors);
    const [loading, setLoading] = useState(true);
    const [groups, setGroups] = useState<ExerciseGroup[]>([]);
    const [showMuscleSheet, setShowMuscleSheet] = useState(false);
    const [selectedMuscle, setSelectedMuscle] = useState('ALL');
    const [muscleGroups, setMuscleGroups] = useState<string[]>([]);
    const [filteredGroups, setFilteredGroups] = useState<ExerciseGroup[]>([]);
    // Target-effort-zone trend: the last N sets the user RATED with an RIR,
    // and how many landed in RIR 1–2. Honest framing — this is the user's own
    // record of effort calibration, not a causal claim about the coach.
    const [effortTrend, setEffortTrend] = useState<{ hits: number; total: number } | null>(null);

    useFocusEffect(
        React.useCallback(() => {
            fetchLogs();
        }, [])
    );

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { data } = await supabase
                .from('exercise_logs')
                .select('*')
                .eq('user_id', user.id)
                // EXCLUSION BOUNDARY: progress display + effort zone share
                // the same data; recovery rows must not skew either.
                .eq('is_recovery', false)
                .order('logged_date', { ascending: true });

            if (!data || data.length === 0) { setGroups([]); setEffortTrend(null); return; }

            // Effort-trend summary — shared with the Home dashboard.
            // computeEffortZoneFromLogs takes ASC-by-date logs and counts
            // the most recent 30 rated sets that landed in RIR 1–2.
            setEffortTrend(computeEffortZoneFromLogs(data as any));

            const map: Record<string, ExerciseLog[]> = {};
            for (const log of data as ExerciseLog[]) {
                if (!map[log.exercise_name]) map[log.exercise_name] = [];
                map[log.exercise_name].push(log);
            }

            const grouped: ExerciseGroup[] = Object.entries(map).map(([name, logs]) => ({ name, logs }));
            grouped.sort((a, b) => b.logs.length - a.logs.length);
            setGroups(grouped);

            // Always show all five top-level groups so the user can tap any of
            // them. Categories with no data fall through to the "no matches"
            // empty state below.
            setMuscleGroups([...MUSCLE_GROUP_ORDER]);
            setFilteredGroups(grouped);
        } catch (e) {
            // Progress fetch failed silently
        } finally {
            setLoading(false);
        }
    };

    // Filter groups by selected top-level muscle group
    useEffect(() => {
        if (selectedMuscle === 'ALL') {
            setFilteredGroups(groups);
        } else {
            const matchingExercises = new Set(
                EXERCISES
                    .filter(e => normalizeMuscle(e.primaryMuscle) === selectedMuscle)
                    .map(e => e.name)
            );
            setFilteredGroups(groups.filter(g => matchingExercises.has(g.name)));
        }
    }, [selectedMuscle, groups]);

    return (
        <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <Text style={styles.heading}>Progress</Text>

                {/* Effort-trend card — your own record of where your sets
                    have been landing on the RIR scale lately. Honest framing:
                    we report what YOU logged, no causal claims about the
                    coach making you stronger. */}
                {!loading && effortTrend ? (
                    effortTrend.total === 0 ? (
                        <View style={styles.effortCard}>
                            <Text style={styles.effortEyebrow}>EFFORT TREND</Text>
                            <Text style={styles.effortBody}>
                                Log a few sets with effort ratings and your trend shows up here.
                            </Text>
                        </View>
                    ) : (
                        <View style={styles.effortCard}>
                            <Text style={styles.effortEyebrow}>EFFORT TREND</Text>
                            <Text style={styles.effortHeadline}>
                                You hit your target effort zone{' '}
                                <Text style={{ color: colors.accentTeal }}>
                                    {effortTrend.hits} of your last {effortTrend.total}
                                </Text>{' '}
                                sets.
                            </Text>
                            <View style={styles.effortBarTrack}>
                                <View
                                    style={[
                                        styles.effortBarFill,
                                        { width: `${Math.round((effortTrend.hits / effortTrend.total) * 100)}%` },
                                    ]}
                                />
                            </View>
                            <Text style={styles.effortFootnote}>
                                Target zone = 1–2 reps left in reserve (RIR). Your raw record,
                                pulled from the sets you rated.
                            </Text>
                        </View>
                    )
                ) : null}

                {/* Muscle-group pill filter */}
                {muscleGroups.length > 0 && (
                    <View style={styles.pillFilterWrap}>
                        <PillFilter
                            options={['ALL', ...muscleGroups]}
                            selected={selectedMuscle}
                            onSelect={setSelectedMuscle}
                        />
                    </View>
                )}

                {loading ? (
                    <View style={styles.centerState}>
                        <Text style={styles.stateText}>Loading...</Text>
                    </View>
                ) : groups.length === 0 ? (
                    <EmptyState
                        title="Nothing logged yet"
                        body="Finish a workout and log the weight you used. Your progress shows up here."
                    />
                ) : filteredGroups.length === 0 ? (
                    <EmptyState
                        title="No matches"
                        body="Nothing logged for this muscle group yet."
                    />
                ) : (
                    filteredGroups.map(group => (
                        <ExerciseCard key={group.name} group={group} colors={colors} />
                    ))
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
        paddingBottom: layout.spacing.xxl,
    },
    heading: {
        fontFamily: typography.family.heading,
        fontSize: typography.size.xl,
        color: colors.textPrimary,
        marginBottom: layout.spacing.xl,
        letterSpacing: typography.letterSpacing.mono,
    },
    filterLabel: {
        marginBottom: layout.spacing.lg,
        alignSelf: 'flex-start',
    },
    pillFilterWrap: {
        marginHorizontal: -layout.spacing.lg,
        marginBottom: layout.spacing.lg,
    },
    filterLabelText: {
        fontFamily: typography.family.body,
        fontSize: 11,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    // Modal bottom sheet
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: layout.cardRadius,
        borderTopRightRadius: layout.cardRadius,
        padding: layout.spacing.lg,
        paddingBottom: layout.spacing.xl,
        borderWidth: 1,
        borderColor: colors.cardBorder,
        borderBottomWidth: 0,
    },
    modalHandle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: colors.textMuted,
        alignSelf: 'center',
        marginBottom: layout.spacing.md,
    },
    sheetOption: {
        paddingVertical: layout.spacing.md,
        paddingHorizontal: layout.spacing.md,
        borderLeftWidth: 1,
        borderLeftColor: 'transparent',
        marginBottom: layout.spacing.xs,
    },
    sheetOptionActive: {
        borderLeftColor: colors.borderActive,
    },
    sheetOptionText: {
        fontFamily: typography.family.bodyMedium,
        fontSize: 14,
        color: colors.textPrimary,
        textTransform: 'uppercase',
    },
    card: {
        backgroundColor: colors.surface,
        borderWidth: layout.borderWidth,
        borderColor: colors.cardBorder,
        borderRadius: layout.cardRadius,
        padding: layout.spacing.lg,
        marginBottom: layout.spacing.lg,
        alignItems: 'flex-start',
    },
    // Effort trend card — mirrors `card` styling with a small ratio bar.
    effortCard: {
        backgroundColor: colors.surface,
        borderWidth: layout.borderWidth,
        borderColor: colors.cardBorder,
        borderRadius: layout.cardRadius,
        padding: layout.spacing.lg,
        marginBottom: layout.spacing.lg,
    },
    effortEyebrow: {
        fontFamily: typography.family.bodyMedium,
        fontSize: 11,
        color: colors.textMuted,
        letterSpacing: 2,
        marginBottom: layout.spacing.sm,
    },
    effortHeadline: {
        fontFamily: typography.family.body,
        fontSize: 16,
        color: colors.textPrimary,
        lineHeight: 22,
        marginBottom: layout.spacing.md,
    },
    effortBody: {
        fontFamily: typography.family.body,
        fontSize: 14,
        color: colors.textSecondary,
        lineHeight: 20,
    },
    effortBarTrack: {
        height: 6,
        backgroundColor: colors.cardBorder,
        borderRadius: 3,
        overflow: 'hidden',
        marginBottom: layout.spacing.sm,
    },
    effortBarFill: {
        height: '100%',
        backgroundColor: colors.accentTeal,
    },
    effortFootnote: {
        fontFamily: typography.family.body,
        fontSize: 11.5,
        color: colors.textMuted,
        lineHeight: 16,
    },
    exerciseName: {
        fontFamily: typography.family.heading,
        fontSize: typography.size.md,
        color: colors.textPrimary,
        marginBottom: 2,
    },
    sessionBadge: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.accentTeal,
        borderRadius: layout.pillRadius,
        paddingHorizontal: layout.spacing.sm,
        paddingVertical: 2,
        marginBottom: layout.spacing.md,
    },
    sessionCount: {
        fontFamily: typography.family.body,
        fontSize: typography.size.sm,
        color: colors.textSecondary,
    },
    singleLogText: {
        fontFamily: typography.family.body,
        fontSize: typography.size.sm,
        color: colors.textSecondary,
        marginTop: 4,
    },
    chartContainer: {
        alignItems: 'center',
    },
    chartMeta: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        width: CHART_WIDTH,
        marginTop: layout.spacing.sm,
    },
    chartMetaText: {
        fontFamily: typography.family.body,
        fontSize: typography.size.xs,
        color: colors.textSecondary,
    },
    chartMetaValue: {
        fontFamily: typography.family.bodyMedium,
        color: colors.textPrimary,
    },
    centerState: {
        alignItems: 'center',
        paddingTop: 80,
    },
    emptyEmoji: {
        fontSize: layout.spacing.xxl,
        marginBottom: layout.spacing.lg,
    },
    emptyTitle: {
        fontFamily: typography.family.heading,
        fontSize: typography.size.lg,
        color: colors.textPrimary,
        marginBottom: layout.spacing.sm,
    },
    emptyBody: {
        fontFamily: typography.family.body,
        fontSize: typography.size.md,
        color: colors.textSecondary,
        textAlign: 'center',
        maxWidth: 280,
        lineHeight: 22,
    },
    stateText: {
        fontFamily: typography.family.body,
        fontSize: typography.size.md,
        color: colors.textSecondary,
    },
});