import React, { useState, useEffect } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../utils/supabaseClient';
import { ShieldAlert, LogIn, Lock, Mail, Loader2 } from 'lucide-react';

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const [session, setSession] = useState<Session | null>(null);
  // null = not yet resolved; boolean = resolved admin flag from the DB.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // Resolve the admin flag for a session by reading the caller's OWN profile
    // row (allowed by the existing profiles_select_own RLS policy). This is
    // defense-in-depth: the real enforcement is the RLS SELECT policies, which
    // already return zero rows from every table to a non-admin.
    async function resolve(nextSession: Session | null) {
      if (!active) return;
      setSession(nextSession);

      if (!nextSession) {
        setIsAdmin(null);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', nextSession.user.id)
        .maybeSingle();

      if (!active) return;
      // On any error (e.g. no profile row), fail closed — treat as non-admin.
      setIsAdmin(!error && data?.is_admin === true);
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data: { session } }) => resolve(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoading(true);
      resolve(session);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please fill in all fields.');
      return;
    }

    setAuthLoading(true);
    setErrorMsg(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setErrorMsg(error.message);
      }
    } catch {
      setErrorMsg('An unexpected error occurred. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center flex-col gap-3">
        <Loader2 className="animate-spin text-[#87A96B]" size={28} />
        <span className="font-mono text-[11px] text-[#4B5563] tracking-widest uppercase">Initializing Telemetry Core...</span>
      </div>
    );
  }

  // Unauthenticated
  if (!session) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="card w-full max-w-sm bg-[#0a0a0a] border border-[#1F2937] rounded-xl p-8 flex flex-col gap-6 shadow-2xl relative overflow-hidden">
          {/* Subtle Sage Glow background effect */}
          <div className="absolute top-[-50px] left-[-50px] w-[200px] h-[200px] rounded-full bg-[#87A96B]/5 blur-[80px] pointer-events-none" />

          {/* Brand Header */}
          <div className="flex flex-col items-center gap-3 text-center">
            <img
              src={`${import.meta.env.BASE_URL}logo.jpg`}
              alt="Intr Logo"
              className="w-14 h-14 rounded-xl border border-[#1F2937] shadow-lg object-cover"
            />
            <div>
              <h2 className="text-[16px] font-bold text-[#E5E7EB] tracking-tight">Intr Admin Portal</h2>
              <p className="text-[10px] text-[#4B5563] font-medium tracking-widest uppercase mt-1">Operational Control Center</p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {errorMsg && (
              <div className="bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-lg p-3 flex items-start gap-2.5 text-left">
                <ShieldAlert size={14} className="text-[#EF4444] mt-0.5 flex-shrink-0" />
                <span className="text-[11px] text-[#FCA5A5] leading-relaxed font-medium">{errorMsg}</span>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] mb-1">Admin Identity</label>
              <div className="relative">
                <Mail size={13} className="absolute left-3 top-3.5 text-[#4B5563]" />
                <input
                  type="email"
                  placeholder="admin@intr.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={authLoading}
                  className="w-full bg-black border border-[#1F2937] rounded-lg py-2.5 pl-9 pr-4 text-[13px] text-[#E5E7EB] placeholder-[#4B5563] focus:border-[#87A96B] focus:outline-none focus:ring-1 focus:ring-[#87A96B]/30 transition-all font-mono"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-[#4B5563] mb-1">Access Token</label>
              <div className="relative">
                <Lock size={13} className="absolute left-3 top-3.5 text-[#4B5563]" />
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={authLoading}
                  className="w-full bg-black border border-[#1F2937] rounded-lg py-2.5 pl-9 pr-4 text-[13px] text-[#E5E7EB] placeholder-[#4B5563] focus:border-[#87A96B] focus:outline-none focus:ring-1 focus:ring-[#87A96B]/30 transition-all font-mono"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full bg-[#87A96B] hover:bg-[#98b87c] text-black font-bold py-2.5 rounded-lg text-[13px] tracking-wide flex items-center justify-center gap-2 cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-[0_0_15px_rgba(135,169,107,0.25)]"
            >
              {authLoading ? (
                <>
                  <Loader2 className="animate-spin text-black" size={14} />
                  <span>AUTHORIZING GATE...</span>
                </>
              ) : (
                <>
                  <LogIn size={14} />
                  <span>ESTABLISH SECURE LINK</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Authenticated — gate on the DB-backed admin flag (defense-in-depth on top
  // of the RLS policies that already restrict every table to admins).
  const userEmail = session.user?.email;

  if (isAdmin !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="card w-full max-w-sm bg-[#0a0a0a] border border-[#EF4444]/20 rounded-xl p-8 flex flex-col gap-5 text-center shadow-2xl relative overflow-hidden">
          <div className="absolute top-[-50px] left-[-50px] w-[200px] h-[200px] rounded-full bg-[#EF4444]/5 blur-[80px] pointer-events-none" />
          
          <div className="flex justify-center">
            <div className="w-12 h-12 rounded-full bg-[#EF4444]/10 border border-[#EF4444]/20 flex items-center justify-center">
              <ShieldAlert className="text-[#EF4444]" size={22} />
            </div>
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-[#E5E7EB] tracking-tight">ACCESS DENIED</h2>
            <p className="text-[10px] text-[#EF4444] font-semibold tracking-widest uppercase mt-1">SECURITY EXCLUSION AREA</p>
          </div>

          <p className="text-[12px] text-[#9CA3AF] leading-relaxed">
            Identity <span className="font-mono text-[#FCA5A5] bg-red-950/20 px-1 py-0.5 rounded border border-[#EF4444]/10">{userEmail}</span> is not authorized. Operational clearance is restricted to master administrators.
          </p>

          <div className="border-t border-[#1F2937] pt-4 flex flex-col gap-2">
            <button
              onClick={handleSignOut}
              className="w-full bg-[#111] hover:bg-[#1A1A1A] border border-[#1F2937] text-[#9CA3AF] hover:text-[#E5E7EB] font-medium py-2 rounded-lg text-[12px] tracking-wide transition-all cursor-pointer"
            >
              DISCONNECT SESSION
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Authorized
  return <>{children}</>;
}
