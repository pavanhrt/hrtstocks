import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getSwingAnalysisPage, type AnalysisHypothesis, type SwingCandidate } from "@/lib/data/swing-analysis";
import { formatTimestamp, getPublishedRunMetadata } from "@/lib/data/run-metadata";
import { Badge } from "../Badge";
import ChartPreview from "../ChartPreview";

const GATE_LABELS: Record<string, string> = {
  "WBP-M1": "M1 Weekly Dow", "WBP-M2": "M2 Weekly Elliott", "WBP-M3": "M3 Daily Dow", "WBP-M4": "M4 Daily wave + Tide",
  "WBP-M5": "M5 Hourly Elliott setup", "WBP-M6": "M6 PAPA trigger", "WBP-M7": "M7 SMM Bull Hat", "WBP-M8": "M8 Reward ÷ Risk",
  "WSP-S1": "S1 Weekly Dow", "WSP-S2": "S2 Weekly Elliott", "WSP-S3": "S3 Daily Dow", "WSP-S4": "S4 Daily wave + Tide",
  "WSP-S5": "S5 Hourly Elliott setup", "WSP-S6": "S6 PAPA trigger", "WSP-S7": "S7 SMM Bear Hat", "WSP-S8": "S8 Reward ÷ Risk",
};

function Evidence({ value }: { value: Record<string, unknown> | null }) {
  return value && Object.keys(value).length > 0 ? <code className="evidence-value">{JSON.stringify(value)}</code> : <span>Not recorded</span>;
}

function ConditionsTable({ candidate, hypothesis }: { candidate: SwingCandidate; hypothesis: AnalysisHypothesis }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label={`${hypothesis} canonical decision rules; scroll horizontally for all columns`}>
      <table className="decision-table">
        <caption className="sr-only">Canonical {hypothesis === "bullish" ? "M1–M8 BUY" : "S1–S8 SELL"} decision table for {candidate.symbol}</caption>
        <thead><tr><th>Rule</th><th>Required condition</th><th>Observed value</th><th>Status</th><th>Explanation</th><th>Source locator</th><th>Evidence time</th><th>Data quality</th></tr></thead>
        <tbody>
          {candidate.conditions.map((condition) => (
            <tr key={condition.ruleId}>
              <th scope="row">{GATE_LABELS[condition.ruleId] ?? condition.ruleId}</th>
              <td className="wrap-cell">{condition.requiredCondition}</td>
              <td className="wrap-cell"><Evidence value={condition.observedValues} /></td>
              <td><Badge status={condition.result} /></td>
              <td className="wrap-cell">{condition.explanation ?? "Not recorded"}</td>
              <td className="wrap-cell">{condition.sourceLocator ?? "Not recorded"}</td>
              <td className="wrap-cell">{formatTimestamp(condition.evidenceTimestamp)}</td>
              <td><Badge status={condition.dataQuality} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Candidate({ candidate, hypothesis }: { candidate: SwingCandidate; hypothesis: AnalysisHypothesis }) {
  const lockLabel = `${candidate.automatedGatesPassed}/${candidate.automatedGatesTotal} higher-timeframe gates`;
  return (
    <details className="candidate-card">
      <summary>
        <span><Link href={`/stocks/${candidate.instrumentId}`}>{candidate.name}</Link> <small>({candidate.symbol})</small></span>
        <span>{lockLabel}</span>
        <Badge status={candidate.finalAction} />
      </summary>
      <div className="candidate-body">
        <div className="analysis-chart-grid">
          <div><h3>Daily evidence</h3><ChartPreview src={candidate.dailyChartUrl} alt={`${candidate.symbol} daily analysis chart`} /></div>
          <div>
            <h3>One-hour evidence</h3>
            {candidate.hourlyOpened ? (
              <>
                <ChartPreview src={candidate.hourlyChartUrl} alt={`${candidate.symbol} one-hour analysis chart`} />
                {!candidate.hourlyChartUrl && <p className="supporting-text">Hourly analysis opened; no immutable chart was published.</p>}
              </>
            ) : (
              <p className="locked-message"><strong>Hourly analysis not opened.</strong> The higher-timeframe lock did not pass. See failed conditions and flip levels below.</p>
            )}
          </div>
        </div>
        <ConditionsTable candidate={candidate} hypothesis={hypothesis} />
        {candidate.pendingConditions.length > 0 && (
          <div><h3>Blocking conditions and flip levels</h3><ul>{candidate.pendingConditions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
        )}
        {candidate.routeEvidence != null && <details className="methodology"><summary>Structured hourly route evidence</summary><pre>{JSON.stringify(candidate.routeEvidence, null, 2)}</pre></details>}
      </div>
    </details>
  );
}

function PageLink({ hypothesis, page, disabled, children }: { hypothesis: AnalysisHypothesis; page: number; disabled: boolean; children: React.ReactNode }) {
  return disabled ? <span className="disabled-link">{children}</span> : <Link href={`/analysis/${hypothesis}?page=${page}`}>{children}</Link>;
}

export default async function AnalysisCandidatePage({ hypothesis, requestedPage }: { hypothesis: AnalysisHypothesis; requestedPage: number }) {
  const run = await getLatestPublishedRun();
  const title = hypothesis === "bullish" ? "Bullish analysis" : "Bearish analysis";
  if (!run) return <div className="card"><h1>{title}</h1><p>No published screening run is available.</p></div>;
  const [result, metadata] = await Promise.all([
    getSwingAnalysisPage(run.id, hypothesis, requestedPage),
    Promise.resolve(getPublishedRunMetadata(run as unknown as Parameters<typeof getPublishedRunMetadata>[0])),
  ]);
  return (
    <div className="page-grid">
      <section className="card">
        <Link href="/analysis">← Analysis overview</Link>
        <h1>{title}</h1>
        <p className="supporting-text">Run {run.run_date} · cutoff {formatTimestamp(metadata.cutoff)} · {result.totalCount} aligned equities · page {result.page} of {result.pageCount}</p>
        <p>Only <strong>{hypothesis === "bullish" ? "Aligned Bullish" : "Aligned Bearish"}</strong> equities from this exact Direction snapshot appear here. Benchmarks, mixed and unavailable instruments are excluded.</p>
      </section>
      <section className="candidate-list" aria-label={`${title} candidates`}>
        {result.rows.length === 0 ? <div className="card"><p>No qualifying aligned equities in this published run.</p></div> : result.rows.map((candidate) => <Candidate key={candidate.instrumentId} candidate={candidate} hypothesis={hypothesis} />)}
      </section>
      {result.pageCount > 1 && <nav className="pagination" aria-label={`${title} pages`}><PageLink hypothesis={hypothesis} page={result.page - 1} disabled={result.page <= 1}>← Previous</PageLink><span>Page {result.page} of {result.pageCount}</span><PageLink hypothesis={hypothesis} page={result.page + 1} disabled={result.page >= result.pageCount}>Next →</PageLink></nav>}
    </div>
  );
}
