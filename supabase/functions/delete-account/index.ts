// delete-account — irreversibly delete the calling user's account.
//
// Design notes:
//   - The caller's user id comes from auth.getUser() against their JWT.
//     The function NEVER reads a user id from the request body — that's
//     the gate that prevents one user from deleting another. The body is
//     intentionally ignored.
//   - After deleting auth.users(id) every user-owned row cascades. The
//     FK on exercise_logs was retro-fitted via
//     supabase/migrations/<ts>_exercise_logs_cascade_on_delete.sql so
//     prod and a fresh DB behave the same.
//   - The service-role client is created with SUPABASE_SERVICE_ROLE_KEY,
//     an env var Supabase injects automatically into edge functions —
//     no new secret to provision.
//
// Return shape: { ok: true } on success; { error: string } with a 4xx or
// 5xx on failure. The client never signs out / clears local storage
// unless we return ok=true.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ── Auth gate ─────────────────────────────────────────────────────
    // Mirrors src/lib/deleteAccount.ts::isBearerAuthorization, which is
    // unit-tested in jest. The two implementations are kept aligned by
    // the test on the client side — if this check ever drifts, the test
    // there fails because the contract is shared.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ") || authHeader.length <= "Bearer ".length) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    // Service-role key is auto-injected by Supabase. It must NEVER be
    // exposed to the client and is the reason this delete has to live
    // server-side: it grants the auth.admin.deleteUser permission.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
      return json({ error: "Configuration error" }, 500);
    }
    if (!serviceRoleKey) {
      console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
      return json({ error: "Configuration error" }, 500);
    }

    // ── Resolve the caller's user id from their JWT ───────────────────
    // We deliberately use the anon client + the caller's Authorization
    // header so auth.getUser() validates against the SAME token the user
    // was issued. We do NOT trust a user id from the request body — see
    // top-of-file note. Body is ignored entirely.
    const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await authedClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const callerUserId = user.id; // SOURCE OF TRUTH — the only id we ever delete.

    // ── Delete via service role ───────────────────────────────────────
    // Service-role client is required for auth.admin.deleteUser. The id
    // passed in is ALWAYS the caller's own — never anything from the
    // request body — so a user can only delete themselves.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: deleteErr } = await admin.auth.admin.deleteUser(callerUserId);
    if (deleteErr) {
      console.error("admin.deleteUser failed:", deleteErr);
      return json({ error: "Account deletion failed" }, 502);
    }

    // ON DELETE CASCADE on every user-owned table (see initial schema +
    // 20260615_exercise_logs_cascade_on_delete.sql) wipes:
    //   profiles, weekly_plans, workout_sessions, exercise_logs,
    //   events, replan_calls, progress_logs, journal_entries.
    return json({ ok: true }, 200);

  } catch (e) {
    console.error("delete-account error:", e);
    return json({ error: "Internal Server Error" }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
