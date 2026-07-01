import { useState, useEffect } from 'react';
import {
  LayoutDashboard, Users, Dumbbell, CreditCard, Server, LogOut,
} from 'lucide-react';
import Sidebar, { type NavItem } from './components/Sidebar';
import InfrastructureFooter from './components/InfrastructureFooter';
import OverviewPage from './pages/OverviewPage';
import UserAnalyticsPage from './pages/UserAnalyticsPage';
import ContentWorkoutPage from './pages/ContentWorkoutPage';
import SubscriptionRevenuePage from './pages/SubscriptionRevenuePage';
import SystemHealthPage from './pages/SystemHealthPage';
import AuthGuard from './components/AuthGuard';
import { supabase } from './utils/supabaseClient';

type ViewId = 'overview' | 'users' | 'content' | 'subscription' | 'system';

const NAV_ITEMS: NavItem[] = [
  { id: 'overview',     label: 'Overview',              icon: LayoutDashboard },
  { id: 'users',        label: 'User Analytics',         icon: Users           },
  { id: 'content',      label: 'Content & Workouts',     icon: Dumbbell        },
  { id: 'subscription', label: 'Subscription & Revenue', icon: CreditCard      },
  { id: 'system',       label: 'System Health',          icon: Server          },
];

const PAGE_TITLES: Record<ViewId, string> = {
  overview:     'Overview',
  users:        'User Analytics',
  content:      'Content & Workout Management',
  subscription: 'Subscription & Revenue',
  system:       'System Health / Logs',
};

const PAGE_MAP: Record<ViewId, React.ComponentType> = {
  overview:     OverviewPage,
  users:        UserAnalyticsPage,
  content:      ContentWorkoutPage,
  subscription: SubscriptionRevenuePage,
  system:       SystemHealthPage,
};

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>('overview');

  const ActivePage = PAGE_MAP[activeView];
  const title = PAGE_TITLES[activeView];

  return (
    <AuthGuard>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000', overflow: 'hidden' }}>

        {/* Body: Sidebar + Main */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <Sidebar
          navItems={NAV_ITEMS}
          activeView={activeView}
          onNavigate={id => setActiveView(id as ViewId)}
        />

        {/* Main content area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Topbar */}
          <header
            style={{
              height: 52,
              borderBottom: '1px solid #1F2937',
              background: '#000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 20px',
              flexShrink: 0,
            }}
          >
            <div className="flex items-center gap-3">
              <h1 className="text-[14px] font-semibold text-[#E5E7EB] tracking-tight">{title}</h1>
            </div>
            <div className="flex items-center gap-4">
              {/* Live clock */}
              <LiveClock />
              {/* Admin badge */}
              <div className="flex items-center gap-2">
                <div
                  style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: 'linear-gradient(135deg, #87A96B, #5d7a49)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: '#000',
                  }}
                >
                  A
                </div>
                <div>
                  <div className="text-[11px] font-medium text-[#E5E7EB]">Admin</div>
                  <div className="text-[9px] text-[#4B5563]">Read-only · RLS</div>
                </div>
              </div>
              {/* Disconnect Button */}
              <button
                onClick={() => supabase.auth.signOut()}
                className="flex items-center justify-center p-1.5 rounded border border-[#1F2937] hover:border-[#EF4444]/40 hover:bg-[#EF4444]/5 text-[#4B5563] hover:text-[#EF4444] transition-all cursor-pointer"
                title="Disconnect Admin Session"
              >
                <LogOut size={13} />
              </button>
            </div>
          </header>

          {/* Page scroll area */}
          <main
            style={{ flex: 1, overflow: 'auto', padding: 16 }}
            className="fade-in"
            key={activeView}
          >
            <ActivePage />
          </main>
        </div>
      </div>
        {/* Footer */}
        <InfrastructureFooter />
      </div>
    </AuthGuard>
  );
}

function LiveClock() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const date = time.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="text-right">
      <div className="font-mono text-[13px] font-semibold text-[#E5E7EB]">{ts}</div>
      <div className="font-mono text-[9px] text-[#4B5563]">{date}</div>
    </div>
  );
}
