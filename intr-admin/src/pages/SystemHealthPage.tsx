import { useState, useEffect, useRef, useCallback } from 'react';
import { Server, AlertCircle, CheckCircle, Clock, Info, RefreshCw, ShieldOff } from 'lucide-react';
import { SAMPLE_INFRASTRUCTURE_PINGS } from '../utils/sampleInfra';
import { supabase } from '../utils/supabaseClient';
import MetricCard from '../components/MetricCard';

// ─── Sentry health (live, via sentry-health edge function) ───────────────────
//
// The function returns one of four shapes — we render every one. State is held
// as a discriminated union so the render block can't read errors24h on a "not
// configured" payload, and tsc forces us to handle each case.

interface SentryIssue {
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
}

type SentryState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'not_configured' }
  | { kind: 'unreachable' }
  | {
      kind: 'ok';
      project: { slug: string; status: string };
      errors24h: number;
      /** True when errors24h came from the issue-count fallback rather than
       *  stats_v2 — render with a leading "≈" + an "approx" subline. */
      errors24hApprox: boolean;
      lastEventAt: string | null;
      topIssues: SentryIssue[];
      fetchedAt: number;
    };

function relativeTime(iso: string | null): string {
  if (!iso) return 'no events';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  service: string;
  message: string;
}

const LOG_TEMPLATES: Array<{ level: LogLevel; service: string; message: string }> = [
  { level: 'INFO',  service: 'supabase-auth',    message: 'JWT verified · user session extended' },
  { level: 'INFO',  service: 'daily-reflection',  message: 'Edge function invoked · type=daily · latency 312ms' },
  { level: 'INFO',  service: 'replan-today',       message: 'Plan regenerated · user_id=u_** · week_start=2026-06-09' },
  { level: 'INFO',  service: 'rc-webhook',         message: 'INITIAL_PURCHASE received · product_id=pro_monthly · status=200' },
  { level: 'INFO',  service: 'coach-recap',        message: 'Recap generated · lift_count=4 · session_index=7' },
  { level: 'WARN',  service: 'pending-sync',       message: 'Retry #2 for exercise_log flush · session_id=** stale' },
  { level: 'INFO',  service: 'supabase-db',        message: 'weekly_plans upsert · conflict resolved · plan_version bump' },
  { level: 'INFO',  service: 'ollama',             message: 'phraseObservation() call completed · tokens=214 · 1.2s' },
  { level: 'DEBUG', service: 'gap-detection',      message: 'gapDetection: 0 gaps found for current week plan' },
  { level: 'INFO',  service: 'analytics',          message: 'track(workout_completed) · session_index=3 · energy_score=4' },
  { level: 'WARN',  service: 'rc-webhook',         message: 'RENEWAL_UPCOMING · product_id=pro_annual · renewal_at=+4d' },
  { level: 'INFO',  service: 'delete-account',     message: 'Account deletion flow initiated · all cascade RLS policies applied' },
  { level: 'ERROR', service: 'daily-reflection',   message: 'Anthropic API timeout (>5s) · fallback triggered · status=504' },
  // Removed: the fabricated 'sentry' template — Sentry health is now real,
  // sourced from the sentry-health edge function. See the live Sentry card below.
  { level: 'INFO',  service: 'supabase-auth',      message: 'Google OAuth sign-in · provider=google · new_user=false' },
  { level: 'DEBUG', service: 'plan-sync',          message: 'ensureCurrentWeekPlan() — plan found, no regen needed' },
  { level: 'INFO',  service: 'analytics',          message: 'track(paywall_shown) · paywall_reason=session_gate · session_index=3' },
];

const LEVEL_CFG: Record<LogLevel, { cls: string; bg: string }> = {
  INFO:  { cls: 'text-[#60A5FA]',  bg: 'bg-[#60A5FA]/8' },
  WARN:  { cls: 'text-[#F59E0B]',  bg: 'bg-[#F59E0B]/8' },
  ERROR: { cls: 'text-[#EF4444]',  bg: 'bg-[#EF4444]/8' },
  DEBUG: { cls: 'text-[#4B5563]',  bg: 'bg-transparent' },
};

function genLog(now: Date): LogEntry {
  const t = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return { id: Math.random().toString(36).slice(2), ts, ...t };
}

function getInitialLogs(): LogEntry[] {
  const logs: LogEntry[] = [];
  const now = new Date();
  for (let i = 40; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3500 - Math.random() * 2000);
    logs.push(genLog(d));
  }
  return logs;
}

export default function SystemHealthPage() {
  const [logs, setLogs] = useState<LogEntry[]>(getInitialLogs);
  const [filterLevel, setFilterLevel] = useState<LogLevel | 'ALL'>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const [pings, setPings] = useState(SAMPLE_INFRASTRUCTURE_PINGS);
  const [sentry, setSentry] = useState<SentryState>({ kind: 'loading' });

  // Fetch live Sentry health. Errors collapse to a render-only state — never
  // throws to React, so the rest of the page keeps working if Sentry is down.
  const fetchSentry = useCallback(async () => {
    setSentry({ kind: 'loading' });
    try {
      const { data, error } = await supabase.functions.invoke('sentry-health');
      if (error) {
        // FunctionsHttpError exposes the response status — a 403 from the
        // function means the caller isn't an admin (or the JWT was missing).
        const status =
          (error as { context?: { status?: number } })?.context?.status ??
          (error as { status?: number })?.status;
        if (status === 403) {
          setSentry({ kind: 'forbidden' });
          return;
        }
        setSentry({ kind: 'unreachable' });
        return;
      }
      const body = data as
        | { ok: true; configured: true; project: { slug: string; status: string }; errors24h: number; errors24hApprox?: boolean; lastEventAt: string | null; topIssues: SentryIssue[] }
        | { ok: false; configured: false }
        | { ok: false; configured: true; error: string }
        | null;
      if (!body) {
        setSentry({ kind: 'unreachable' });
        return;
      }
      if (body.ok === true) {
        setSentry({
          kind: 'ok',
          project: body.project,
          errors24h: body.errors24h,
          // Older deploys without the flag → treat as exact (false).
          errors24hApprox: body.errors24hApprox === true,
          lastEventAt: body.lastEventAt,
          topIssues: Array.isArray(body.topIssues) ? body.topIssues : [],
          fetchedAt: Date.now(),
        });
        return;
      }
      if (body.configured === false) {
        setSentry({ kind: 'not_configured' });
        return;
      }
      setSentry({ kind: 'unreachable' });
    } catch {
      setSentry({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => { void fetchSentry(); }, [fetchSentry]);

  // Log pump
  useEffect(() => {
    const t = setInterval(() => {
      const now = new Date();
      setLogs(prev => [genLog(now), ...prev].slice(0, 200));
    }, 1800 + Math.random() * 1200);
    return () => clearInterval(t);
  }, []);

  // Latency jitter
  useEffect(() => {
    const t = setInterval(() => {
      setPings(prev => prev.map(p => ({
        ...p,
        latency_ms: Math.max(8, p.latency_ms + Math.floor((Math.random() - 0.5) * 24)),
      })));
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = 0;
  }, [logs, autoScroll]);

  const filtered = logs.filter(l => filterLevel === 'ALL' || l.level === filterLevel);
  const errorCount = logs.filter(l => l.level === 'ERROR').length;
  const warnCount = logs.filter(l => l.level === 'WARN').length;

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Partial-live banner — the Sentry panel is real (sourced from the
          sentry-health edge function), the service grid and log stream are
          still illustrative until they get their own backends. */}
      <div className="flex items-start gap-2 bg-[#F59E0B]/[0.04] border border-[#F59E0B]/15 rounded-lg px-3 py-2 flex-shrink-0">
        <Info size={13} className="text-[#F59E0B] mt-[1px] flex-shrink-0" />
        <span className="text-[10px] text-[#9CA3AF] leading-relaxed">
          <span className="text-[#FCD34D] font-medium">Partial-live.</span> The Sentry panel below is{' '}
          <span className="text-[#87A96B] font-medium">live</span> — fetched via the sentry-health edge function.
          The service status grid and the log stream are still fabricated sample data; wire real status endpoints
          to make those real too.
        </span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3 flex-shrink-0">
        <MetricCard label="Services Online" value={`${pings.filter(p => p.status === 'operational').length} / ${pings.length}`} subValue="All systems nominal" icon={Server} accent="sage" />
        <MetricCard label="Log Errors (session)" value={errorCount} subValue="Since dashboard open" icon={AlertCircle} accent="red" />
        <MetricCard label="Warnings (session)" value={warnCount} subValue="Non-critical advisories" icon={CheckCircle} accent="amber" />
        <MetricCard label="Avg Supabase Latency" value={`${pings.find(p => p.name === 'Database')?.latency_ms ?? 18}ms`} subValue="Auth + DB combined" icon={Clock} accent="blue" mono />
      </div>

      {/* Service status grid */}
      <div className="flex gap-3 flex-shrink-0">
        {pings.map(ping => {
          const isOk = ping.status === 'operational';
          return (
            <div key={ping.name} className="card flex-1 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-[#9CA3AF]">{ping.name}</span>
                <div className={`w-[6px] h-[6px] rounded-full ${isOk ? 'bg-[#87A96B] dot-pulse' : 'bg-[#EF4444]'}`} />
              </div>
              <div className={`text-[11px] font-medium ${isOk ? 'text-[#87A96B]' : 'text-[#FCA5A5]'}`}>
                {isOk ? 'Operational' : 'Down'}
              </div>
              <div className="font-mono text-[12px] text-[#E5E7EB] font-bold">{ping.latency_ms}ms</div>
            </div>
          );
        })}
      </div>

      {/* ── Sentry health (LIVE) ──────────────────────────────────────
          Sourced from the sentry-health edge function. The function gates
          on public.is_admin() and returns only sanitized numbers — no
          permalinks, no event bodies, no PII. Every load state is
          rendered explicitly so a missing key or a 5xx never blanks the
          panel. */}
      <div className="card flex flex-col flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937] gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle size={13} className="text-[#F472B6]" />
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Sentry — Errors (last 24h)</span>
            <span className="badge text-[9px] px-1.5 py-0.5 ml-1 border border-[#87A96B]/30 text-[#87A96B] bg-[#87A96B]/10">LIVE</span>
            {sentry.kind === 'ok' && (
              <span className="font-mono text-[10px] text-[#4B5563]">
                project {sentry.project.slug} · refreshed {relativeTime(new Date(sentry.fetchedAt).toISOString())}
              </span>
            )}
          </div>
          <button
            onClick={() => { void fetchSentry(); }}
            disabled={sentry.kind === 'loading'}
            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-[#1F2937] text-[#9CA3AF] hover:text-[#E5E7EB] hover:border-[#87A96B]/30 disabled:opacity-40"
            aria-label="Refresh Sentry"
          >
            <RefreshCw size={11} className={sentry.kind === 'loading' ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {sentry.kind === 'loading' && (
          <div className="px-4 py-6 text-[11px] text-[#4B5563]">Loading Sentry health…</div>
        )}

        {sentry.kind === 'forbidden' && (
          <div className="flex items-start gap-2 px-4 py-3 text-[11px] text-[#9CA3AF]">
            <ShieldOff size={13} className="text-[#EF4444] mt-[2px]" />
            <span>
              <span className="text-[#FCA5A5] font-medium">Admin only.</span> The sentry-health function refused
              the request — your session may not have admin privileges, or it expired. Sign out and back in, then refresh.
            </span>
          </div>
        )}

        {sentry.kind === 'not_configured' && (
          <div className="flex items-start gap-2 px-4 py-3 text-[11px] text-[#9CA3AF]">
            <Info size={13} className="text-[#4B5563] mt-[2px]" />
            <span>
              <span className="text-[#9CA3AF] font-medium">Sentry not configured.</span> Set the{' '}
              <span className="font-mono text-[#E5E7EB]">SENTRY_AUTH_TOKEN</span>,{' '}
              <span className="font-mono text-[#E5E7EB]">SENTRY_ORG</span>, and{' '}
              <span className="font-mono text-[#E5E7EB]">SENTRY_PROJECT</span> secrets on the sentry-health function
              to enable this panel.
            </span>
          </div>
        )}

        {sentry.kind === 'unreachable' && (
          <div className="flex items-start gap-2 px-4 py-3 text-[11px] text-[#9CA3AF]">
            <AlertCircle size={13} className="text-[#F59E0B] mt-[2px]" />
            <span>
              <span className="text-[#FCD34D] font-medium">Sentry unreachable.</span> The function ran but couldn't
              reach Sentry, or returned an unexpected shape. Sentry might be degraded — try Refresh, or check the
              function logs.
            </span>
          </div>
        )}

        {sentry.kind === 'ok' && (
          <div className="flex flex-col">
            <div className="grid grid-cols-3 gap-3 px-4 py-3 border-b border-[#1F2937]">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-[#4B5563]">Errors 24h</span>
                <span className="font-mono text-[20px] font-bold text-[#E5E7EB]">
                  {sentry.errors24hApprox ? '≈' : ''}{sentry.errors24h}
                </span>
                {sentry.errors24hApprox && (
                  <span className="text-[9px] text-[#4B5563] leading-tight">
                    approx — Sentry stats unavailable
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-[#4B5563]">Last event</span>
                <span className="font-mono text-[13px] font-medium text-[#E5E7EB]">
                  {relativeTime(sentry.lastEventAt)}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-[#4B5563]">Project status</span>
                <span className="font-mono text-[13px] font-medium text-[#E5E7EB]">{sentry.project.status}</span>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider text-[#4B5563] mb-2">
                Top unresolved (24h)
              </div>
              {sentry.topIssues.length === 0 ? (
                <div className="text-[11px] text-[#4B5563]">No unresolved issues in the last 24 hours.</div>
              ) : (
                <div className="flex flex-col gap-1">
                  {sentry.topIssues.map((issue, i) => (
                    <div
                      key={`${issue.title}-${i}`}
                      className="flex items-start gap-3 px-2 py-2 rounded hover:bg-white/[0.02]"
                    >
                      <span
                        className={`font-mono font-bold text-[10px] uppercase w-12 flex-shrink-0 ${
                          issue.level === 'error' || issue.level === 'fatal'
                            ? 'text-[#EF4444]'
                            : issue.level === 'warning'
                              ? 'text-[#F59E0B]'
                              : 'text-[#9CA3AF]'
                        }`}
                      >
                        {issue.level}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-[#E5E7EB] truncate">{issue.title}</div>
                        {issue.culprit && (
                          <div className="font-mono text-[10px] text-[#4B5563] truncate">{issue.culprit}</div>
                        )}
                      </div>
                      <div className="flex items-baseline gap-3 flex-shrink-0">
                        <span className="font-mono text-[11px] text-[#9CA3AF]">{issue.count}×</span>
                        <span className="font-mono text-[10px] text-[#4B5563]">{issue.userCount}u</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Log viewer */}
      <div className="card flex flex-col flex-1 min-h-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937] flex-shrink-0 gap-3">
          <div className="flex items-center gap-2">
            <Server size={13} className="text-[#87A96B]" />
            <span className="text-[13px] font-semibold text-[#E5E7EB]">System Log Stream</span>
            <span className="badge badge-amber text-[9px] px-1.5 py-0.5 ml-1">SAMPLE</span>
            <span className="font-mono text-[10px] text-[#4B5563]">{logs.length} entries</span>
          </div>
          <div className="flex items-center gap-2">
            {(['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterLevel(f)}
                className={`text-[10px] font-mono font-medium px-2 py-1 rounded border transition-all ${
                  filterLevel === f
                    ? 'border-[#87A96B]/30 text-[#87A96B] bg-[#87A96B]/8'
                    : 'border-[#1F2937] text-[#4B5563] hover:text-[#9CA3AF]'
                }`}
              >
                {f}
              </button>
            ))}
            <div className="w-px h-4 bg-[#1F2937]" />
            <button
              onClick={() => setAutoScroll(a => !a)}
              className={`text-[10px] font-medium px-2 py-1 rounded border transition-all ${
                autoScroll
                  ? 'border-[#87A96B]/30 text-[#87A96B] bg-[#87A96B]/8'
                  : 'border-[#1F2937] text-[#4B5563]'
              }`}
            >
              Auto-scroll
            </button>
          </div>
        </div>

        {/* Log entries */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto font-mono text-[11px] p-3 space-y-[1px]"
          style={{ background: '#040404' }}
        >
          {filtered.map(log => {
            const cfg = LEVEL_CFG[log.level];
            return (
              <div
                key={log.id}
                className={`flex items-start gap-3 px-2 py-[4px] rounded hover:bg-white/[0.02] ${log.level === 'ERROR' ? 'bg-[#EF4444]/[0.04]' : ''}`}
              >
                <span className="text-[#2d3748] w-16 flex-shrink-0">{log.ts}</span>
                <span className={`font-bold w-12 flex-shrink-0 ${cfg.cls}`}>{log.level}</span>
                <span className="text-[#4B5563] w-36 flex-shrink-0 truncate">{log.service}</span>
                <span className="text-[#9CA3AF] flex-1">{log.message}</span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[#4B5563]">No logs match filter</div>
          )}
        </div>
      </div>
    </div>
  );
}
