import { notFound } from "next/navigation";
import Link from "next/link";
import { getInstrument } from "@/lib/data/runs";
import { getBuySetupInstrumentDetail } from "@/lib/data/buy-setup-analysis";
import { Badge } from "../../Badge";
import ChartPreview from "../../ChartPreview";

export default async function BuySetupInstrumentDetailPage({ params }: { params: Promise<{ instrumentId: string }> }) {
  const { instrumentId } = await params;
  const [instrument, detail] = await Promise.all([getInstrument(instrumentId), getBuySetupInstrumentDetail(instrumentId)]);
  if (!instrument) notFound();

  if (!detail || !detail.row) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{instrument.name ?? instrument.symbol}</h1>
        <p style={{ color: "var(--text-dim)" }}>No buy setup analysis evidence for this instrument in the current published run.</p>
        <Link href="/buy-setup-analysis">&larr; Back to Buy setup analysis</Link>
      </div>
    );
  }

  const { row, conditions, dailyChartUrl, fifteenMinChartUrl } = detail;

  return (
    <div className="page-grid">
      <div className="card">
        <Link href="/buy-setup-analysis" style={{ fontSize: 13 }}>
          &larr; Back to Buy setup analysis
        </Link>
        <h1 style={{ marginTop: 8, marginBottom: 4 }}>
          {instrument.name ?? instrument.symbol} <span style={{ color: "var(--text-dim)", fontSize: 16 }}>({instrument.symbol})</span>
        </h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>
            Three-timeframe gate: <Badge status={row.threeTimeframeGate} />
          </span>
          <span>
            Overall research status: <Badge status={row.overallStatus} />
          </span>
        </div>
        <p style={{ fontSize: 12, fontWeight: 600 }}>This is research evidence only -- not an order, a recommendation, or a guarantee of any outcome.</p>
      </div>

      {!row.qualified && (
        <div className="card">
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
            This instrument did not pass the three-timeframe bullish gate this run, so every 15-minute analysis
            column is <Badge status="NOT_APPLICABLE" /> rather than a failure -- see the condition table below for
            exactly which timeframe(s) did not qualify.
          </p>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Condition table</h2>
        <div className="table-scroll" tabIndex={0} aria-label="Rule-by-rule evidence for the three-timeframe gate">
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Stage</th>
                <th>Timeframe</th>
                <th>Required condition</th>
                <th>Observed value</th>
                <th>Result</th>
                <th>Explanation</th>
                <th>Rule version</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((c) => (
                <tr key={c.ruleId}>
                  <th scope="row">{c.ruleId}</th>
                  <td>{c.stage}</td>
                  <td>{c.timeframe}</td>
                  <td className="wrap-cell" style={{ fontSize: 12 }}>
                    {c.requiredCondition}
                  </td>
                  <td className="wrap-cell" style={{ fontSize: 11, fontFamily: "monospace" }}>
                    {c.observedValue}
                  </td>
                  <td>
                    <Badge status={c.result} />
                  </td>
                  <td className="wrap-cell" style={{ fontSize: 12 }}>
                    {c.explanation}
                  </td>
                  <td>{c.ruleVersion ?? "—"}</td>
                  <td style={{ fontSize: 11 }}>{c.sourceLocator ?? "strategies/buy-setup-analysis.yaml"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {row.qualified && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 15 }}>Charts</h2>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
            <div>
              <h3 style={{ fontSize: 13 }}>Daily</h3>
              <ChartPreview src={dailyChartUrl} alt={`${instrument.symbol} daily buy-setup chart`} />
            </div>
            <div>
              <h3 style={{ fontSize: 13 }}>15-minute</h3>
              <ChartPreview src={fifteenMinChartUrl} alt={`${instrument.symbol} 15-minute buy-setup chart`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
