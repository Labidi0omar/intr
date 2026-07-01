import { useState, useEffect } from 'react';
import { AlertTriangle, Eye, EyeOff, ChevronUp, ChevronDown, ShieldAlert } from 'lucide-react';
import { supabase } from '../utils/supabaseClient';
import { formatTimestamp } from '../utils/dateUtils';
// Columns used:
//   profiles:         id, username (nullable text)
//   workout_sessions: id, user_id, planned_date, completed, completed_at, energy_level, is_recovery

export type AnomalySeverity = 'critical' | 'warning' | 'watch';
export type AnomalyType = 'streak_drop' | 'consecutive_negative_mood' | 'energy_collapse' | 'churn_signal' | 'engagement_gap';

export interface SelfAwarenessAnomaly {
  id: string;
  user_id: string;
  username: string;
  anomaly_type: AnomalyType;
  severity: AnomalySeverity;
  detail: string;
  last_checkin_date: string;
  streak_before: number;
  streak_now: number;
  avg_mood_score: number;
  flagged_at: string;
  reviewed: boolean;
}

const SEVERITY_CONFIG: Record<AnomalySeverity, {
  badge: string;
  dot: string;
  row: string;
  label: string;
}> = {
  critical: {
    badge: 'badge badge-red',
    dot: 'bg-[#EF4444]',
    row: 'hover:bg-[#EF4444]/[0.03]',
    label: 'CRITICAL',
  },
  warning: {
    badge: 'badge badge-amber',
    dot: 'bg-[#F59E0B]',
    row: 'hover:bg-[#F59E0B]/[0.03]',
    label: 'WARNING',
  },
  watch: {
    badge: 'badge badge-blue',
    dot: 'bg-[#60A5FA]',
    row: 'hover:bg-[#60A5FA]/[0.03]',
    label: 'WATCH',
  },
};

const ANOMALY_LABELS: Record<string, string> = {
  streak_drop: 'Streak Drop',
  consecutive_negative_mood: 'Neg. Mood Streak',
  energy_collapse: 'Energy Collapse',
  churn_signal: 'Churn Signal',
  engagement_gap: 'Engagement Gap',
};

type SortKey = 'severity' | 'flagged_at' | 'avg_mood_score';

const SEVERITY_RANK: Record<AnomalySeverity, number> = { critical: 0, warning: 1, watch: 2 };

function MoodBar({ score }: { score: number }) {
  const pct = (score / 5) * 100;
  const color = score < 2 ? '#EF4444' : score < 3.5 ? '#F59E0B' : '#87A96B';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-[4px] bg-[#111] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-[11px]" style={{ color }}>{score.toFixed(1)}</span>
    </div>
  );
}

export default function AnomalyTable() {
  const [anomalies, setAnomalies] = useState<SelfAwarenessAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [sortKey, setSortKey] = useState<SortKey>('severity');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterSeverity, setFilterSeverity] = useState<AnomalySeverity | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAnomalies() {
      try {
        setLoading(true);
        setError(null);
        
        // Fetch profiles — username is TEXT (nullable)
        const { data: profiles, error: pErr } = await supabase
          .from('profiles')
          .select('id, username');
        if (pErr) throw pErr;

        // Fetch training sessions ordered newest-first (exclude recovery)
        // Columns: id, user_id, planned_date, completed, completed_at, energy_level
        const { data: sessions, error: sErr } = await supabase
          .from('workout_sessions')
          .select('id, user_id, planned_date, completed, completed_at, energy_level')
          .eq('is_recovery', false)
          .order('planned_date', { ascending: false });
        if (sErr) throw sErr;

        if (!profiles || profiles.length === 0) {
          setAnomalies([]);
          return;
        }

        const userMap = new Map(profiles.map(p => [p.id, (p.username as string | null) ?? 'user']));
        const grouped = new Map<string, typeof sessions>();
        
        sessions?.forEach(s => {
          if (!s.user_id) return; // guard against null user_id
          const list = grouped.get(s.user_id) ?? [];
          list.push(s);
          grouped.set(s.user_id, list);
        });

        const list: SelfAwarenessAnomaly[] = [];

        // Run client-side telemetry analysis per user
        grouped.forEach((userSessions, userId) => {
          if (!userId) return;
          const username = userMap.get(userId) ?? 'user';
          // Sort descending by planned_date (string ISO comparison is valid for dates)
          const sorted = [...userSessions].sort((a, b) =>
            (b.planned_date ?? '').localeCompare(a.planned_date ?? '')
          );

          // ── 1. Energy Collapse: ≥2 consecutive completed low-energy training sessions
          const completedSessions = sorted.filter(s => s.completed === true);
          let consecutiveLow = 0;
          for (const s of completedSessions) {
            if (s.energy_level === 'low') consecutiveLow++;
            else break;
          }
          if (consecutiveLow >= 2) {
            const lastDate =
              completedSessions[0]?.completed_at?.split('T')[0] ??
              completedSessions[0]?.planned_date ??
              '';
            list.push({
              id: `anom_low_${userId}`,
              user_id: userId,
              username,
              anomaly_type: 'energy_collapse',
              severity: consecutiveLow >= 3 ? 'critical' : 'warning',
              detail: `${consecutiveLow} consecutive training sessions completed with low energy — risk of overtraining or CNS fatigue.`,
              last_checkin_date: lastDate,
              streak_before: 7,
              streak_now: Math.max(0, 7 - consecutiveLow),
              avg_mood_score: 1.5,
              flagged_at: new Date().toISOString(),
              reviewed: false,
            });
          }

          // ── 2. Engagement Gap: ≥3 consecutive missed (not completed) planned sessions
          const todayISO = new Date().toISOString().split('T')[0];
          // Only count sessions that were planned in the past (not future dates)
          const missedOverdue = sorted.filter(
            s => s.completed !== true && (s.planned_date ?? '') < todayISO
          );
          if (missedOverdue.length >= 3) {
            const lastActiveDate =
              completedSessions[0]?.completed_at?.split('T')[0] ??
              completedSessions[0]?.planned_date ??
              'never';
            list.push({
              id: `anom_gap_${userId}`,
              user_id: userId,
              username,
              anomaly_type: 'engagement_gap',
              severity: missedOverdue.length >= 5 ? 'critical' : 'warning',
              detail: `Missed ${missedOverdue.length} consecutive planned training sessions. Adherence score below critical threshold.`,
              last_checkin_date: lastActiveDate,
              streak_before: 14,
              streak_now: 0,
              avg_mood_score: 2.2,
              flagged_at: new Date().toISOString(),
              reviewed: false,
            });
          }
        });

        setAnomalies(list);
      } catch (err) {
        console.error('Failed to load anomalies:', err);
        setError(err instanceof Error ? err.message : 'Error executing database telemetry fetch');
      } finally {
        setLoading(false);
      }
    }

    fetchAnomalies();
  }, []);

  const sorted = [...anomalies]
    .filter(a => filterSeverity === 'all' || a.severity === filterSeverity)
    .sort((a, b) => {
      const cmp =
        sortKey === 'severity' ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
        : sortKey === 'flagged_at' ? a.flagged_at.localeCompare(b.flagged_at)
        : a.avg_mood_score - b.avg_mood_score;
      return sortAsc ? cmp : -cmp;
    });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const markReviewed = (id: string) =>
    setAnomalies(prev => prev.map(a => a.id === id ? { ...a, reviewed: !a.reviewed } : a));

  const renderSortIcon = (col: SortKey) =>
    sortKey === col
      ? (sortAsc ? <ChevronUp size={10} className="text-[#87A96B]" /> : <ChevronDown size={10} className="text-[#87A96B]" />)
      : <ChevronDown size={10} className="text-[#2d3748]" />;

  const unreviewedCritical = anomalies.filter(a => a.severity === 'critical' && !a.reviewed).length;

  return (
    <div className="card flex flex-col" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937] flex-shrink-0">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-[#F59E0B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB] tracking-wide">
            Self-Awareness Anomalies
          </span>
          {unreviewedCritical > 0 && (
            <span className="badge badge-red animate-pulse ml-1">
              {unreviewedCritical} critical
            </span>
          )}
        </div>
        {/* Severity filter */}
        <div className="flex items-center gap-1">
          {(['all', 'critical', 'warning', 'watch'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilterSeverity(f)}
              className={`text-[10px] font-medium px-2 py-1 rounded border transition-all duration-150 capitalize ${
                filterSeverity === f
                  ? 'border-[#87A96B]/30 text-[#87A96B] bg-[#87A96B]/8'
                  : 'border-[#1F2937] text-[#4B5563] hover:border-[#2d3748] hover:text-[#9CA3AF]'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Table content / Loading / Error states */}
      {loading ? (
        <div className="flex-1 p-4 space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex flex-col gap-2 animate-pulse py-2 border-b border-[#111]">
              <div className="flex justify-between">
                <div className="h-3.5 bg-[#111] w-28 rounded" />
                <div className="h-3.5 bg-[#111] w-14 rounded" />
              </div>
              <div className="h-3 bg-[#111] w-48 rounded" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="bg-[#EF4444]/5 border border-[#EF4444]/15 rounded-lg p-5 flex flex-col items-center gap-2 max-w-sm">
            <ShieldAlert size={20} className="text-[#EF4444]" />
            <span className="text-[12px] font-bold text-[#E5E7EB]">Telemetry Fetch Failure</span>
            <span className="text-[10px] text-[#9CA3AF] leading-relaxed font-mono">{error}</span>
          </div>
        </div>
      ) : anomalies.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="bg-[#87A96B]/5 border border-[#87A96B]/15 rounded-lg p-5 flex flex-col items-center gap-2 max-w-sm">
            <AlertTriangle size={20} className="text-[#87A96B]" />
            <span className="text-[12px] font-bold text-[#E5E7EB]">No Recent Anomalies Flagged</span>
            <span className="text-[10px] text-[#9CA3AF] leading-relaxed">All users currently match baseline habits and energy readiness parameters.</span>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Column headers */}
          <div className="grid gap-0 px-4 py-2 border-b border-[#1F2937] bg-[#0a0a0a]"
            style={{ gridTemplateColumns: '1fr 100px 90px 80px 70px 60px' }}>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">User / Detail</span>
            <button
              onClick={() => toggleSort('severity')}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] hover:text-[#9CA3AF] cursor-pointer transition-colors"
            >
              Severity {renderSortIcon('severity')}
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">Type</span>
            <button
              onClick={() => toggleSort('avg_mood_score')}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] hover:text-[#9CA3AF] cursor-pointer transition-colors"
            >
              Mood {renderSortIcon('avg_mood_score')}
            </button>
            <button
              onClick={() => toggleSort('flagged_at')}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] hover:text-[#9CA3AF] cursor-pointer transition-colors"
            >
              Flagged {renderSortIcon('flagged_at')}
            </button>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] text-right">Ack</span>
          </div>

          {/* Rows */}
          {sorted.map(anomaly => {
            const cfg = SEVERITY_CONFIG[anomaly.severity];
            const isExpanded = expandedId === anomaly.id;
            return (
              <div
                key={anomaly.id}
                className={`border-b border-[#111] transition-all duration-150 ${cfg.row} ${anomaly.reviewed ? 'opacity-50' : ''}`}
              >
                <div
                  className="grid items-center px-4 py-[9px] cursor-pointer"
                  style={{ gridTemplateColumns: '1fr 100px 90px 80px 70px 60px' }}
                  onClick={() => setExpandedId(isExpanded ? null : anomaly.id)}
                >
                  {/* User */}
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${cfg.dot}`} />
                    <div className="min-w-0">
                      <div className="font-mono text-[12px] text-[#E5E7EB] font-medium truncate">
                        @{anomaly.username}
                      </div>
                      <div className="text-[10px] text-[#4B5563] truncate">
                        Streak {anomaly.streak_before} → {anomaly.streak_now}
                      </div>
                    </div>
                  </div>

                  {/* Severity */}
                  <span className={cfg.badge}>{cfg.label}</span>

                  {/* Type */}
                  <span className="text-[11px] text-[#9CA3AF]">
                    {ANOMALY_LABELS[anomaly.anomaly_type]}
                  </span>

                  {/* Mood bar */}
                  <MoodBar score={anomaly.avg_mood_score} />

                  {/* Flagged */}
                  <span className="font-mono text-[10px] text-[#4B5563]">
                    {formatTimestamp(anomaly.flagged_at)}
                  </span>

                  {/* Reviewed toggle */}
                  <div className="flex justify-end">
                    <button
                      onClick={e => { e.stopPropagation(); markReviewed(anomaly.id); }}
                      className={`p-1 rounded transition-all duration-150 ${
                        anomaly.reviewed
                          ? 'text-[#87A96B] hover:text-[#a8c98a]'
                          : 'text-[#2d3748] hover:text-[#4B5563]'
                      }`}
                      title={anomaly.reviewed ? 'Mark unreviewed' : 'Mark reviewed'}
                    >
                      {anomaly.reviewed ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-4 pb-3 ml-8 animate-slide-in">
                    <div className="bg-[#0a0a0a] border border-[#1F2937] rounded-md p-3 text-[11px] text-[#9CA3AF] leading-relaxed">
                      {anomaly.detail}
                      <div className="flex gap-3 mt-2">
                        <span className="text-[10px] text-[#4B5563]">
                          Last active: <span className="text-[#9CA3AF] font-mono">{anomaly.last_checkin_date}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {sorted.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[#4B5563] text-[12px]">
              No anomalies match the current filter
            </div>
          )}
        </div>
      )}
    </div>
  );
}
