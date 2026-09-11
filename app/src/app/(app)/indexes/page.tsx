import Link from "next/link";
import { getLatestPublishedRun, getIndexResults, getIndexHistory } from "@/lib/data/runs";
import { Badge } from "../Badge";

export default async function IndexesPage() {
  const run = await getLatestPublishedRun();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Index analysis</h1>
        <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
      </div>
    );
  }

  const [indexResults, history] = await Promise.all([getIndexResults(run.id), getIndexHistory(10)]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Index analysis</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Run {run.run_date}</p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Index</th>
                <th>Direction</th>
                <th>Result</th>
                <th>Tier</th>
                <th>Score</th>
                <th>Data quality</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {indexResults.map((r) => (
                <tr key={r.id}>
                  <td>{(r as any).instruments?.name ?? r.instrument_id}</td>
                  <td>{r.direction ?? "-"}</td>
                  <td>
                    <Badge status={r.terminal_state} />
                  </td>
                  <td>{r.tier ?? "-"}</td>
                  <td>{r.score ?? "-"}</td>
                  <td>{r.data_quality ?? "-"}</td>
                  <td>
                    <Link href={`/stocks/${r.instrument_id}`}>Rule trace -&gt;</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Historical regime comparison</h2>
        {history.runs.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Not enough runs yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Index</th>
                  {history.runs.map((r) => (
                    <th key={r.id}>{r.run_date}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from(
                  new Set(
                    Object.values(history.resultsByRun)
                      .flat()
                      .map((r: any) => r.instrument_id)
                  )
                ).map((instrumentId) => (
                  <tr key={instrumentId}>
                    <td>{instrumentId}</td>
                    {history.runs.map((run) => {
                      const row = (history.resultsByRun[run.id] ?? []).find(
                        (r: any) => r.instrument_id === instrumentId
                      );
                      return <td key={run.id}>{row ? <Badge status={row.terminal_state} /> : "-"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
