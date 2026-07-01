import { type LucideIcon } from 'lucide-react';

export type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
};

interface SidebarProps {
  navItems: NavItem[];
  activeView: string;
  onNavigate: (id: string) => void;
}

export default function Sidebar({ navItems, activeView, onNavigate }: SidebarProps) {
  return (
    <aside
      style={{
        width: 220,
        minWidth: 220,
        borderRight: '1px solid #1F2937',
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Logo / Brand */}
      <div
        style={{
          padding: '18px 16px 14px',
          borderBottom: '1px solid #1F2937',
        }}
      >
        <div className="flex items-center gap-3">
          {/* Logo mark */}
          <img
            src={`${import.meta.env.BASE_URL}logo.jpg`}
            alt="Intr Logo"
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              objectFit: 'cover',
              flexShrink: 0,
              border: '1px solid #1F2937',
            }}
          />
          <div>
            <div className="text-[14px] font-bold text-[#E5E7EB] tracking-tight leading-none">Intr</div>
            <div className="text-[10px] text-[#4B5563] font-medium tracking-widest uppercase mt-[2px]">Admin</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-[2px]">
        {navItems.map(item => (
          <button
            key={item.id}
            className={`nav-link w-full text-left ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <item.icon size={15} strokeWidth={activeView === item.id ? 2.2 : 1.8} />
            <span className="flex-1">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span
                className="badge badge-red text-[9px] px-1.5 py-0.5 min-w-[18px] text-center"
              >
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #1F2937',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="w-[6px] h-[6px] rounded-full bg-[#87A96B] dot-pulse" />
          <span className="text-[10px] text-[#4B5563]">v2.4.1 · Prod</span>
        </div>
      </div>
    </aside>
  );
}
