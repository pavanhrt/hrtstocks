import AnalysisCandidatePage from "../AnalysisCandidatePage";

export default async function BullishAnalysisPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Number((await searchParams).page) || 1);
  return <AnalysisCandidatePage hypothesis="bullish" requestedPage={page} />;
}
