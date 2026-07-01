import { useState, useEffect } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { TrendingUp, ShieldAlert, AlertTriangle } from 'lucide-react';
import { supabase } from '../utils/supabaseClient';
// Columns used:
//   workout_sessions: planned_date, completed, completed_at, energy_level, is_recovery
//   journal_entries:  date
//   profiles:         id (count only)

const SAGE = '#87A96B';
const BLUE = '#60A5FA';

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="card"
      style={{
        padding: '10px 14px',
        minWidth: 180,
        boxShadow: '0 8px 24px rgba(0,0,0,0.6), 0 0 1px rgba(135,169,107,0.2)',
      }}
    >
      <p className="text-[11px] font-mono text-[#4B5563] mb-2">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4 mb-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="text-[11px] text-[#9CA3AF]">{p.name}</span>
          </div>
          <span className="font-mono text-[12px] font-semibold" style={{ color: p.color }}>
            {p.value}
            {p.name.includes('Completion') ? '%' : ''}
          </span>
        </div>
      ))}
    </div>
  );
};

interface DailyMetricPoint {
  date: string;
  label: string;
  physical_strain: number;   // normalized 0-100
  mental_equilibrium: number; // normalized 0-100
  checkin_completion: number; // % of active users who checked in
  workout_completion: number; // % of planned sessions completed
}

export default function StrainEquilibriumChart() {
  const [dataPoints, setDataPoints] = useState<DailyMetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadTimeSeries() {
      try {
        setLoading(true);
        setError(null);

        // Fetch last 30 days date range
        const dates: Date[] = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          dates.push(d);
        }
        const startDateISO = dates[0].toISOString().split('T')[0];

        // Fetch training workout sessions in range (exclude recovery)
        // Columns: planned_date, completed, completed_at, energy_level
        const { data: sessions, error: sErr } = await supabase
          .from('workout_sessions')
          .select('planned_date, completed, completed_at, energy_level')
          .gte('planned_date', startDateISO)
          .eq('is_recovery', false);
        if (sErr) throw sErr;

        // Fetch journal entries in range
        // Columns: date
        const { data: journals, error: jErr } = await supabase
          .from('journal_entries')
          .select('date')
          .gte('date', startDateISO);
        if (jErr) throw jErr;

        // Profile count for active-user denominator
        const { count: totalProfiles } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true });
        const activeUsersCount = Math.max(5, Math.round((totalProfiles || 100) * 0.7));

        // Group by date
        const sessionMap = new Map<string, typeof sessions>();
        sessions?.forEach(s => {
          const list = sessionMap.get(s.planned_date) || [];
          list.push(s);
          sessionMap.set(s.planned_date, list);
        });

        const journalMap = new Map<string, number>();
        journals?.forEach(j => {
          const count = journalMap.get(j.date) || 0;
          journalMap.set(j.date, count + 1);
        });

        // Generate data points
        const points: DailyMetricPoint[] = dates.map(d => {
          const dateStr = d.toISOString().split('T')[0];
          const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

          const daySessions = sessionMap.get(dateStr) ?? [];
          const completedCount = daySessions.filter(s => s.completed === true).length;
          const plannedCount = daySessions.length;

          // Physical strain: normalize completed training sessions to 0-100
          // 0 sessions = 0, 1 = 40, 2 = 70, 3+ = 100 (diminishing returns curve)
          const physical_strain =
            completedCount === 0 ? 0
            : completedCount === 1 ? 40
            : completedCount === 2 ? 70
            : Math.min(100, 70 + (completedCount - 2) * 10);

          // Mental equilibrium: avg energy_level mapped to 0-100 scale
          // energy_level: 'high' → 90, 'normal' → 65, 'low' → 30, null → skipped
          let mentalSum = 0, mentalCount = 0;
          daySessions.forEach(s => {
            if (!s.completed || !s.energy_level) return;
            const val =
              s.energy_level === 'high' ? 90
              : s.energy_level === 'normal' ? 65
              : 30; // 'low'
            mentalSum += val;
            mentalCount++;
          });
          // When no data for the day, omit the point rather than generating noise
          const mental_equilibrium = mentalCount > 0 ? Math.round(mentalSum / mentalCount) : 0;

          // Workout completion %: completed / planned (0 when no sessions planned)
          const workout_completion = plannedCount > 0
            ? Math.round((completedCount / plannedCount) * 100)
            : 0;

          // Check-in (journal) completion: entries that day / estimated active users
          const dayCheckins = journalMap.get(dateStr) ?? 0;
          const checkin_completion = activeUsersCount > 0
            ? Math.min(100, Math.round((dayCheckins / activeUsersCount) * 100))
            : 0;

          return {
            date: dateStr,
            label,
            physical_strain,
            mental_equilibrium,
            workout_completion,
            checkin_completion,
          };
        });

        // Filter to days that have at least some data (avoids flat-zero noise at chart edges)
        setDataPoints(points.filter(p =>
          p.physical_strain > 0 || p.mental_equilibrium > 0 || p.workout_completion > 0 || p.checkin_completion > 0
        ) || points);
      } catch (err) {
        console.error('Failed to load chart series:', err);
        setError(err instanceof Error ? err.message : 'Database connection error.');
      } finally {
        setLoading(false);
      }
    }

    loadTimeSeries();
  }, []);

  const avg_strain = dataPoints.length > 0 
    ? Math.round(dataPoints.reduce((s, d) => s + d.physical_strain, 0) / dataPoints.length) 
    : 62;
  const avg_equil = dataPoints.length > 0 
    ? Math.round(dataPoints.reduce((s, d) => s + d.mental_equilibrium, 0) / dataPoints.length) 
    : 60;

  // Show every 5th label to avoid crowding
  const tickFormatter = (_: string, index: number) =>
    index % 5 === 0 ? dataPoints[index]?.label ?? '' : '';

  return (
    <div className="card flex flex-col" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937]">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-[#87A96B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB] tracking-wide">
            Physical Strain vs. Mental Equilibrium
          </span>
          <span className="font-mono text-[10px] text-[#4B5563] ml-1">30d</span>
        </div>
        {!loading && !error && dataPoints.length > 0 && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-[2px] rounded-full bg-[#87A96B]" />
              <span className="text-[11px] text-[#9CA3AF]">Physical</span>
              <span className="font-mono text-[11px] text-[#87A96B] ml-1">{avg_strain}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-[2px] rounded-full bg-[#60A5FA]" />
              <span className="text-[11px] text-[#9CA3AF]">Mental</span>
              <span className="font-mono text-[11px] text-[#60A5FA] ml-1">{avg_equil}</span>
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 pt-3 flex flex-col min-h-0 justify-center">
        {loading ? (
          <div className="w-full h-full flex flex-col gap-4 justify-between animate-pulse">
            <div className="flex items-end gap-1.5 h-36 border-b border-[#111] pb-1">
              {[...Array(30)].map((_, i) => (
                <div key={i} className="flex-1 bg-[#111] rounded-t" style={{ height: `${20 + (i % 3) * 20}%` }} />
              ))}
            </div>
            <div className="flex justify-between px-2">
              <div className="h-3 bg-[#111] w-12 rounded" />
              <div className="h-3 bg-[#111] w-12 rounded" />
              <div className="h-3 bg-[#111] w-12 rounded" />
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center p-4">
            <ShieldAlert size={22} className="text-[#EF4444] animate-bounce" />
            <span className="text-[12px] font-bold text-[#E5E7EB]">Telemetry Curve Error</span>
            <span className="text-[10px] text-[#9CA3AF] font-mono leading-relaxed">{error}</span>
          </div>
        ) : dataPoints.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center p-4">
            <AlertTriangle size={22} className="text-[#F59E0B]" />
            <span className="text-[12px] font-bold text-[#E5E7EB]">No Time-Series Records Found</span>
            <span className="text-[10px] text-[#9CA3AF]">Complete physical session logs are required to calculate the equilibrium index.</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={dataPoints}
              margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="strainGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SAGE} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={SAGE} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="equilGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={BLUE} stopOpacity={0.1} />
                  <stop offset="95%" stopColor={BLUE} stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="2 4"
                stroke="rgba(255,255,255,0.04)"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tickFormatter={tickFormatter}
                tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#4B5563' }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', fill: '#4B5563' }}
                axisLine={false}
                tickLine={false}
                tickCount={5}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1 }} />

              {/* Bar background: workout completion % */}
              <Bar
                dataKey="workout_completion"
                name="Workout Completion"
                fill="rgba(135,169,107,0.07)"
                radius={[2, 2, 0, 0]}
                maxBarSize={8}
              />
              {/* Bar: checkin completion */}
              <Bar
                dataKey="checkin_completion"
                name="Check-in Completion"
                fill="rgba(96,165,250,0.06)"
                radius={[2, 2, 0, 0]}
                maxBarSize={8}
              />

              {/* Average reference lines */}
              <ReferenceLine
                y={avg_strain}
                stroke={SAGE}
                strokeDasharray="4 4"
                strokeOpacity={0.3}
                strokeWidth={1}
              />
              <ReferenceLine
                y={avg_equil}
                stroke={BLUE}
                strokeDasharray="4 4"
                strokeOpacity={0.25}
                strokeWidth={1}
              />

              {/* Lines */}
              <Line
                type="monotone"
                dataKey="physical_strain"
                name="Physical Strain"
                stroke={SAGE}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: SAGE, stroke: '#000', strokeWidth: 2 }}
              />
              <Line
                type="monotone"
                dataKey="mental_equilibrium"
                name="Mental Equilibrium"
                stroke={BLUE}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: BLUE, stroke: '#000', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
