import { getLatestRun, getDataQualityIssues, getPipelineAuditLog, getRecentRuns } from "@/lib/data/runs";
import { Badge } from "../Badge";

export default async function DataHealthPage() {
  const run = await getLatestRun();
  const recentRuns = await getRecentRuns(15);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card" style={{ borderColor: "var(--watch)" }}>
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Data health</h1>
        <p style={{ fontSize: 13 }}>
          <strong style={{ color: "var(--watch)" }}>Provisional data source:</strong> market data is
          currently ingested from NSE&apos;s public website endpoints (unofficial, unlicensed,
          free) as an MVP bridge &mdash; see <code>references/market-data-policy.md</code>. It is
          never labeled <code>LIVE</code>. Records are tagged{" "}
          <code>data_source: nse_public_unofficial</code> and freshness is reported as{" "}
          <code>EOD</code>/<code>DELAYED</code> only. Swap in a licensed provider before relying on
          this for anything beyond research.
        </p>
      </div>

      {run ? (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Latest run providers &amp; timestamps</h2>
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
              {run.providers ? JSON.stringify(run.providers, null, 2) : "No provider metadata recorded."}
            </pre>
            <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Started {run.started_at ?? "-"} &middot; Completed {run.completed_at ?? "-"}
            </p>
          </div>

          <QuarantinedInstruments runId={run.id} />
          <PipelineLog runId={run.id} />
        </>
      ) : (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Pipeline history</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Universe</th>
              <th>Started</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {recentRuns.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--text-dim)" }}>
                  No runs recorded yet.
                </td>
              </tr>
            )}
            {recentRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.run_date}</td>
                <td>
                  <Badge status={r.status.toUpperCase()} />
                </td>
                <td>{r.trigger_type}</td>
                <td>{r.universe_version}</td>
                <td>{r.started_at ?? "-"}</td>
                <td>{r.completed_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function QuarantinedInstruments({ runId }: { runId: string }) {
  const issues = await getDataQualityIssues(runId);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Quarantined instruments</h2>
      {issues.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No data-quality failures for this run.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Check</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td>{(i as any).instruments?.name ?? i.instrument_id ?? "-"}</td>
                <td>{i.check_name}</td>
                <td>
                  <Badge status={i.result} />
                </td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {i.details ? JSON.stringify(i.details) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

async function PipelineLog({ runId }: { runId: string }) {
  const log = await getPipelineAuditLog(runId);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Pipeline audit log &mdash; this run</h2>
      {log.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No stage log recorded.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {log.map((l) => (
              <tr key={l.id}>
                <td>{l.created_at}</td>
                <td>{l.stage}</td>
                <td>{l.status}</td>
                <td>{l.message ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
