import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';
import { track } from './analytics';
import { reportSilent } from './errorReporting';

// Tell Expo to dismiss the auth browser when the redirect happens.
// Calling this once at module load is the idiomatic Expo pattern.
WebBrowser.maybeCompleteAuthSession();

export type GoogleAuthResult =
  | { kind: 'ok'; isNewUser: boolean }
  | { kind: 'cancel' }
  | { kind: 'error'; message: string };

/**
 * Drive the Supabase Google OAuth flow inside an in-app browser session
 * and return the resolved auth outcome. The session is set on success;
 * the caller is responsible for navigation.
 *
 * Flow:
 *   1. Ask Supabase for the provider URL (skipBrowserRedirect → we control the open)
 *   2. WebBrowser.openAuthSessionAsync — opens an in-app browser bound to a
 *      redirect scheme. Closes automatically when the user hits the scheme.
 *   3. Parse access_token + refresh_token from the redirect URL fragment.
 *   4. supabase.auth.setSession → session active, profile rows queryable.
 *   5. If no profiles row exists, create one (mirrors the sign-up flow).
 */
export async function signInWithGoogle(): Promise<GoogleAuthResult> {
  try {
    // Build the redirect we want Supabase to send the user back to.
    // app.json has `scheme: 'intr'` → this resolves to `intr://auth-callback`
    // in a dev/production build, OR `exp://<host>:<port>/--/auth-callback`
    // in Expo Go. Both must be allowlisted in Supabase Auth → URL Configuration.
    const redirectTo = Linking.createURL('auth-callback');

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      return { kind: 'error', message: error?.message ?? 'OAuth init failed' };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, {
      showInRecents: false,
    });

    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { kind: 'cancel' };
    }
    if (result.type !== 'success' || !result.url) {
      return { kind: 'error', message: 'Browser closed unexpectedly' };
    }

    // Supabase returns tokens in the URL fragment (#access_token=…&refresh_token=…)
    // Also handles the modern PKCE flow where tokens come as query params.
    const tokens = parseTokensFromUrl(result.url);
    if (!tokens.access_token || !tokens.refresh_token) {
      return { kind: 'error', message: 'No tokens in redirect' };
    }

    const { data: sessionData, error: sessionErr } = await supabase.auth.setSession({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
    if (sessionErr || !sessionData.user) {
      return { kind: 'error', message: sessionErr?.message ?? 'Session set failed' };
    }

    const user = sessionData.user;

    // Ensure a profiles row exists. If not, create one and mark this as
    // a new user so the caller can route to onboarding.
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, onboarding_complete')
      .eq('id', user.id)
      .maybeSingle();

    let isNewUser = false;
    if (!existingProfile) {
      const { error: upsertErr } = await supabase.from('profiles').upsert({
        id: user.id,
        onboarding_complete: false,
        // Use the Google display name as a starting username; user can edit later.
        username:
          (user.user_metadata?.full_name as string | undefined) ??
          (user.user_metadata?.name as string | undefined) ??
          null,
      });
      if (upsertErr) {
        // Non-fatal — user is signed in; onboarding will surface the gap.
        console.warn('[googleAuth] profile upsert failed:', upsertErr.message);
      }
      isNewUser = true;
      track('signup', { provider: 'google' });
    } else if (!existingProfile.onboarding_complete) {
      isNewUser = true;
    }

    return { kind: 'ok', isNewUser };
  } catch (e: any) {
    return { kind: 'error', message: e?.message ?? String(e) };
  }
}

function parseTokensFromUrl(rawUrl: string): { access_token?: string; refresh_token?: string } {
  try {
    // Supabase puts tokens in the fragment (#k=v&k=v) on the implicit flow.
    // expo-linking and URL polyfill may strip the fragment from `.hash`, so
    // parse the raw string directly.
    const fragmentIdx = rawUrl.indexOf('#');
    const queryIdx = rawUrl.indexOf('?');
    const fragment = fragmentIdx >= 0 ? rawUrl.slice(fragmentIdx + 1) : '';
    const query = queryIdx >= 0 ? rawUrl.slice(queryIdx + 1, fragmentIdx >= 0 ? fragmentIdx : undefined) : '';

    const collect = (s: string) => {
      const out: Record<string, string> = {};
      for (const pair of s.split('&')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = decodeURIComponent(pair.slice(0, eq));
        const v = decodeURIComponent(pair.slice(eq + 1));
        out[k] = v;
      }
      return out;
    };

    const merged = { ...collect(query), ...collect(fragment) };
    return {
      access_token: merged.access_token,
      refresh_token: merged.refresh_token,
    };
  } catch (e) {
    reportSilent(e, 'googleAuth:parseRedirectTokens');
    return {};
  }
}
