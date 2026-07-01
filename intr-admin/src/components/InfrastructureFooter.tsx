import { useState, useEffect } from 'react';
import { SAMPLE_INFRASTRUCTURE_PINGS, type ServicePing } from '../utils/sampleInfra';

const STATUS_CONFIG = {
  operational: { dot: 'bg-[#87A96B]', text: 'text-[#87A96B]', label: 'Operational', pulse: true },
  degraded:    { dot: 'bg-[#F59E0B]', text: 'text-[#FCD34D]', label: 'Degraded',    pulse: true },
  down:        { dot: 'bg-[#EF4444]', text: 'text-[#FCA5A5]', label: 'Down',         pulse: false },
};

function PingItem({ ping }: { ping: ServicePing }) {
  const cfg = STATUS_CONFIG[ping.status];
  return (
    <div className="flex items-center gap-2 group">
      <div className={`w-[5px] h-[5px] rounded-full flex-shrink-0 ${cfg.dot} ${cfg.pulse ? 'dot-pulse' : ''}`} />
      <span className="text-[11px] text-[#9CA3AF] group-hover:text-[#E5E7EB] transition-colors whitespace-nowrap">
        {ping.name}
      </span>
      <span className={`text-[11px] font-medium ${cfg.text} whitespace-nowrap`}>
        {cfg.label}
      </span>
      <span className="font-mono text-[10px] text-[#4B5563] whitespace-nowrap hidden lg:inline">
        {ping.latency_ms}ms
      </span>
    </div>
  );
}

export default function InfrastructureFooter() {
  const [pings, setPings] = useState<ServicePing[]>(SAMPLE_INFRASTRUCTURE_PINGS);
  const [lastUpdate, setLastUpdate] = useState(new Date());

  // Simulate latency jitter every 8s
  useEffect(() => {
    const interval = setInterval(() => {
      setPings(prev =>
        prev.map(p => ({
          ...p,
          latency_ms: Math.max(8, p.latency_ms + Math.floor((Math.random() - 0.5) * 20)),
          last_checked: new Date().toISOString(),
        }))
      );
      setLastUpdate(new Date());
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  const allOk = pings.every(p => p.status === 'operational');
  const ts = lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <footer
      style={{
        height: 42,
        borderTop: '1px solid #1F2937',
        background: 'rgba(0,0,0,0.96)',
        backdropFilter: 'blur(8px)',
      }}
      className="flex items-center px-5 gap-6 flex-shrink-0"
    >
      {/* Status indicator */}
      <div className="flex items-center gap-2 flex-shrink-0 border-r border-[#1F2937] pr-5">
        <div className={`w-[6px] h-[6px] rounded-full ${allOk ? 'bg-[#87A96B] dot-pulse' : 'bg-[#EF4444]'}`} />
        <span className={`text-[11px] font-semibold tracking-wide ${allOk ? 'text-[#87A96B]' : 'text-[#FCA5A5]'}`}>
          {allOk ? 'All Systems Operational' : 'Degraded'}
        </span>
      </div>

      {/* Services */}
      <div className="flex items-center gap-5 flex-1 overflow-hidden">
        {pings.map((ping, i) => (
          <div key={ping.name} className="flex items-center gap-4">
            <PingItem ping={ping} />
            {i < pings.length - 1 && (
              <span className="text-[#1F2937] hidden sm:inline">|</span>
            )}
          </div>
        ))}
      </div>

      {/* Timestamp */}
      <div className="flex-shrink-0 border-l border-[#1F2937] pl-4 flex items-center gap-2">
        <span className="badge badge-amber text-[9px] px-1.5 py-0.5">SAMPLE</span>
        <span className="font-mono text-[10px] text-[#4B5563]">
          Pinged {ts}
        </span>
      </div>
    </footer>
  );
}
