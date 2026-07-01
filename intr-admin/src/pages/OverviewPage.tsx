import { useState, useEffect } from 'react';
import { Users, Activity, Gauge, Brain } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import StrainEquilibriumChart from '../components/StrainEquilibriumChart';
import LiveActivityStream from '../components/LiveActivityStream';
import RevenueFunnelPanel from '../components/RevenueFunnelPanel';
import AnomalyTable from '../components/AnomalyTable';
import {
  fetchProfiles, fetchSessions, fetchJournals, fetchEvents,
  distinctUsersByEvent, ESTIMATED_MONTHLY_PRICE_USD,
  daysAgoISO, todayISO, errMessage,
  type ProfileRow, type SessionRow, type JournalRow, type EventRow,
} from '../utils/adminQueries';

interface Metrics {
  totalRegistered: number;
  active7d: number;
  dauMauRatio: number;
  dauToday: number;
  mau: number;
  mrrUsd: number;
  proSubscribers: number;
  trialUsers: number;
  avgEnergyToday: number;
  avgEnergy7d: number;
  checkinRate: number;
}

const EMPTY: Metrics = {
  totalRegistered: 0, active7d: 0, dauMauRatio: 0, dauToday: 0, mau: 0,
  mrrUsd: 0, proSubscribers: 0, trialUsers: 0, avgEnergyToday: 0, avgEnergy7d: 0, checkinRate: 0,
};

// energy_level → 1–5 proxy (no real mood column exists in the schema)
const energyScore = (level: string | null): number | null =>
  level === 'high' ? 4.5 : level === 'normal' ? 3.5 : level === 'low' ? 2.0 : null;

const dateOf = (ts: string | null): string | null => (ts ? ts.split('T')[0] : null);

function compute(
  profiles: ProfileRow[],
  sessions: SessionRow[],
  journals: JournalRow[],
  events: EventRow[],
): Metrics {
  const today = todayISO();
  const sevenAgo = daysAgoISO(7);
  const thirtyAgo = daysAgoISO(30);

  const totalRegistered = profiles.length;

  // ── Active-user sets (training sessions, recovery excluded, + journals) ──────
  const active30d = new Set<string>();
  const active7d = new Set<string>();
  const activeToday = new Set<string>();

  sessions
    .filter(s => s.is_recovery !== true)
    .forEach(s => {
      if (!s.user_id) return;
      const planned = s.planned_date ?? '';
      const completedDay = dateOf(s.completed_at);
      const within30 = planned >= thirtyAgo || (completedDay != null && completedDay >= thirtyAgo);
      if (!within30) return;
      active30d.add(s.user_id);
      if (planned >= sevenAgo || (completedDay != null && completedDay >= sevenAgo)) active7d.add(s.user_id);
      if (planned === today || completedDay === today) activeToday.add(s.user_id);
    });

  journals.forEach(j => {
    if (!j.user_id) return;
    const d = j.date ?? '';
    if (d < thirtyAgo) return;
    active30d.add(j.user_id);
    if (d >= sevenAgo) active7d.add(j.user_id);
    if (d === today) activeToday.add(j.user_id);
  });

  const mau = active30d.size;
  const dauToday = activeToday.size;
  const dauMauRatio = mau > 0 ? parseFloat(((dauToday / mau) * 100).toFixed(1)) : 0;

  // ── Subscription estimate — identical derivation to SubscriptionRevenuePage ──
  const byEvent = distinctUsersByEvent(events);
  const proSubscribers = byEvent.get('subscription_started')?.size ?? 0;
  const paywallUsers = byEvent.get('paywall_shown')?.size ?? 0;
  const mrrUsd = parseFloat((proSubscribers * ESTIMATED_MONTHLY_PRICE_USD).toFixed(2));
  const trialUsers = Math.max(0, paywallUsers - proSubscribers);

  // ── Avg energy proxy from completed training sessions ────────────────────────
  let todaySum = 0, todayCount = 0;
  let weekSum = 0, weekCount = 0;
  sessions
    .filter(s => s.is_recovery !== true)
    .forEach(s => {
      if (!s.completed) return;
      const score = energyScore(s.energy_level);
      if (score == null) return;
      if (dateOf(s.completed_at) === today) { todaySum += score; todayCount++; }
      if ((s.planned_date ?? '') >= sevenAgo) { weekSum += score; weekCount++; }
    });
  const avgEnergyToday = todayCount > 0 ? parseFloat((todaySum / todayCount).toFixed(1)) : 0;
  const avgEnergy7d = weekCount > 0 ? parseFloat((weekSum / weekCount).toFixed(1)) : 0;

  // ── Journal check-in rate (unique journalers in 30d vs MAU) ──────────────────
  const uniqueJournalers = new Set(
    journals.filter(j => (j.date ?? '') >= thirtyAgo && j.user_id).map(j => j.user_id),
  ).size;
  const checkinRate = mau > 0 ? parseFloat(((uniqueJournalers / mau) * 100).toFixed(1)) : 0;

  return {
    totalRegistered,
    active7d: active7d.size,
    dauMauRatio,
    dauToday,
    mau,
    mrrUsd,
    proSubscribers,
    trialUsers,
    avgEnergyToday,
    avgEnergy7d,
    checkinRate,
  };
}

export default function OverviewPage() {
  const [metrics, setMetrics] = useState<Metrics>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [profiles, sessions, journals, events] = await Promise.all([
          fetchProfiles(), fetchSessions(), fetchJournals(), fetchEvents(),
        ]);
        if (!active) return;
        setMetrics(compute(profiles, sessions, journals, events));
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load overview metrics.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="flex flex-col gap-4 h-full">

      {error && (
        <div className="card p-3 text-[11px] text-[#FCA5A5] font-mono border-[#EF4444]/20 flex-shrink-0">
          {error}
        </div>
      )}

      {/* Telemetry Grid */}
      <div className="grid grid-cols-4 gap-3 flex-shrink-0">
        <MetricCard
          label="Total Registered"
          value={metrics.totalRegistered.toLocaleString()}
          subValue={`${metrics.active7d.toLocaleString()} active (7d)`}
          icon={Users}
          accent="sage"
          loading={loading}
        />
        <MetricCard
          label="DAU / MAU Ratio"
          value={`${metrics.dauMauRatio}%`}
          subValue={`${metrics.dauToday.toLocaleString()} DAU · ${metrics.mau.toLocaleString()} MAU`}
          icon={Activity}
          accent="blue"
          loading={loading}
        />
        <MetricCard
          label="Est. MRR"
          value={`$${metrics.mrrUsd.toLocaleString()}`}
          subValue={`${metrics.proSubscribers.toLocaleString()} pro · ${metrics.trialUsers} trial · est`}
          icon={Gauge}
          accent="purple"
          mono
          loading={loading}
        />
        <MetricCard
          label="Avg. Energy Score (24h)"
          value={metrics.avgEnergyToday > 0 ? `${metrics.avgEnergyToday} / 5` : '—'}
          subValue={
            metrics.avgEnergy7d > 0
              ? `7d avg ${metrics.avgEnergy7d} · ${metrics.checkinRate}% journal rate`
              : `${metrics.checkinRate}% journal rate`
          }
          icon={Brain}
          accent="amber"
          loading={loading}
        />
      </div>

      {/* Dual Analytics Workspace */}
      <div className="flex gap-3 flex-shrink-0" style={{ height: 300 }}>
        <div style={{ flex: '0 0 65%' }}>
          <StrainEquilibriumChart />
        </div>
        <div style={{ flex: '0 0 35%' }}>
          <LiveActivityStream />
        </div>
      </div>

      {/* Revenue & Anomaly Triage */}
      <div className="flex gap-3 flex-1 min-h-0">
        <div style={{ flex: '0 0 50%' }}>
          <RevenueFunnelPanel />
        </div>
        <div style={{ flex: '0 0 50%' }}>
          <AnomalyTable />
        </div>
      </div>

    </div>
  );
}
