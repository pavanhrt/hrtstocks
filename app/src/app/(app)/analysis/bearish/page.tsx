import AnalysisCandidatePage from "../AnalysisCandidatePage";

export default async function BearishAnalysisPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Number((await searchParams).page) || 1);
  return <AnalysisCandidatePage hypothesis="bearish" requestedPage={page} />;
}
