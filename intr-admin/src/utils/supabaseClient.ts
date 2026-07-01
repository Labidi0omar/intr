import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client for the Intr Admin Dashboard
//
// This is a STATIC site served from public GitHub Pages. Anything bundled here
// is world-readable, so there is exactly ONE client and it uses ONLY the public
// anon key. The anon key is safe to ship by design — it carries no privileges
// beyond what Row Level Security grants the authenticated user.
//
// Admin access is granted in the DATABASE, not the client: an admin is a profile
// row with is_admin = true, and every dashboard table has an RLS SELECT policy
// `using ( public.is_admin() )`. A logged-in admin therefore reads all rows over
// this same anon client; a normal user reads only their own.
//
// ⚠ NEVER add the service-role key (or any other secret) to this file or to a
//   VITE_* env var — Vite inlines VITE_* values into the public bundle, which
//   would leak the secret to every visitor. There is no secret to add here.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://ehbbpawgntvykkiioukl.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoYmJwYXdnbnR2eWtraWlvdWtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI0NDAsImV4cCI6MjA4OTY5ODQ0MH0.ZlIu0_gKk1ljKUP_8_xxuzGj5uvRZk5eBdRXDC7iYWs';

/** The one and only Supabase client — anon key, RLS enforced for everything. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
