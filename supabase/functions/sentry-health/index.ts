// Sentry health summary for the admin dashboard.
//
// The admin dashboard is a static GitHub Pages bundle with only the public anon
// key — it cannot hold a Sentry auth token. This edge function holds the token
// server-side, gates the caller on admin status via public.is_admin(), and
// returns ONLY sanitized numbers/strings (no permalinks, no event bodies, no
// stack frames, no PII).
//
// Failure modes (the dashboard must keep rendering — never crash on us):
//   - Missing config         → 200 { ok: false, configured: false }
//   - Not authed / not admin → 403 { ok: false, error: 'forbidden' }
//   - Sentry unreachable     → 200 { ok: false, configured: true,
//                                    error: 'sentry_unreachable' }
//   - Happy path             → 200 { ok: true, configured: true, ... }
//
// REGION: this Sentry org is in the EU. The API base MUST be
// https://de.sentry.io/api/0 — the global sentry.io host returns 404 for
// EU-region projects.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  // Origin "*" is fine because the real access control is the JWT + is_admin()
  // check below — an attacker with no admin JWT gets a 403, regardless of where
  // they call from.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SENTRY_API_BASE = "https://de.sentry.io/api/0";

interface SanitizedIssue {
  title: string;
  culprit: string;
  level: string;
  count: number;
  userCount: number;
}

interface SuccessResponse {
  ok: true;
  configured: true;
  project: { slug: string; status: string };
  errors24h: number;
  /** True when `errors24h` came from the issue-count fallback (top 5
   *  unresolved) rather than stats_v2 — i.e. stats_v2 was unreachable,
   *  returned an unparseable shape, or we never had a numeric project id
   *  to query it with. The client surfaces this with a leading "≈" and a
   *  small "approx" note so the number reads as a conservative lower
   *  bound, not the true count. */
  errors24hApprox: boolean;
  lastEventAt: string | null;
  topIssues: SanitizedIssue[];
}

type ConfigErrorResponse = { ok: false; configured: false };
type SentryDownResponse = { ok: false; configured: true; error: "sentry_unreachable" };
type ForbiddenResponse = { ok: false; error: "forbidden" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Admin gating ─────────────────────────────────────────────────────
  // Use the CALLER's JWT (not the service-role key) so RLS + is_admin()
  // evaluate against them. A missing/invalid Authorization header, an
  // expired token, or a non-admin user all collapse to the same 403 so
  // we don't leak whether the token was valid.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "forbidden" } satisfies ForbiddenResponse, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("[sentry-health] missing SUPABASE_URL or SUPABASE_ANON_KEY");
    // This is our config error, not the caller's — but exposing it as 500
    // would leak deployment state. Mirror coach-recap's behavior: treat as
    // a server error to ourselves.
    return json({ error: "Configuration error" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return json({ ok: false, error: "forbidden" } satisfies ForbiddenResponse, 403);
  }
  const { data: isAdminData, error: rpcErr } = await supabase.rpc("is_admin");
  if (rpcErr || isAdminData !== true) {
    return json({ ok: false, error: "forbidden" } satisfies ForbiddenResponse, 403);
  }

  // ── Sentry config check ──────────────────────────────────────────────
  // Missing config → fail OPEN (200, configured:false). The dashboard
  // renders a "not configured" card instead of a crash. This mirrors
  // coach-recap's fail-open posture on missing keys.
  const token = Deno.env.get("SENTRY_AUTH_TOKEN");
  const org = Deno.env.get("SENTRY_ORG");
  const project = Deno.env.get("SENTRY_PROJECT");
  if (!token || !org || !project) {
    return json({ ok: false, configured: false } satisfies ConfigErrorResponse, 200);
  }

  // ── Sentry calls ─────────────────────────────────────────────────────
  try {
    const sentryHeaders = { Authorization: `Bearer ${token}` };

    // 1. Project resolve — confirms token + project slug are valid before
    //    we ask for stats. A 404 here means the slug or token is wrong;
    //    we surface that as 'sentry_unreachable' rather than crashing.
    const projRes = await fetch(`${SENTRY_API_BASE}/projects/${org}/${project}/`, {
      headers: sentryHeaders,
    });
    if (!projRes.ok) {
      console.error(`[sentry-health] project resolve failed: ${projRes.status}`);
      return json(
        { ok: false, configured: true, error: "sentry_unreachable" } satisfies SentryDownResponse,
        200,
      );
    }
    const projData = await projRes.json();
    const projectSlug: string = typeof projData?.slug === "string" ? projData.slug : project;
    const projectStatus: string = typeof projData?.status === "string" ? projData.status : "unknown";
    // Sentry returns the numeric id as a string ("12345"). stats_v2 wants it
    // in the `project` param — slug doesn't work there, only the numeric id.
    const projectId: string =
      typeof projData?.id === "string"
        ? projData.id
        : typeof projData?.id === "number"
          ? String(projData.id)
          : "";

    // 2. Top 5 unresolved issues in the last 24h. We pull only the four
    //    sanitized fields we render — title, culprit, level, count,
    //    userCount — and drop everything else (permalinks, event payloads,
    //    stack frames, user identifiers). Fetched BEFORE stats_v2 so a
    //    stats_v2 failure can fall back to the sum of these issue counts
    //    (the fallback is a conservative lower bound — only the top 5 — but
    //    it's strictly better than fabricated zero).
    let topIssues: SanitizedIssue[] = [];
    let lastEventAt: string | null = null;
    const issuesUrl =
      `${SENTRY_API_BASE}/projects/${org}/${project}/issues/` +
      `?query=${encodeURIComponent("is:unresolved")}&statsPeriod=24h&limit=5`;
    try {
      const issuesRes = await fetch(issuesUrl, { headers: sentryHeaders });
      if (issuesRes.ok) {
        const issues = (await issuesRes.json()) as unknown;
        if (Array.isArray(issues)) {
          for (const i of issues) {
            const issue = i as Record<string, unknown>;
            const title = typeof issue.title === "string" ? issue.title.slice(0, 200) : "";
            const culprit = typeof issue.culprit === "string" ? issue.culprit.slice(0, 200) : "";
            const level = typeof issue.level === "string" ? issue.level.slice(0, 16) : "unknown";
            // Sentry returns count/userCount as strings; coerce safely.
            const count = toFiniteInt(issue.count);
            const userCount = toFiniteInt(issue.userCount);
            const seen = typeof issue.lastSeen === "string" ? issue.lastSeen : null;
            if (seen && (!lastEventAt || seen > lastEventAt)) lastEventAt = seen;
            if (title) topIssues.push({ title, culprit, level, count, userCount });
          }
        }
      } else {
        console.warn(`[sentry-health] issues fetch ${issuesRes.status} (continuing)`);
      }
    } catch (e) {
      console.warn("[sentry-health] issues fetch threw (continuing)", e);
    }

    // 3. Error volume last 24h via the ORG stats_v2 endpoint, filtered to
    //    category=error so transactions (tracesSampleRate=0.1) and other
    //    non-error event types don't inflate the count. The legacy
    //    /projects/{org}/{project}/stats/?stat=received endpoint counts
    //    ALL events and gives a misleading "errors" number.
    //
    //    Response shape:
    //      { groups: [{ totals: { "sum(quantity)": N },
    //                   series: { "sum(quantity)": [n1, n2, ...] } }] }
    //    We sum the series (per spec) — equal to totals.sum(quantity) when
    //    Sentry returns both, but summing the series is robust if totals
    //    are missing.
    //
    //    Fallback: if stats_v2 fails (5xx, schema drift, missing numeric id),
    //    fall back to summing topIssues[].count. That's a conservative lower
    //    bound — only the top 5 unresolved — but it's an honest number we
    //    can defend rather than a fabricated 0.
    let errors24h = 0;
    let usedFallback = false;
    if (projectId) {
      const statsV2Url =
        `${SENTRY_API_BASE}/organizations/${org}/stats_v2/` +
        `?field=${encodeURIComponent("sum(quantity)")}` +
        `&category=error&statsPeriod=24h&project=${encodeURIComponent(projectId)}`;
      try {
        const statsRes = await fetch(statsV2Url, { headers: sentryHeaders });
        if (statsRes.ok) {
          const payload = (await statsRes.json()) as unknown;
          const series = readStatsV2Series(payload);
          if (series) {
            for (const v of series) {
              if (typeof v === "number" && Number.isFinite(v)) errors24h += v;
            }
          } else {
            // 200 but no recognizable groups[0].series — treat as failure
            // so we fall back rather than reporting a hidden 0.
            usedFallback = true;
            console.warn("[sentry-health] stats_v2 returned no series (falling back to issue counts)");
          }
        } else {
          usedFallback = true;
          console.warn(`[sentry-health] stats_v2 fetch ${statsRes.status} (falling back to issue counts)`);
        }
      } catch (e) {
        usedFallback = true;
        console.warn("[sentry-health] stats_v2 fetch threw (falling back to issue counts)", e);
      }
    } else {
      // No numeric project id from the detail call → we can't query
      // stats_v2 at all (slug isn't accepted there). Fall back immediately.
      usedFallback = true;
      console.warn("[sentry-health] project detail missing numeric id; using issue-count fallback");
    }
    if (usedFallback) {
      errors24h = topIssues.reduce((a, i) => a + (Number.isFinite(i.count) ? i.count : 0), 0);
    }

    const body: SuccessResponse = {
      ok: true,
      configured: true,
      project: { slug: projectSlug, status: projectStatus },
      errors24h,
      errors24hApprox: usedFallback,
      lastEventAt,
      topIssues,
    };
    return json(body, 200);
  } catch (e) {
    // Any unexpected throw inside the Sentry block → surface as
    // 'sentry_unreachable' so the UI shows a clear amber state.
    console.error("[sentry-health] sentry block threw:", e);
    return json(
      { ok: false, configured: true, error: "sentry_unreachable" } satisfies SentryDownResponse,
      200,
    );
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toFiniteInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  return 0;
}

/** Pull groups[0].series["sum(quantity)"] out of a stats_v2 response, with
 *  defensive type-narrowing. Returns null when the shape doesn't match — the
 *  caller treats that as a stats_v2 failure and falls back. */
function readStatsV2Series(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") return null;
  const groups = (payload as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const first = groups[0];
  if (!first || typeof first !== "object") return null;
  const series = (first as { series?: unknown }).series;
  if (!series || typeof series !== "object") return null;
  const arr = (series as Record<string, unknown>)["sum(quantity)"];
  return Array.isArray(arr) ? (arr as number[]) : null;
}
