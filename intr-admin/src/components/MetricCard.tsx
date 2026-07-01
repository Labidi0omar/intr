import { type LucideIcon } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  change?: number; // percentage
  changeLabel?: string;
  icon: LucideIcon;
  accent?: 'sage' | 'blue' | 'amber' | 'purple' | 'red';
  mono?: boolean;
  loading?: boolean;
}

const ACCENT_MAP = {
  sage:   { icon: 'text-[#87A96B]', ring: 'border-[#87A96B]/20 bg-[#87A96B]/8', glow: '0 0 10px rgba(135,169,107,0.15)' },
  blue:   { icon: 'text-[#60A5FA]', ring: 'border-[#60A5FA]/20 bg-[#60A5FA]/8', glow: '0 0 10px rgba(96,165,250,0.12)' },
  amber:  { icon: 'text-[#F59E0B]', ring: 'border-[#F59E0B]/20 bg-[#F59E0B]/8', glow: '0 0 10px rgba(245,158,11,0.12)' },
  purple: { icon: 'text-[#A78BFA]', ring: 'border-[#A78BFA]/20 bg-[#A78BFA]/8', glow: '0 0 10px rgba(167,139,250,0.12)' },
  red:    { icon: 'text-[#EF4444]', ring: 'border-[#EF4444]/20 bg-[#EF4444]/8', glow: '0 0 10px rgba(239,68,68,0.12)' },
};

export default function MetricCard({ label, value, subValue, change, changeLabel, icon: Icon, accent = 'sage', mono = false, loading = false }: MetricCardProps) {
  if (loading) {
    return (
      <div
        className="card p-4 flex flex-col gap-3 justify-between animate-pulse cursor-default"
        style={{ minHeight: 120 }}
      >
        <div className="flex items-center justify-between">
          <div className="h-3 bg-[#111] rounded w-24" />
          <div className="w-8 h-8 rounded-md bg-[#111] border border-[#1F2937]" />
        </div>
        <div className="h-6 bg-[#111] rounded w-16" />
        <div className="h-3 bg-[#111] rounded w-32" />
      </div>
    );
  }
  const a = ACCENT_MAP[accent];
  const isPositive = change !== undefined && change >= 0;
  const isNegative = change !== undefined && change < 0;

  return (
    <div
      className="card card-interactive fade-in p-4 flex flex-col gap-3 group cursor-default"
      style={{ minHeight: 120 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="metric-label">{label}</span>
        <div
          className={`w-8 h-8 rounded-md border flex items-center justify-center transition-all duration-200 group-hover:scale-105 ${a.ring}`}
          style={{ boxShadow: 'none' }}
        >
          <Icon size={15} className={a.icon} strokeWidth={2} />
        </div>
      </div>

      {/* Value */}
      <div className="flex items-end gap-2">
        <span className={`metric-value ${mono ? 'font-mono text-[22px]' : ''}`}>
          {value}
        </span>
        {change !== undefined && (
          <span
            className={`text-[11px] font-semibold mb-[2px] ${
              isPositive ? 'text-[#87A96B]' : isNegative ? 'text-[#EF4444]' : 'text-[#9CA3AF]'
            }`}
          >
            {isPositive ? '+' : ''}{change.toFixed(1)}%
          </span>
        )}
      </div>

      {/* Sub-value */}
      {(subValue || changeLabel) && (
        <div className="flex items-center gap-2">
          {subValue && (
            <span className="text-[12px] text-[#9CA3AF] leading-tight">{subValue}</span>
          )}
          {changeLabel && (
            <span className="text-[11px] text-[#4B5563]">{changeLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
