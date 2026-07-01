import { useState, useEffect } from 'react';
import { Dumbbell, RotateCcw, Layers, Brain } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  fetchSessions, fetchExerciseLogs, fetchExerciseCatalog, fetchJournals,
  daysAgoISO, todayISO, errMessage,
  type SessionRow, type ExerciseLogRow, type ExerciseCatalogRow, type JournalRow,
} from '../utils/adminQueries';

const TYPE_PALETTE = ['#87A96B', '#60A5FA', '#A78BFA', '#F59E0B', '#EF4444', '#34D399', '#F472B6'];

const ENERGY_META: Record<string, { label: string; color: string }> = {
  high:   { label: 'High',   color: '#87A96B' },
  normal: { label: 'Normal', color: '#60A5FA' },
  low:    { label: 'Low',    color: '#EF4444' },
};

interface WorkoutTypeStat { type: string; sessions: number; completion: number; color: string; }
interface EnergyStat { tag: string; count: number; color: string; }
interface ExerciseStat { name: string; logs: number; pr_rate: number; muscle: string; }

interface ContentData {
  completionRate: number;
  recoveryThisMonth: number;
  avgRir: number | null;
  rirSamples: number;
  journals30d: number;
  uniqueJournalers: number;
  workoutTypes: WorkoutTypeStat[];
  energy: EnergyStat[];
  exercises: ExerciseStat[];
}

const EMPTY: ContentData = {
  completionRate: 0, recoveryThisMonth: 0, avgRir: null, rirSamples: 0,
  journals30d: 0, uniqueJournalers: 0, workoutTypes: [], energy: [], exercises: [],
};

function compute(
  sessions: SessionRow[],
  logs: ExerciseLogRow[],
  catalog: ExerciseCatalogRow[],
  journals: JournalRow[],
): ContentData {
  const today = todayISO();
  const monthStart = `${today.slice(0, 7)}-01`;
  const thirtyAgo = daysAgoISO(30);

  const training = sessions.filter(s => s.is_recovery !== true);

  // Completion rate over past planned non-recovery sessions
  const pastPlanned = training.filter(s => (s.planned_date ?? '') <= today);
  const completedPast = pastPlanned.filter(s => s.completed === true).length;
  const completionRate = pastPlanned.length > 0
    ? parseFloat(((completedPast / pastPlanned.length) * 100).toFixed(1))
    : 0;

  const recoveryThisMonth = sessions.filter(
    s => s.is_recovery === true && (s.planned_date ?? '') >= monthStart,
  ).length;

  // Avg reps-in-reserve (real prescription-adherence proxy)
  const rirVals = logs.map(l => l.reps_in_reserve).filter((v): v is number => v != null);
  const avgRir = rirVals.length > 0
    ? parseFloat((rirVals.reduce((a, b) => a + b, 0) / rirVals.length).toFixed(1))
    : null;

  // Journal check-ins (30d)
  const recentJournals = journals.filter(j => (j.date ?? '') >= thirtyAgo);
  const journals30d = recentJournals.length;
  const uniqueJournalers = new Set(recentJournals.map(j => j.user_id)).size;

  // Sessions by workout type
  const typeMap = new Map<string, { total: number; completed: number }>();
  training.forEach(s => {
    const key = s.workout_type ?? 'Unspecified';
    const e = typeMap.get(key) ?? { total: 0, completed: 0 };
    e.total++;
    if (s.completed === true) e.completed++;
    typeMap.set(key, e);
  });
  const workoutTypes: WorkoutTypeStat[] = Array.from(typeMap.entries())
    .map(([type, { total, completed }], i) => ({
      type,
      sessions: total,
      completion: total > 0 ? Math.round((completed / total) * 100) : 0,
      color: TYPE_PALETTE[i % TYPE_PALETTE.length],
    }))
    .sort((a, b) => b.sessions - a.sessions);

  // Energy-level distribution on completed non-recovery sessions
  const energyMap = new Map<string, number>();
  training.forEach(s => {
    if (!s.completed || !s.energy_level) return;
    energyMap.set(s.energy_level, (energyMap.get(s.energy_level) ?? 0) + 1);
  });
  const energy: EnergyStat[] = ['high', 'normal', 'low']
    .filter(k => energyMap.has(k))
    .map(k => ({ tag: ENERGY_META[k].label, count: energyMap.get(k) ?? 0, color: ENERGY_META[k].color }));

  // Exercise log frequency + real PR rate (new per-user max weight)
  const muscleByName = new Map<string, string>();
  catalog.forEach(e => { if (e.name) muscleByName.set(e.name.toLowerCase(), e.primary_muscle ?? '—'); });

  const byExercise = new Map<string, ExerciseLogRow[]>();
  logs.forEach(l => {
    if (!l.exercise_name) return;
    const list = byExercise.get(l.exercise_name) ?? [];
    list.push(l);
    byExercise.set(l.exercise_name, list);
  });

  const exercises: ExerciseStat[] = Array.from(byExercise.entries())
    .map(([name, rows]) => {
      // running max weight per user → a log that beats prior max counts as a PR
      const userMax = new Map<string, number>();
      let prs = 0;
      let weighted = 0;
      [...rows]
        .sort((a, b) => (a.logged_date ?? '').localeCompare(b.logged_date ?? ''))
        .forEach(r => {
          if (r.weight_kg == null) return;
          weighted++;
          const prev = userMax.get(r.user_id);
          if (prev == null || r.weight_kg > prev) {
            if (prev != null) prs++; // first-ever log isn't a "PR beat"
            userMax.set(r.user_id, r.weight_kg);
          }
        });
      const pr_rate = weighted > 0 ? parseFloat(((prs / weighted) * 100).toFixed(1)) : 0;
      return {
        name,
        logs: rows.length,
        pr_rate,
        muscle: muscleByName.get(name.toLowerCase()) ?? '—',
      };
    })
    .sort((a, b) => b.logs - a.logs)
    .slice(0, 10);

  return {
    completionRate, recoveryThisMonth, avgRir, rirSamples: rirVals.length,
    journals30d, uniqueJournalers, workoutTypes, energy, exercises,
  };
}

const CTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{value: number; name: string; color?: string}>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      <p className="text-[11px] font-mono text-[#4B5563] mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="text-[12px] font-semibold text-[#E5E7EB]">{p.value} {p.name}</div>
      ))}
    </div>
  );
};

export default function ContentWorkoutPage() {
  const [data, setData] = useState<ContentData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [sessions, logs, catalog, journals] = await Promise.all([
          fetchSessions(), fetchExerciseLogs(), fetchExerciseCatalog(), fetchJournals(),
        ]);
        if (!active) return;
        setData(compute(sessions, logs, catalog, journals));
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load workout content.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const energyTotal = data.energy.reduce((s, x) => s + x.count, 0);
  const maxLogs = data.exercises[0]?.logs ?? 1;

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3 flex-shrink-0">
        <MetricCard label="Session Completion Rate" value={`${data.completionRate}%`} subValue="of planned sessions completed" icon={Dumbbell} accent="sage" loading={loading} />
        <MetricCard label="Recovery Sessions" value={data.recoveryThisMonth.toLocaleString()} subValue="is_recovery = true · this month" icon={RotateCcw} accent="blue" loading={loading} />
        <MetricCard label="Avg Reps-In-Reserve" value={data.avgRir != null ? `${data.avgRir}` : '—'} subValue={`${data.rirSamples} logged sets`} icon={Layers} accent="purple" loading={loading} />
        <MetricCard label="Journal Check-ins (30d)" value={data.journals30d.toLocaleString()} subValue={`${data.uniqueJournalers} unique users`} icon={Brain} accent="amber" loading={loading} />
      </div>

      {error && (
        <div className="card p-3 text-[11px] text-[#FCA5A5] font-mono border-[#EF4444]/20 flex-shrink-0">{error}</div>
      )}

      {/* Workout type chart + Energy dist */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 260 }}>
        {/* Workout sessions by type */}
        <div className="card flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
            <Dumbbell size={13} className="text-[#87A96B]" />
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Sessions by Workout Type</span>
          </div>
          <div className="flex-1 p-4 pt-2">
            {data.workoutTypes.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.workoutTypes} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.03)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="type" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip content={<CTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
                  <Bar dataKey="sessions" name="sessions" radius={[0, 2, 2, 0]}>
                    {data.workoutTypes.map((w, i) => <Cell key={i} fill={w.color} fillOpacity={0.7} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[11px] text-[#4B5563]">
                {loading ? 'Loading…' : 'No workout sessions logged'}
              </div>
            )}
          </div>
        </div>

        {/* Energy-level distribution */}
        <div className="card flex flex-col" style={{ width: 240 }}>
          <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
            <Brain size={13} className="text-[#F59E0B]" />
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Energy Levels (completed)</span>
          </div>
          <div className="flex-1 p-4 space-y-3 flex flex-col justify-center">
            {energyTotal > 0 ? data.energy.map(m => {
              const pct = ((m.count / energyTotal) * 100).toFixed(1);
              return (
                <div key={m.tag}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium capitalize" style={{ color: m.color }}>{m.tag}</span>
                    <span className="font-mono text-[11px] text-[#4B5563]">{m.count} · {pct}%</span>
                  </div>
                  <div className="h-[5px] bg-[#111] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: m.color, opacity: 0.6 }} />
                  </div>
                </div>
              );
            }) : (
              <div className="text-center text-[11px] text-[#4B5563]">{loading ? 'Loading…' : 'No energy data'}</div>
            )}
          </div>
        </div>
      </div>

      {/* Exercise frequency table */}
      <div className="card flex flex-col flex-1 min-h-0">
        <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
          <Layers size={13} className="text-[#87A96B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB]">Exercise Log Frequency</span>
          <span className="font-mono text-[10px] text-[#4B5563] ml-1">top 10 · all time</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="grid px-4 py-2 border-b border-[#111] bg-[#0a0a0a]" style={{ gridTemplateColumns: '2fr 1fr 80px 80px 200px' }}>
            {['Exercise', 'Muscle', 'Logs', 'PR Rate', 'Log Freq'].map(h => (
              <span key={h} className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">{h}</span>
            ))}
          </div>
          {data.exercises.map((ex, i) => (
            <div key={ex.name} className="grid px-4 py-[9px] border-b border-[#0d0d0d] hover:bg-white/[0.015] items-center transition-colors" style={{ gridTemplateColumns: '2fr 1fr 80px 80px 200px' }}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-[#4B5563] w-4">{i + 1}.</span>
                <span className="text-[12px] text-[#E5E7EB] font-medium">{ex.name}</span>
              </div>
              <span className="text-[11px] text-[#9CA3AF] capitalize">{ex.muscle}</span>
              <span className="font-mono text-[12px] text-[#E5E7EB]">{ex.logs.toLocaleString()}</span>
              <span className={`font-mono text-[12px] ${ex.pr_rate > 10 ? 'text-[#87A96B]' : 'text-[#9CA3AF]'}`}>
                {ex.pr_rate}%
              </span>
              <div className="h-[4px] bg-[#111] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(ex.logs / maxLogs) * 100}%`,
                    background: 'linear-gradient(90deg, #87A96B, rgba(135,169,107,0.4))',
                  }}
                />
              </div>
            </div>
          ))}
          {!loading && data.exercises.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[11px] text-[#4B5563]">No exercise logs found</div>
          )}
        </div>
      </div>
    </div>
  );
}
