import { useState, useEffect } from 'react';
import { DollarSign, CreditCard, Percent, Users, Info } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import RevenueFunnelPanel from '../components/RevenueFunnelPanel';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  fetchProfiles, fetchEvents, distinctUsersByEvent, weeklyEventSeries,
  ESTIMATED_MONTHLY_PRICE_USD, SPLIT_META, errMessage,
  type ProfileRow,
} from '../utils/adminQueries';

const CTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{value: number; name: string; color: string}>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 12px' }}>
      <p className="text-[11px] font-mono text-[#4B5563] mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-[11px] text-[#9CA3AF]">{p.name}:</span>
          <span className="font-mono text-[12px] font-bold" style={{ color: p.color }}>
            {p.name === 'MRR' ? `$${p.value.toLocaleString()}` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

interface RevenueData {
  mrrEst: number;
  proUsers: number;
  paywallViews: number;
  cvr: number;
  nonPro: number;
  trend: Array<{ week: string; subscribers: number; mrr: number }>;
  proRoster: ProfileRow[];
}

const EMPTY: RevenueData = { mrrEst: 0, proUsers: 0, paywallViews: 0, cvr: 0, nonPro: 0, trend: [], proRoster: [] };

export default function SubscriptionRevenuePage() {
  const [data, setData] = useState<RevenueData>(EMPTY);
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
        const proSet = byEvent.get('subscription_started') ?? new Set<string>();
        const paywallViews = byEvent.get('paywall_shown')?.size ?? 0;
        const proUsers = proSet.size;

        const weekly = weeklyEventSeries(events, 'subscription_started', 12);
        let cum = 0;
        const trend = weekly.map(w => {
          cum += w.count;
          return { week: w.week, subscribers: cum, mrr: parseFloat((cum * ESTIMATED_MONTHLY_PRICE_USD).toFixed(2)) };
        });

        setData({
          mrrEst: parseFloat((proUsers * ESTIMATED_MONTHLY_PRICE_USD).toFixed(2)),
          proUsers,
          paywallViews,
          cvr: paywallViews > 0 ? parseFloat(((proUsers / paywallViews) * 100).toFixed(1)) : 0,
          nonPro: Math.max(0, profiles.length - proUsers),
          trend,
          proRoster: profiles.filter(p => proSet.has(p.id)),
        });
      } catch (err) {
        if (active) setError(errMessage(err, 'Failed to load revenue data.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const hasTrend = data.trend.some(t => t.subscribers > 0);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Estimate banner */}
      <div className="flex items-start gap-2 bg-[#F59E0B]/[0.04] border border-[#F59E0B]/15 rounded-lg px-3 py-2 flex-shrink-0">
        <Info size={13} className="text-[#F59E0B] mt-[1px] flex-shrink-0" />
        <span className="text-[10px] text-[#9CA3AF] leading-relaxed">
          All figures on this page are <span className="text-[#FCD34D] font-medium">ESTIMATES</span> derived from analytics
          events at an assumed ${ESTIMATED_MONTHLY_PRICE_USD}/mo. There is no billing table — actual MRR, churn and
          cancellations are not tracked here.
        </span>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3 flex-shrink-0">
        <MetricCard label="Est. MRR" value={`$${data.mrrEst.toLocaleString()}`} subValue={`est · $${ESTIMATED_MONTHLY_PRICE_USD}/mo assumed`} icon={DollarSign} accent="sage" mono loading={loading} />
        <MetricCard label="Pro Subscribers" value={data.proUsers} subValue={`${data.paywallViews} paywall views`} icon={CreditCard} accent="purple" loading={loading} />
        <MetricCard label="Paywall → Pro CVR" value={`${data.cvr}%`} subValue="of paywall viewers converted" icon={Percent} accent="amber" loading={loading} />
        <MetricCard label="Non-Pro Users" value={data.nonPro} subValue="no subscription_started event" icon={Users} accent="blue" loading={loading} />
      </div>

      {error && (
        <div className="card p-3 text-[11px] text-[#FCA5A5] font-mono border-[#EF4444]/20 flex-shrink-0">{error}</div>
      )}

      {/* MRR trend line */}
      <div className="card flex flex-col flex-shrink-0" style={{ height: 200 }}>
        <div className="px-4 py-3 border-b border-[#1F2937] flex items-center gap-2">
          <DollarSign size={13} className="text-[#87A96B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB]">Est. MRR &amp; Subscriber Growth (12 weeks)</span>
          <span className="badge badge-amber text-[9px] px-1.5 py-0.5 ml-1">ESTIMATE</span>
        </div>
        <div className="flex-1 p-4 pt-2">
          {hasTrend ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.trend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="mrr" tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="subs" orientation="right" allowDecimals={false} tick={{ fontSize: 9, fill: '#4B5563', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.05)' }} />
                <Line yAxisId="mrr" type="monotone" dataKey="mrr" name="MRR" stroke="#87A96B" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#87A96B', stroke: '#000', strokeWidth: 2 }} />
                <Line yAxisId="subs" type="monotone" dataKey="subscribers" name="Subscribers" stroke="#A78BFA" strokeWidth={1.5} dot={false} strokeDasharray="4 3" activeDot={{ r: 4, fill: '#A78BFA', stroke: '#000', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-[11px] text-[#4B5563]">
              {loading ? 'Loading…' : 'No subscription_started events in the last 12 weeks'}
            </div>
          )}
        </div>
      </div>

      {/* Funnel + Pro roster */}
      <div className="flex gap-3 flex-1 min-h-0">
        <div style={{ flex: '0 0 50%' }}>
          <RevenueFunnelPanel />
        </div>
        {/* Pro subscriber roster */}
        <div className="card flex flex-col flex-1">
          <div className="px-4 py-3 border-b border-[#1F2937] flex items-center justify-between">
            <span className="text-[13px] font-semibold text-[#E5E7EB]">Pro Subscribers</span>
            <span className="badge badge-sage">{data.proRoster.length} active</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="grid px-4 py-2 border-b border-[#111] bg-[#0a0a0a]" style={{ gridTemplateColumns: '1fr 80px 80px 70px' }}>
              {['Username', 'Split', 'Days/wk', 'Entitlement'].map(h => (
                <span key={h} className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563]">{h}</span>
              ))}
            </div>
            {data.proRoster.map(p => (
              <div key={p.id} className="grid px-4 py-[9px] border-b border-[#0d0d0d] hover:bg-white/[0.015] items-center" style={{ gridTemplateColumns: '1fr 80px 80px 70px' }}>
                <span className="font-mono text-[12px] text-[#E5E7EB]">@{p.username ?? 'user'}</span>
                <span className="text-[11px] text-[#9CA3AF]">{p.preferred_split ? (SPLIT_META[p.preferred_split]?.label ?? p.preferred_split.replace(/_/g, '/')) : '—'}</span>
                <span className="font-mono text-[12px] text-[#9CA3AF]">{p.training_days ?? '—'}</span>
                <span className="badge badge-sage text-[9px] px-1.5 py-0.5">pro</span>
              </div>
            ))}
            {!loading && data.proRoster.length === 0 && (
              <div className="flex items-center justify-center h-32 text-[11px] text-[#4B5563] text-center px-4">
                No subscription_started events recorded — no Pro subscribers to show.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
