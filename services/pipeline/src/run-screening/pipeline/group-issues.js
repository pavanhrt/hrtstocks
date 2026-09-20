import { redactSecrets } from "../../security/redact.js";
// Groups repeated Data Health rows by cause instead of rendering one row per
// event -- a systemic issue (e.g. every time-budget-skipped instrument, or
// every instrument hitting the same provider error) previously produced
// hundreds of near-identical rows. Pure JS aggregation, no DB-side view --
// the row counts here (hundreds, not millions) don't justify the extra
// migration/RLS surface a view would need.

/**
 * @param {{check_name: string, result: string, instrument_id: string|null, created_at: string}[]} rows
 * @param {number} sampleLimit - max instrument ids to keep per group, for display
 * @returns {{check_name: string, result: string, count: number, sample_instrument_ids: string[], first_seen: string, last_seen: string}[]}
 *   sorted by count descending (the most common cause first)
 */
export function groupDataQualityIssues(rows, sampleLimit = 5) {
  const groups = new Map();
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

/**
 * @param {{stage: string, status: string, message: string|null, created_at: string}[]} rows
 * @returns {{stage: string, status: string, count: number, sample_messages: string[], first_seen: string, last_seen: string}[]}
 */
export function groupAuditLog(rows, sampleLimit = 3) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.stage}::${r.status}`;
    let g = groups.get(key);
    if (!g) {
      g = { stage: r.stage, status: r.status, count: 0, sample_messages: [], first_seen: r.created_at, last_seen: r.created_at };
      groups.set(key, g);
    }
    g.count++;
    const sample = redactSecrets(r.message); // rows written before redaction existed are cleaned on the way out too
    if (sample && g.sample_messages.length < sampleLimit && !g.sample_messages.includes(sample)) {
      g.sample_messages.push(sample);
    }
    if (r.created_at < g.first_seen) g.first_seen = r.created_at;
    if (r.created_at > g.last_seen) g.last_seen = r.created_at;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
