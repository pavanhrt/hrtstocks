// TypeScript port of supabase/functions/run-screening/pipeline/group-issues.js
// for the Data Health page -- kept as a small, independent copy rather than
// an import across the Next.js app / Deno Edge Function boundary (different
// module systems, different project roots). Same grouping behavior: groups
// repeated Data Health rows by cause instead of rendering one row per event,
// since a systemic issue (e.g. every time-budget-skipped instrument, or
// every instrument hitting the same provider error) could otherwise produce
// hundreds of near-identical rows.

export type DataQualityIssueGroup = {
  check_name: string;
  result: string;
  count: number;
  sample_instrument_ids: string[];
  first_seen: string;
  last_seen: string;
};

export function groupDataQualityIssues(
  rows: { check_name: string; result: string; instrument_id: string | null; created_at: string }[],
  sampleLimit = 5
): DataQualityIssueGroup[] {
  const groups = new Map<string, DataQualityIssueGroup>();
  for (const r of rows) {
    const key = `${r.check_name}::${r.result}`;
    let g = groups.get(key);
    if (!g) {
      g = { check_name: r.check_name, result: r.result, count: 0, sample_instrument_ids: [], first_seen: r.created_at, last_seen: r.created_at };
      groups.set(key, g);
    }
    g.count++;
    if (r.instrument_id && g.sample_instrument_ids.length < sampleLimit && !g.sample_instrument_ids.includes(r.instrument_id)) {
      g.sample_instrument_ids.push(r.instrument_id);
    }
    if (r.created_at < g.first_seen) g.first_seen = r.created_at;
    if (r.created_at > g.last_seen) g.last_seen = r.created_at;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export type AuditLogGroup = {
  stage: string;
  status: string;
  count: number;
  sample_messages: string[];
  first_seen: string;
  last_seen: string;
};

export function groupAuditLog(
  rows: { stage: string; status: string; message: string | null; created_at: string }[],
  sampleLimit = 3
): AuditLogGroup[] {
  const groups = new Map<string, AuditLogGroup>();
  for (const r of rows) {
    const key = `${r.stage}::${r.status}`;
    let g = groups.get(key);
    if (!g) {
      g = { stage: r.stage, status: r.status, count: 0, sample_messages: [], first_seen: r.created_at, last_seen: r.created_at };
      groups.set(key, g);
    }
    g.count++;
    if (r.message && g.sample_messages.length < sampleLimit && !g.sample_messages.includes(r.message)) {
      g.sample_messages.push(r.message);
    }
    if (r.created_at < g.first_seen) g.first_seen = r.created_at;
    if (r.created_at > g.last_seen) g.last_seen = r.created_at;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
