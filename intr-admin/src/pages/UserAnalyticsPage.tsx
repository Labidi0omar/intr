import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Users, UserCheck, Calendar, TrendingUp } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import {
  fetchProfiles, fetchSessions, fetchJournals,
  distribution, SPLIT_META, GOAL_META, daysAgoISO, todayISO, errMessage,
  type ProfileRow, type SessionRow, type JournalRow,
} from '../utils/adminQueries';

const CTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{name: string; value: number; payload: {color: string}}> }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ background: p.payload.color }} />
        <span className="text-[11px] text-[#9CA3AF]">{p.name}</span>
        <span className="font-mono text-[12px] font-bold text-[#E5E7EB] ml-2">{p.value}</span>
      </div>
    </div>
  );
};

interface Slice { key: string; label: string; color: string; count: number; pct: number; }
interface Cohort { week: string; cohortSize: number; reached3: number; d7: number; pct: number; }

interface Analytics {
  total: number;
  newSignups7d: number;
  active30d: number;
  onboardingRate: number;
  completionRate: number;
  dauSeries: Array<{ label: string; dau: number }>;
  splits: Slice[];
  goals: Slice[];
  cohorts: Cohort[];
  roster: ProfileRow[];
}

const EMPTY: Analytics = {
  total: 0, newSignups7d: 0, active30d: 0, onboardingRate: 0, completionRate: 0,
  dauSeries: [], splits: [], goals: [], cohorts: [], roster: [],
};

function weekStartLabel(iso: string): { key: string; label: string } {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
  const key = d.toISOString().split('T')[0];
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { key, label };
}

function compute(profiles: ProfileRow[], sessions: SessionRow[], journals: JournalRow[]): Analytics {
  const total = profiles.length;
  const sevenAgo = daysAgoISO(7);
  const today = todayISO();

  const newSignups7d = profiles.filter(p => (p.created_at ?? '') >= sevenAgo).length;
  const onboarded = profiles.filter(p => p.onboarding_complete === true).length;
  const onboardingRate = total > 0 ? parseFloat(((onboarded / total) * 100).toFixed(1)) : 0;

  // Session completion over past, planned, non-recovery sessions
  const training = sessions.filter(s => s.is_recovery !== true);
  const pastPlanned = training.filter(s => (s.planned_date ?? '') <= today);
  const completedPast = pastPlanned.filter(s => s.completed === true).length;
  const completionRate = pastPlanned.length > 0
    ? parseFloat(((completedPast / pastPlanned.length) * 100).toFixed(1))
    : 0;

  // ── Active users (30d) + DAU series ────────────────────────────────────────
  const dates: string[] = [];
  for (let i = 29; i >= 0; i--) dates.push(daysAgoISO(i));
  const activeByDay = new Map<string, Set<string>>(dates.map(d => [d, new Set<string>()]));
  const active30d = new Set<string>();

  const markActive = (userId: string | null, day: string | null) => {
    if (!userId || !day) return;
    const set = activeByDay.get(day);
    if (set) { set.add(userId); active30d.add(userId); }
  };
  sessions.forEach(s => {
    if (s.completed && s.completed_at) markActive(s.user_id, s.completed_at.split('T')[0]);
  });
  journals.forEach(j => markActive(j.user_id, j.date));

  const dauSeries = dates.map(d => ({
    label: new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    dau: activeByDay.get(d)?.size ?? 0,
  }));

  // ── Distributions ──────────────────────────────────────────────────────────
  const splits = distribution(profiles.map(p => p.preferred_split), SPLIT_META);
  const goals = distribution(profiles.map(p => p.goal), GOAL_META);

  // ── D7 retention cohorts (by signup week) ──────────────────────────────────
  const sessionsByUser = new Map<string, SessionRow[]>();
  sessions.forEach(s => {
    const list = sessionsByUser.get(s.user_id) ?? [];
    list.push(s);
    sessionsByUser.set(s.user_id, list);
  });

  const cohortMap = new Map<string, { label: string; users: ProfileRow[] }>();
  profiles.forEach(p => {
    if (!p.created_at) return;
    const { key, label } = weekStartLabel(p.created_at);
    const entry = cohortMap.get(key) ?? { label, users: [] };
    entry.users.push(p);
    cohortMap.set(key, entry);
  });

  const cohorts: Cohort[] = Array.from(cohortMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([, { label, users }]) => {
      let reached3 = 0;
      let d7 = 0;
      users.forEach(u => {
        const us = sessionsByUser.get(u.id) ?? [];
        if (us.length >= 3) reached3++;
        const signup = new Date(u.created_at);
        const d7Cutoff = new Date(signup);
        d7Cutoff.setDate(d7Cutoff.getDate() + 7);
        const returned = us.some(s => {
          const when = s.completed_at ? new Date(s.completed_at) : new Date(s.planned_date);
          return when >= d7Cutoff;
        });
        if (returned) d7++;
      });
      const pct = users.length > 0 ? parseFloat(((d7 / users.length) * 100).toFixed(1)) : 0;
      return { week: label, cohortSize: users.length, reached3, d7, pct };
    });

  const roster = [...profiles].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

  return {
    total, newSignups7d, active30d: active30d.size, onboardingRate, completionRate,
    dauSeries, splits, goals, cohorts, roster,
  };
}

export default function UserAnalyticsPage() {
  const [data, setData] = useState<Analytics>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [profiles, sessions, journals] = await Promise.all([
          fetchProfiles(), fetchSessions(), fetchJournals(),
        ]);
        if (!active) return;
        setData(compute(profiles, sessions, journals));
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load user analytics.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const activePct = data.total > 0 ? ((data.active30d / data.total) * 100).toFixed(1) : '0';

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* Top metrics */}
      <div className="grid grid-cols-4 gap-3 flex-shrink-0">
        <MetricCard label="Total Registered" value={data.total.toLocaleString()} subValue={`+${data.newSignups7d} this week`} icon={Users} accent="sage" loading={loading} />
        <MetricCard label="Active (30d)" value={data.active30d.toLocaleString()} subValue={`${activePct}% of base`} icon={UserCheck} accent="blue" loading={loading} />
        <MetricCard label="Onboarding Rate" value={`${data.onboardingRate}%`} subValue="Completed onboarding flow" icon={Calendar} accent="purple" loading={loading} />
        <MetricCard label="Session Completion" value={`${data.completionRate}%`} subValue="of planned sessions completed" icon={TrendingUp} accent="amber" loading={loading} />
      </div>

      {error && (
        <div className="card p-3 text-[11px] text-[#FCA5A5] font-mono border-[#EF4444]/20 flex-shrink-0">
          {error}
        </div>
      )}

      {/* DAU trend + splits */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 260 }}>
        {/* DAU bar chart */}
        <div className="card flex-1 flex flex-col">
          <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
            <TrendingUp size={13} className="text-[#87A96B]" />
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Daily Active Users (30d)</span>
          </div>
          <div className="flex-1 p-4 pt-2">
            {data.dauSeries.some(d => d.dau > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.dauSeries} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} interval={4} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
                  <Bar dataKey="dau" name="DAU" fill="#87A96B" radius={[2, 2, 0, 0]} opacity={0.8} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[11px] text-[#4B5563]">
                {loading ? 'Loading…' : 'No active-user activity in the last 30 days'}
              </div>
            )}
          </div>
        </div>

        {/* Split pie */}
        <div className="card flex flex-col" style={{ width: 260 }}>
          <div className="px-4 py-3 border-b border-[#1F2937]">
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Training Splits</span>
          </div>
          <div className="flex-1 flex items-center p-3 gap-2">
            {data.splits.length > 0 ? (
              <>
                <ResponsiveContainer width={110} height={110}>
                  <PieChart>
                    <Pie dataKey="count" data={data.splits} cx="50%" cy="50%" innerRadius={30} outerRadius={50} paddingAngle={2} strokeWidth={0}>
                      {data.splits.map((s, i) => <Cell key={i} fill={s.color} />)}
                    </Pie>
                    <Tooltip content={<CTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-[5px] flex-1">
                  {data.splits.map(s => (
                    <div key={s.key} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: s.color }} />
                      <span className="text-[10px] text-[#9CA3AF] flex-1 truncate">{s.label}</span>
                      <span className="font-mono text-[10px] text-[#4B5563]">{s.pct}%</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="w-full text-center text-[11px] text-[#4B5563]">{loading ? 'Loading…' : 'No data'}</div>
            )}
          </div>
        </div>

        {/* Goals pie */}
        <div className="card flex flex-col" style={{ width: 260 }}>
          <div className="px-4 py-3 border-b border-[#1F2937]">
            <span className="text-[13px] font-semibold text-[#E5E7EB]">User Goals</span>
          </div>
          <div className="flex-1 flex items-center p-3 gap-2">
            {data.goals.length > 0 ? (
              <>
                <ResponsiveContainer width={110} height={110}>
                  <PieChart>
                    <Pie dataKey="count" data={data.goals} cx="50%" cy="50%" innerRadius={30} outerRadius={50} paddingAngle={2} strokeWidth={0}>
                      {data.goals.map((g, i) => <Cell key={i} fill={g.color} />)}
                    </Pie>
                    <Tooltip content={<CTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-[5px] flex-1">
                  {data.goals.map(g => (
                    <div key={g.key} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: g.color }} />
                      <span className="text-[10px] text-[#9CA3AF] flex-1 truncate">{g.label}</span>
                      <span className="font-mono text-[10px] text-[#4B5563]">{g.pct}%</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="w-full text-center text-[11px] text-[#4B5563]">{loading ? 'Loading…' : 'No data'}</div>
            )}
          </div>
        </div>
      </div>

      {/* Retention cohort table + Users list */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Cohort table */}
        <div className="card flex flex-col" style={{ width: 420 }}>
          <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[#E5E7EB]">D7 Retention (Signup Cohorts)</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="grid px-4 py-2 border-b border-[#111] bg-[#0a0a0a]" style={{ gridTemplateColumns: '1fr 80px 80px 80px' }}>
              {['Cohort', 'Hit S3', 'D7 Back', 'Ret %'].map(h => (
                <span key={h} className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">{h}</span>
              ))}
            </div>
            {data.cohorts.map(c => (
              <div key={c.week} className="grid px-4 py-[10px] border-b border-[#0d0d0d] hover:bg-white/[0.015] items-center" style={{ gridTemplateColumns: '1fr 80px 80px 80px' }}>
                <span className="font-mono text-[12px] text-[#9CA3AF]">{c.week} <span className="text-[#4B5563]">({c.cohortSize})</span></span>
                <span className="font-mono text-[12px] text-[#E5E7EB]">{c.reached3}</span>
                <span className="font-mono text-[12px] text-[#E5E7EB]">{c.d7}</span>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[12px] font-bold ${c.pct >= 68 ? 'text-[#87A96B]' : 'text-[#F59E0B]'}`}>
                    {c.pct}%
                  </span>
                </div>
              </div>
            ))}
            {!loading && data.cohorts.length === 0 && (
              <div className="flex items-center justify-center h-24 text-[11px] text-[#4B5563]">No cohort data</div>
            )}
          </div>
        </div>

        {/* User roster */}
        <div className="card flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-[#1F2937]">
            <span className="text-[13px] font-semibold text-[#E5E7EB]">User Roster</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="grid px-4 py-2 border-b border-[#111] bg-[#0a0a0a]" style={{ gridTemplateColumns: '1fr 80px 80px 70px 60px' }}>
              {['Username', 'Split', 'Goal', 'Days/wk', 'Status'].map(h => (
                <span key={h} className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">{h}</span>
              ))}
            </div>
            {data.roster.map(p => (
              <div key={p.id} className="grid px-4 py-[8px] border-b border-[#0d0d0d] hover:bg-white/[0.015] items-center transition-colors" style={{ gridTemplateColumns: '1fr 80px 80px 70px 60px' }}>
                <span className="font-mono text-[12px] text-[#E5E7EB]">@{p.username ?? 'user'}</span>
                <span className="text-[11px] text-[#9CA3AF]">{p.preferred_split ? (SPLIT_META[p.preferred_split]?.label ?? p.preferred_split.replace(/_/g, '/')) : '—'}</span>
                <span className="text-[11px] text-[#9CA3AF] capitalize">{p.goal ? p.goal.replace(/_/g, ' ') : '—'}</span>
                <span className="font-mono text-[12px] text-[#9CA3AF]">{p.training_days ?? '—'}</span>
                <span className={`badge text-[9px] px-1.5 py-0.5 ${p.onboarding_complete ? 'badge-sage' : 'badge-blue'}`}>
                  {p.onboarding_complete ? 'ACTIVE' : 'NEW'}
                </span>
              </div>
            ))}
            {!loading && data.roster.length === 0 && (
              <div className="flex items-center justify-center h-24 text-[11px] text-[#4B5563]">No users found</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
