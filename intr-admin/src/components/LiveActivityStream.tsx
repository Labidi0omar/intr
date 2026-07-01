import { useState, useEffect, useRef } from 'react';
import { Activity, Zap, ShieldAlert, AlertTriangle } from 'lucide-react';
import { supabase } from '../utils/supabaseClient';
import { timeAgo } from '../utils/dateUtils';
// Columns used:
//   profiles:         id, username (nullable text)
//   workout_sessions: id, user_id, completed, completed_at, workout_type, created_at, is_recovery
//   journal_entries:  user_id, date, created_at, user_text

export interface StreamEvent {
  id: string;
  message: string;
  event_type: string;
  color: 'sage' | 'blue' | 'amber' | 'purple' | 'red';
  timestamp: Date;
  age_label: string;
}

const COLOR_MAP: Record<StreamEvent['color'], string> = {
  sage:   '#87A96B',
  blue:   '#60A5FA',
  amber:  '#F59E0B',
  purple: '#A78BFA',
  red:    '#EF4444',
};

const DOT_BG: Record<StreamEvent['color'], string> = {
  sage:   'bg-[#87A96B]/15',
  blue:   'bg-[#60A5FA]/15',
  amber:  'bg-[#F59E0B]/15',
  purple: 'bg-[#A78BFA]/15',
  red:    'bg-[#EF4444]/15',
};

export default function LiveActivityStream() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Age labels ticker
  useEffect(() => {
    const tick = setInterval(() => {
      setEvents(prev =>
        prev.map(ev => ({ ...ev, age_label: timeAgo(ev.timestamp) }))
      );
    }, 10000);
    return () => clearInterval(tick);
  }, []);

  // Fetch recent activity and set up real-time listener
  useEffect(() => {
    const userMap = new Map<string, string>();

    async function initActivity() {
      try {
        setLoading(true);
        setError(null);

        // Fetch profiles for username lookup (username is nullable in schema)
        const { data: profiles, error: pErr } = await supabase.from('profiles').select('id, username');
        if (pErr) throw pErr;

        // username is TEXT (nullable) — fall back to 'user' when null
        profiles?.forEach(p => userMap.set(p.id, p.username ?? 'user'));

        // Fetch recent training sessions (exclude recovery via is_recovery=false)
        // Columns: id, user_id, completed, completed_at, workout_type, created_at
        const { data: workouts, error: wErr } = await supabase
          .from('workout_sessions')
          .select('id, user_id, completed, completed_at, workout_type, created_at')
          .eq('is_recovery', false)
          .order('created_at', { ascending: false })
          .limit(20);
        if (wErr) throw wErr;

        // Fetch recent journal entries
        // Columns: user_id, date, created_at, user_text
        const { data: journals, error: jErr } = await supabase
          .from('journal_entries')
          .select('user_id, date, created_at, user_text')
          .order('created_at', { ascending: false })
          .limit(20);
        if (jErr) throw jErr;

        const list: StreamEvent[] = [];

        workouts?.forEach(w => {
          const username = userMap.get(w.user_id) || 'user';
          const date = new Date(w.completed_at || w.created_at);
          list.push({
            id: w.id,
            message: w.completed 
              ? `@${username} completed session "${w.workout_type || 'Workout'}"`
              : `@${username} started session "${w.workout_type || 'Workout'}"`,
            event_type: w.completed ? 'workout_completed' : 'workout_started',
            color: w.completed ? 'sage' : 'blue',
            timestamp: date,
            age_label: timeAgo(date)
          });
        });

        journals?.forEach(j => {
          const username = userMap.get(j.user_id) || 'user';
          const date = new Date(j.created_at);
          const text = j.user_text || '';
          const mood = text.toLowerCase();
          const isNegative = mood.includes('off') || mood.includes('flat') || mood.includes('tired') || mood.includes('bad');
          
          list.push({
            id: `journal_${j.user_id}_${j.date}`,
            message: `@${username} logged reflection: "${text.slice(0, 35)}${text.length > 35 ? '...' : ''}"`,
            event_type: 'reflection',
            color: isNegative ? 'amber' : 'blue',
            timestamp: date,
            age_label: timeAgo(date)
          });
        });

        list.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        setEvents(list.slice(0, 30));

      } catch (err) {
        console.error('Failed to initialize activity feed:', err);
        setError(err instanceof Error ? err.message : 'Database connection error.');
      } finally {
        setLoading(false);
      }
    }

    initActivity();

    // Real-time subscription — only training sessions (we filter is_recovery on the stream
    // client-side from payload since realtime doesn't support column filters in this SDK version)
    const channel = supabase
      .channel('realtime-dashboard-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'workout_sessions' }, async (payload) => {
        if (isPaused) return;
        const row = payload.new;
        const userId = row.user_id as string | undefined;
        if (!userId) return;
        // Skip recovery sessions in the live feed
        if (row.is_recovery === true) return;

        let username = userMap.get(userId);
        if (!username) {
          const { data } = await supabase.from('profiles').select('username').eq('id', userId).single();
          // username is nullable
          const dbUsername = (data?.username as string | null) ?? 'user';
          userMap.set(userId, dbUsername);
          username = dbUsername;
        }
        const date = new Date((row.completed_at || row.created_at || new Date().toISOString()) as string);
        const workoutLabel = (row.workout_type as string | null) || 'Workout';
        const newEv: StreamEvent = {
          id: row.id as string,
          message: row.completed
            ? `@${username} completed session "${workoutLabel}"`
            : `@${username} started session "${workoutLabel}"`,
          event_type: row.completed ? 'workout_completed' : 'workout_started',
          color: row.completed ? 'sage' : 'blue',
          timestamp: date,
          age_label: 'just now',
        };
        setEvents(prev => [newEv, ...prev].slice(0, 30));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'journal_entries' }, async (payload) => {
        if (isPaused) return;
        const row = payload.new;
        const userId = row.user_id as string | undefined;
        if (!userId) return;

        let username = userMap.get(userId);
        if (!username) {
          const { data } = await supabase.from('profiles').select('username').eq('id', userId).single();
          const dbUsername = (data?.username as string | null) ?? 'user';
          userMap.set(userId, dbUsername);
          username = dbUsername;
        }
        const date = new Date((row.created_at || new Date().toISOString()) as string);
        // user_text is the correct column name (not 'text' or 'content')
        const text = (row.user_text as string | null) ?? '';
        const mood = text.toLowerCase();
        const isNegative = mood.includes('off') || mood.includes('flat') || mood.includes('tired') || mood.includes('bad');

        const newEv: StreamEvent = {
          id: `journal_${userId}_${(row.date as string | null) || date.toISOString().split('T')[0]}`,
          message: `@${username} logged reflection: "${text.slice(0, 35)}${text.length > 35 ? '...' : ''}"`,
          event_type: 'reflection',
          color: isNegative ? 'amber' : 'blue',
          timestamp: date,
          age_label: 'just now',
        };
        setEvents(prev => [newEv, ...prev].slice(0, 30));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPaused]);

  // Auto-scroll to top when new event arrives
  useEffect(() => {
    if (!isPaused && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [events, isPaused]);

  return (
    <div className="card flex flex-col" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F2937]">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[#87A96B]" />
          <span className="text-[13px] font-semibold text-[#E5E7EB] tracking-wide">Live Activity</span>
          {!loading && !error && events.length > 0 && <div className="dot-pulse ml-1" />}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPaused(p => !p)}
            className={`text-[11px] font-medium px-2 py-1 rounded border transition-all duration-150 ${
              isPaused
                ? 'border-[#F59E0B]/30 text-[#FCD34D] bg-[#F59E0B]/8 hover:bg-[#F59E0B]/12'
                : 'border-[#1F2937] text-[#4B5563] hover:border-[#2d3748] hover:text-[#9CA3AF]'
            }`}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          {!loading && !error && (
            <span className="font-mono text-[10px] text-[#4B5563]">{events.length} events</span>
          )}
        </div>
      </div>

      {/* Stream content / Loading / Error states */}
      {loading ? (
        <div className="flex-1 p-3 space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="flex items-center gap-3 animate-pulse py-1.5">
              <div className="w-5 h-5 rounded-full bg-[#111]" />
              <div className="flex-1 h-3.5 bg-[#111] rounded w-2/3" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <div className="bg-[#EF4444]/5 border border-[#EF4444]/15 rounded-lg p-4 flex flex-col items-center gap-1.5 max-w-[200px]">
            <ShieldAlert size={18} className="text-[#EF4444]" />
            <span className="text-[11px] font-bold text-[#E5E7EB]">Feed Error</span>
            <span className="text-[9px] text-[#9CA3AF] font-mono">{error}</span>
          </div>
        </div>
      ) : events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4 text-center">
          <div className="bg-[#87A96B]/5 border border-[#87A96B]/15 rounded-lg p-4 flex flex-col items-center gap-1.5 max-w-[200px]">
            <AlertTriangle size={18} className="text-[#87A96B]" />
            <span className="text-[11px] font-bold text-[#E5E7EB]">No Active Events</span>
            <span className="text-[9px] text-[#9CA3AF]">Awaiting logs from the ecosystem.</span>
          </div>
        </div>
      ) : (
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-3 py-2 space-y-[2px]"
          style={{ scrollBehavior: 'smooth' }}
        >
          {events.map((ev, i) => (
            <div
              key={ev.id}
              className={`flex items-start gap-3 px-2 py-[7px] rounded-md transition-all duration-150 hover:bg-white/[0.02] group ${
                i === 0 ? 'stream-item' : ''
              }`}
            >
              {/* Dot */}
              <div className={`mt-[3px] w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${DOT_BG[ev.color]}`}>
                <Zap size={9} style={{ color: COLOR_MAP[ev.color] }} strokeWidth={2.5} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p
                  className="text-[12px] leading-[1.45] text-[#D1D5DB] group-hover:text-[#E5E7EB] transition-colors"
                  style={{ wordBreak: 'break-word' }}
                >
                  {ev.message}
                </p>
              </div>

              {/* Time */}
              <span className="font-mono text-[10px] text-[#4B5563] mt-[2px] flex-shrink-0 whitespace-nowrap">
                {ev.age_label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
