export type AnalysisHypothesis = "bullish" | "bearish";

export function expectedAlignment(hypothesis: AnalysisHypothesis) {
  return hypothesis === "bullish" ? "ALIGNED_BULLISH" : "ALIGNED_BEARISH";
}

export function isAnalysisMember(
  row: { finalAlignment: string; isIndex: boolean },
  hypothesis: AnalysisHypothesis
) {
  return !row.isIndex && row.finalAlignment === expectedAlignment(hypothesis);
}
