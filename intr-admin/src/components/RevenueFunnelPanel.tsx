import { useState, useEffect } from 'react';
import { DollarSign, Users, Info } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  fetchProfiles, fetchEvents, distinctUsersByEvent, weeklyEventSeries,
  ESTIMATED_MONTHLY_PRICE_USD, errMessage,
} from '../utils/adminQueries';

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 12px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
      <p className="text-[11px] font-mono text-[#4B5563] mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-[#87A96B]">{p.value}</span>
          <span className="text-[10px] text-[#4B5563]">{p.name}</span>
        </div>
      ))}
    </div>
  );
};

interface FunnelStage { stage: string; count: number; pct: number; }
interface FunnelData {
  mrrEst: number;
  proUsers: number;
  paywallViews: number;
  cvr: number;
  funnel: FunnelStage[];
  trend: Array<{ week: string; count: number }>;
}

const EMPTY: FunnelData = { mrrEst: 0, proUsers: 0, paywallViews: 0, cvr: 0, funnel: [], trend: [] };

export default function RevenueFunnelPanel() {
  const [data, setData] = useState<FunnelData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [profiles, events] = await Promise.all([fetchProfiles(), fetchEvents()]);
        if (!active) return;

        const byEvent = distinctUsersByEvent(events);
        const registered = profiles.length;
        const onboarded = profiles.filter(p => p.onboarding_complete === true).length;
        const workout = byEvent.get('workout_completed')?.size ?? 0;
        const paywallViews = byEvent.get('paywall_shown')?.size ?? 0;
        const proUsers = byEvent.get('subscription_started')?.size ?? 0;

        const pct = (n: number) => (registered > 0 ? parseFloat(((n / registered) * 100).toFixed(1)) : 0);
        const funnel: FunnelStage[] = [
          { stage: 'Registered', count: registered, pct: 100 },
          { stage: 'Onboarded', count: onboarded, pct: pct(onboarded) },
          { stage: 'Workout Completed', count: workout, pct: pct(workout) },
          { stage: 'Paywall Shown', count: paywallViews, pct: pct(paywallViews) },
          { stage: 'Pro Converted', count: proUsers, pct: pct(proUsers) },
        ];

        setData({
          mrrEst: parseFloat((proUsers * ESTIMATED_MONTHLY_PRICE_USD).toFixed(2)),
          proUsers,
          paywallViews,
          cvr: paywallViews > 0 ? parseFloat(((proUsers / paywallViews) * 100).toFixed(1)) : 0,
          funnel,
          trend: weeklyEventSeries(events, 'subscription_started', 12),
        });
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load revenue funnel.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const maxFunnelCount = data.funnel[0]?.count || 1;
  const hasTrend = data.trend.some(t => t.count > 0);

  return (
    <div className="card flex flex-col" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937]">
        <div className="flex items-center gap-2">
          <DollarSign size={14} className="text-[#87A96B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB] tracking-wide">
            Subscription Funnel
          </span>
          <span className="badge badge-amber text-[9px] px-1.5 py-0.5 ml-1">ESTIMATE</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono text-[14px] font-bold text-[#87A96B]">
              ${data.mrrEst.toLocaleString('en-US', { minimumFractionDigits: 0 })}
            </div>
            <div className="text-[10px] text-[#4B5563]">Est. MRR</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* New Pro signups sparkline */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[#4B5563] font-medium uppercase tracking-widest">New Pro Signups (12w, est)</span>
          </div>
          <div style={{ height: 64 }}>
            {hasTrend ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.trend} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
                  <XAxis dataKey="week" hide />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip content={<CustomTooltip />} cursor={false} />
                  <Bar dataKey="count" name="new subs" radius={[2, 2, 0, 0]}>
                    {data.trend.map((_, i) => (
                      <Cell key={i} fill={i === data.trend.length - 1 ? '#87A96B' : 'rgba(135,169,107,0.3)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[10px] text-[#4B5563]">
                {loading ? 'Loading…' : 'No subscription_started events recorded'}
              </div>
            )}
          </div>
        </div>

        {/* Funnel */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Users size={11} className="text-[#4B5563]" />
            <span className="text-[11px] text-[#4B5563] font-medium uppercase tracking-widest">Conversion Funnel</span>
          </div>
          <div className="space-y-[6px]">
            {data.funnel.map((stage, i) => {
              const barW = (stage.count / maxFunnelCount) * 100;
              const isTop = i === 0;
              const isPro = stage.stage === 'Pro Converted';
              return (
                <div key={stage.stage} className="group">
                  <div className="flex items-center justify-between mb-[3px]">
                    <span className={`text-[11px] font-medium ${isPro ? 'text-[#87A96B]' : 'text-[#9CA3AF]'}`}>
                      {stage.stage}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-[#E5E7EB]">{stage.count.toLocaleString()}</span>
                      <span className="font-mono text-[10px] text-[#4B5563]">{stage.pct}%</span>
                    </div>
                  </div>
                  <div className="h-[4px] bg-[#111] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{
                        width: `${barW}%`,
                        background: isPro
                          ? 'linear-gradient(90deg, #87A96B, #a8c98a)'
                          : isTop
                          ? 'rgba(135,169,107,0.4)'
                          : `rgba(135,169,107,${0.1 + (i * 0.05)})`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-[#1F2937]" />

        {/* Estimate disclaimer (no billing/cancellation source) */}
        <div className="flex items-start gap-2 bg-[#F59E0B]/[0.04] border border-[#F59E0B]/15 rounded-md p-3">
          <Info size={13} className="text-[#F59E0B] mt-[1px] flex-shrink-0" />
          <span className="text-[10px] text-[#9CA3AF] leading-relaxed">
            Revenue figures are <span className="text-[#FCD34D] font-medium">estimates</span> derived from analytics
            events (<span className="font-mono">subscription_started</span>, <span className="font-mono">paywall_shown</span>)
            at an assumed ${ESTIMATED_MONTHLY_PRICE_USD}/mo. There is no billing table, so churn, cancellations and true
            MRR are not available.
          </span>
        </div>

        {/* KPIs row */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Pro Users', value: data.proUsers.toLocaleString() },
            { label: 'Paywall Views', value: data.paywallViews.toLocaleString() },
            { label: 'Paywall→Pro', value: `${data.cvr}%` },
          ].map(k => (
            <div key={k.label} className="bg-[#0a0a0a] border border-[#1F2937] rounded-md px-3 py-2 text-center">
              <div className="font-mono text-[13px] font-bold text-[#E5E7EB]">{k.value}</div>
              <div className="text-[10px] text-[#4B5563] mt-[2px]">{k.label}</div>
            </div>
          ))}
        </div>

        {error && <div className="text-[10px] text-[#FCA5A5] font-mono">{error}</div>}
      </div>
    </div>
  );
}
