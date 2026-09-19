// Pure constants/types shared between the server-only data module
// (direction.ts, which imports the database layer and next/headers)
// and client components (DirectionControls.tsx) -- kept in their own file
// with no server-only imports so a "use client" component can import just
// these without pulling next/headers into the client bundle.
export const FINAL_ALIGNMENT_VALUES = [
  "ALIGNED_BULLISH",
  "ALIGNED_BEARISH",
  "SIDEWAYS",
  "MIXED",
  "MANUAL_REVIEW",
  "UNAVAILABLE",
] as const;
export type FinalAlignment = (typeof FINAL_ALIGNMENT_VALUES)[number];

export function resolveDirectionAlignment({
  persisted,
  terminalState,
  tier,
  dataQuality,
}: {
  persisted?: FinalAlignment | null;
  terminalState: string;
  tier: string | null;
  dataQuality: string | null;
}): FinalAlignment {
  if (persisted) return persisted;
  return terminalState === "NO_DATA" || tier === "unavailable" || dataQuality === "NO_DATA"
    ? "UNAVAILABLE"
    : "MANUAL_REVIEW";
}
