// ─────────────────────────────────────────────────────────────────────────────
// SAMPLE / ILLUSTRATIVE infrastructure data.
//
// A static GitHub Pages client has no privileged channel to real uptime pings or
// server log streams, so the System Health view cannot show live telemetry.
// Everything in this file is fabricated sample data, and every surface that
// renders it is labeled "Sample / Illustrative" so it is never mistaken for a
// live signal. Wire this to a real status endpoint (e.g. a Supabase Edge
// Function or an external status page) to make it real.
// ─────────────────────────────────────────────────────────────────────────────

export interface ServicePing {
  name: string;
  status: 'operational' | 'degraded' | 'down';
  latency_ms: number;
  last_checked: string;
}

// NOTE: Sentry intentionally removed from this list. Sentry health is real
// data sourced from the `sentry-health` edge function — see SystemHealthPage.
// Adding a fabricated "Sentry" ping back here would mix real and sample data
// in the same grid and undermine the page's accuracy banner.
export const SAMPLE_INFRASTRUCTURE_PINGS: ServicePing[] = [
  { name: 'Supabase Auth', status: 'operational', latency_ms: 42, last_checked: new Date().toISOString() },
  { name: 'Database', status: 'operational', latency_ms: 18, last_checked: new Date().toISOString() },
  { name: 'RevenueCat Webhooks', status: 'operational', latency_ms: 87, last_checked: new Date().toISOString() },
  { name: 'Ollama Environment', status: 'operational', latency_ms: 124, last_checked: new Date().toISOString() },
  { name: 'Edge Functions', status: 'operational', latency_ms: 56, last_checked: new Date().toISOString() },
];
