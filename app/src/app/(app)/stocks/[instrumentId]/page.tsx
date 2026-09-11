import { notFound } from "next/navigation";
import Link from "next/link";
import { getLatestPublishedRun, getRuleTraces, getInstrument, getRuleDefinitionsByIds } from "@/lib/data/runs";
import { getDirectionForInstrument } from "@/lib/data/direction";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "../../Badge";

const TIMEFRAME_LABEL = { monthly: "Monthly", weekly: "Weekly", daily: "Daily" } as const;

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ instrumentId: string }>;
}) {
  const { instrumentId } = await params;

  const [instrument, run] = await Promise.all([getInstrument(instrumentId), getLatestPublishedRun()]);
  if (!instrument) notFound();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{instrument.name ?? instrument.symbol}</h1>
        <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
      </div>
    );
  }

  const supabase = await createClient();
  const [traces, { data: result }] = await Promise.all([
    getRuleTraces(run.id, instrumentId),
    supabase
      .from("instrument_run_results")
      .select("*")
      .eq("run_id", run.id)
      .eq("instrument_id", instrumentId)
      .maybeSingle(),
  ]);

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
      <div style={{ overflowX: "auto" }}>
        <table>
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
                  <td>
                    {t.rule_id}
                    {def?.hard_gate && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--watch)" }} title="Hard gate">
                        GATE
                      </span>
                    )}
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{def?.name}</div>
                  </td>
                  <td>{t.rule_id.split("-")[0]}</td>
                  <td>
                    <Badge status={t.result} />
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {t.observed_values ? JSON.stringify(t.observed_values) : "-"}
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {t.thresholds ? JSON.stringify(t.thresholds) : "-"}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {t.source_document ?? "-"}
                    {t.source_locator ? ` (${t.source_locator})` : ""}
                    <div>{def?.source_status}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>{t.explanation ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>
          {instrument.name ?? instrument.symbol} <span style={{ color: "var(--text-dim)", fontSize: 14 }}>({instrument.symbol})</span>
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Run {run.run_date} &middot; {instrument.exchange}
          {instrument.is_index ? " · Index" : ""}
        </p>
        {result && (
          <div style={{ display: "flex", gap: 24, marginTop: 8 }}>
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
          <p style={{ color: "var(--fail)", fontSize: 13, marginTop: 8 }}>
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
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {(["monthly", "weekly", "daily"] as const).map((tf) => {
              const row = direction.timeframes[tf];
              const url = direction.chartUrls[tf];
              return (
                <div key={tf} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>{TIMEFRAME_LABEL[tf]}</div>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt={`${instrument.symbol} ${tf} chart`} width={300} height={150} style={{ borderRadius: 6, border: "1px solid var(--panel-border)" }} />
                    </a>
                  ) : (
                    <div style={{ width: 300, height: 150, borderRadius: 6, background: "var(--panel-border)" }} />
                  )}
                  <div style={{ fontSize: 12 }}>{row?.dow_state?.replace(/_/g, " ") ?? "Unavailable"}</div>
                  <div style={{ fontSize: 11, color: row?.wave_confidence === "confirmed" ? "var(--pass)" : "var(--text-dim)" }}>
                    {row?.wave_label ?? "Wave: unconfirmed"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bullish hypothesis</h2>
        <TraceTable rows={bullish} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bearish hypothesis</h2>
        <TraceTable rows={bearish} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Risk, data, and other rules</h2>
        <TraceTable rows={neutral} />
      </div>
    </div>
  );
}
