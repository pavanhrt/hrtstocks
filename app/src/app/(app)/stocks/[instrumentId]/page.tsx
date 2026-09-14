import { notFound } from "next/navigation";
import Link from "next/link";
import { getLatestPublishedRun, getRuleTracePage, getInstrument, getRuleDefinitionsByIds } from "@/lib/data/runs";
import { getDirectionForInstrument } from "@/lib/data/direction";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "../../Badge";
import ChartPreview from "../../ChartPreview";
import { formatTimestamp, getPublishedRunMetadata } from "@/lib/data/run-metadata";

const TIMEFRAME_LABEL = { monthly: "Monthly", weekly: "Weekly", daily: "Daily" } as const;

export default async function StockDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<{ tracePage?: string }>;
}) {
  const { instrumentId } = await params;
  const requestedTracePage = Math.max(1, Number((await searchParams).tracePage) || 1);

  const [instrument, run] = await Promise.all([getInstrument(instrumentId), getLatestPublishedRun()]);
  if (!instrument) notFound();
  const instrumentSymbol = instrument.symbol;

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{instrument.name ?? instrument.symbol}</h1>
        <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
      </div>
    );
  }
  const runMetadata = getPublishedRunMetadata(run as unknown as Parameters<typeof getPublishedRunMetadata>[0]);

  const supabase = await createClient();
  const [tracePage, { data: result }] = await Promise.all([
    getRuleTracePage(run.id, instrumentId, requestedTracePage),
    supabase
      .from("instrument_run_results")
      .select("*")
      .eq("run_id", run.id)
      .eq("instrument_id", instrumentId)
      .maybeSingle(),
  ]);
  const traces = tracePage.rows;

  const definitions = await getRuleDefinitionsByIds(traces.map((t) => t.rule_id));
  const direction = await getDirectionForInstrument(instrumentId);

  const bullish = traces.filter((t) => definitions[t.rule_id]?.direction === "bullish");
  const bearish = traces.filter((t) => definitions[t.rule_id]?.direction === "bearish");
  const neutral = traces.filter((t) => {
    const d = definitions[t.rule_id]?.direction;
    return !d || d === "both" || d === "not applicable";
  });

  function TraceTable({ rows }: { rows: typeof traces }) {
    if (rows.length === 0) return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No rules in this group.</p>;
    return (
      <div className="table-scroll" tabIndex={0} aria-label="Rule evidence; scroll horizontally for all columns">
        <table>
          <caption className="sr-only">Rule evidence for {instrumentSymbol}</caption>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Framework</th>
              <th>Result</th>
              <th>Observed</th>
              <th>Threshold</th>
              <th>Source</th>
              <th>Explanation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const def = definitions[t.rule_id];
              return (
                <tr key={t.id}>
                  <th scope="row" className="wrap-cell">
                    {t.rule_id}
                    {def?.hard_gate && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--watch)" }} title="Hard gate">
                        GATE
                      </span>
                    )}
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{def?.name}</div>
                  </th>
                  <td>{t.rule_id.split("-")[0]}</td>
                  <td>
                    <Badge status={t.result} />
                  </td>
                  <td className="wrap-cell">
                    {t.observed_values ? <code className="evidence-value">{JSON.stringify(t.observed_values)}</code> : "-"}
                  </td>
                  <td className="wrap-cell">
                    {t.thresholds ? <code className="evidence-value">{JSON.stringify(t.thresholds)}</code> : "-"}
                  </td>
                  <td className="wrap-cell supporting-text">
                    {t.source_document ?? "-"}
                    {t.source_locator ? ` (${t.source_locator})` : ""}
                    <div>{def?.source_status}</div>
                  </td>
                  <td className="wrap-cell">{t.explanation ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="page-grid">
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>
          {instrument.name ?? instrument.symbol} <span style={{ color: "var(--text-dim)", fontSize: 14 }}>({instrument.symbol})</span>
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Published run {run.run_date} &middot; cutoff {formatTimestamp(runMetadata.cutoff)} &middot; {instrument.exchange}
          {instrument.is_index ? " · Index" : ""}
        </p>
        {result && (
          <div className="result-summary-grid">
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Result</div>
              <Badge status={result.terminal_state} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Tier</div>
              <div>{result.tier ?? "-"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Direction</div>
              <div>{result.direction ?? "-"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Score</div>
              <div>{result.score ?? "-"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Data quality</div>
              <div>{result.data_quality ?? "-"}</div>
            </div>
          </div>
        )}
        {result && result.failed_gates?.length > 0 && (
          <p className="failed-gates">
            Failed hard gates: {result.failed_gates.join(", ")}
          </p>
        )}
      </div>

      {direction && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 15 }}>
            Direction <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-dim)" }}>({direction.finalAlignment.replace(/_/g, " ").toLowerCase()})</span>{" "}
            <Link href="/direction" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>See all stocks →</Link>
          </h2>
          <div className="stock-chart-grid">
            {(["monthly", "weekly", "daily"] as const).map((tf) => {
              const row = direction.timeframes[tf];
              const url = direction.chartUrls[tf];
              return (
                <div key={tf} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>{TIMEFRAME_LABEL[tf]}</div>
                  <ChartPreview src={url} alt={`${instrument.symbol} ${tf} direction chart`} />
                  <div style={{ fontSize: 12 }}>{row?.dow_state?.replace(/_/g, " ") ?? "Unavailable"}</div>
                  <div style={{ fontSize: 11, color: row?.wave?.confidence === "confirmed" ? "var(--pass)" : "var(--text-dim)" }}>
                    {row?.wave ? `${row.wave.structureType} · wave ${row.wave.currentWave} (${row.wave.confidence})` : "Wave: unconfirmed"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <p className="supporting-text">Rule traces {tracePage.totalCount === 0 ? "0" : `${(tracePage.page - 1) * tracePage.pageSize + 1}–${Math.min(tracePage.page * tracePage.pageSize, tracePage.totalCount)}`} of {tracePage.totalCount}</p>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bullish hypothesis</h2>
        <TraceTable rows={bullish} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bearish hypothesis</h2>
        <TraceTable rows={bearish} />
      </div>

      {tracePage.pageCount > 1 && (
        <nav className="pagination" aria-label="Rule trace pages">
          {tracePage.page > 1 ? <Link href={`/stocks/${instrumentId}?tracePage=${tracePage.page - 1}`}>← Previous traces</Link> : <span className="disabled-link">← Previous traces</span>}
          <span>Page {tracePage.page} of {tracePage.pageCount}</span>
          {tracePage.page < tracePage.pageCount ? <Link href={`/stocks/${instrumentId}?tracePage=${tracePage.page + 1}`}>Next traces →</Link> : <span className="disabled-link">Next traces →</span>}
        </nav>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Risk, data, and other rules</h2>
        <TraceTable rows={neutral} />
      </div>
    </div>
  );
}
