import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getAnalysisCounts } from "@/lib/data/swing-analysis";
import { formatTimestamp, getPublishedRunMetadata } from "@/lib/data/run-metadata";

export default async function AnalysisPage() {
  const run = await getLatestPublishedRun();
  if (!run) {
    return <div className="card"><h1>Analysis</h1><p className="supporting-text">No published screening run is available.</p></div>;
  }
  const [counts, metadata] = await Promise.all([
    getAnalysisCounts(run.id),
    Promise.resolve(getPublishedRunMetadata(run as unknown as Parameters<typeof getPublishedRunMetadata>[0])),
  ]);

  return (
    <div className="page-grid">
      <section className="card">
        <h1>Analysis</h1>
        <p className="supporting-text">Published run {run.run_date} · cutoff {formatTimestamp(metadata.cutoff)}</p>
        <p>
          Candidate membership comes only from this run&apos;s persisted Direction alignment. Mixed, sideways,
          manual-review, unavailable and benchmark instruments cannot enter the BUY or SELL lists.
        </p>
      </section>
      <div className="analysis-route-grid">
        <Link className="card analysis-route-card" href="/analysis/bullish">
          <span className="eyebrow">Aligned bullish</span>
          <strong>{counts.bullish}</strong>
          <span>Open BUY analysis →</span>
        </Link>
        <Link className="card analysis-route-card" href="/analysis/bearish">
          <span className="eyebrow">Aligned bearish</span>
          <strong>{counts.bearish}</strong>
          <span>Open SELL analysis →</span>
        </Link>
      </div>
      <section className="card methodology">
        <details>
          <summary>Methodology and higher-timeframe lock</summary>
          <p>
            M1–M4 or S1–S4 must all pass before one-hour data is opened. Hourly evidence can refine an aligned
            setup but cannot reverse Weekly and Daily direction. BUY or SELL requires all applicable mandatory
            gates; otherwise the stored action remains WAIT or UNAVAILABLE.
          </p>
        </details>
      </section>
    </div>
  );
}
