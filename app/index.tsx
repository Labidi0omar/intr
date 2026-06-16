import 'react-native-gesture-handler';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { supabase } from '../src/lib/supabase';
import { reportSilent } from '../src/lib/errorReporting';

// Root session + onboarding gate. Three terminal states:
//   1. no session                → /welcome
//   2. session, onboarding not done → /onboarding
//   3. session, onboarding done   → /(tabs)/home
//
// The onboarding check is what protects users who kill the app
// mid-onboarding: without it they'd land on a home screen with no plan.
export default function Index() {
  const [session, setSession] = useState<any>(null);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setSession(session);

        if (session?.user) {
          // maybeSingle so a brand-new user with no profile row (shouldn't
          // happen — sign-up creates one — but be defensive) is treated as
          // "not yet onboarded".
          const { data: profile } = await supabase
            .from('profiles')
            .select('onboarding_complete')
            .eq('id', session.user.id)
            .maybeSingle();
          setOnboardingDone(!!profile?.onboarding_complete);
        }
      } catch (e) {
        // On any failure, fall through to login. Better than crashing the
        // root route.
        reportSilent(e, 'index:sessionGate');
        setSession(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return null;

  if (!session) return <Redirect href="/welcome" />;
  if (!onboardingDone) return <Redirect href="/onboarding" />;

  return <Redirect href="/(tabs)/home" />;
}
