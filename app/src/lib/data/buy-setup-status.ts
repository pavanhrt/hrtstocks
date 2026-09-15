// Pure derivation of the /buy-setup-analysis page's "overall research
// status" from already-persisted evidence -- kept in its own file (no
// supabase import) so it can be unit-tested without a Next.js request
// context, matching this codebase's convention of separating pure
// derivation logic (e.g. analysis-membership.ts) from data-fetching modules.
// This is presentation-status labeling only, never a recalculation of any
// authoritative pass/fail/technical condition -- those all come from
// supabase/functions/analyze-buy-setup and run-screening.
export function overallStatusFor(gate: string, qualified: boolean, fifteenMinDataQuality: string | null): string {
  if (gate === "NO_DATA") return "NO_DATA";
  if (gate === "FAIL") return "FAIL";
  if (gate !== "PASS") return "MANUAL_REVIEW";
  if (!qualified) return "MANUAL_REVIEW";
  if (fifteenMinDataQuality === "NO_DATA" || fifteenMinDataQuality == null) return "NO_DATA";
  return "TECHNICAL_EVIDENCE_PRESENT";
}
