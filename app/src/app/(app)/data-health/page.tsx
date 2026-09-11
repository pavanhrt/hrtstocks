import { getLatestRun, getDataQualityIssues, getPipelineAuditLog, getRecentRuns, getRunProgress } from "@/lib/data/runs";
import { groupDataQualityIssues, groupAuditLog } from "@/lib/data/group-issues";
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

          <RunProgress runId={run.id} />
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

/** Live progress for a run still in flight -- see lib/data/runs.ts's getRunProgress. */
async function RunProgress({ runId }: { runId: string }) {
  const progress = await getRunProgress(runId);
  if (!progress) return null;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>
        Run progress {progress.expectedCount > 0 && `-- ${progress.processedCount}/${progress.expectedCount} instruments`}
      </h2>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
        <span>Batches pending: <strong>{progress.batchesPending}</strong></span>
        <span>In progress: <strong>{progress.batchesInProgress}</strong></span>
        <span>Done: <strong>{progress.batchesDone}</strong></span>
        <span>Failed: <strong>{progress.batchesFailed}</strong></span>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 0 }}>
        Expected universe {progress.expectedCount} &middot; succeeded/watch/rejected/manual review {progress.processedCount} &middot; not yet
        attempted {Math.max(0, progress.expectedCount - progress.processedCount)}
      </p>
    </div>
  );
}

/** Groups repeated causes instead of one row per instrument -- a systemic issue could otherwise produce hundreds of near-identical rows. */
async function QuarantinedInstruments({ runId }: { runId: string }) {
  const issues = await getDataQualityIssues(runId);
  const groups = groupDataQualityIssues(issues);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Quarantined instruments -- {issues.length} row(s) in {groups.length} distinct cause(s)</h2>
      {groups.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No data-quality failures for this run.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Result</th>
              <th>Count</th>
              <th>Sample instruments</th>
              <th>First / last seen</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.check_name}::${g.result}`}>
                <td>{g.check_name}</td>
                <td>
                  <Badge status={g.result} />
                </td>
                <td>{g.count}</td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{g.sample_instrument_ids.join(", ") || "-"}</td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {g.first_seen} &rarr; {g.last_seen}
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
  const groups = groupAuditLog(log);
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>Pipeline audit log &mdash; this run ({log.length} event(s) in {groups.length} distinct cause(s))</h2>
      {groups.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No stage log recorded.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Status</th>
              <th>Count</th>
              <th>Sample message(s)</th>
              <th>First / last seen</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={`${g.stage}::${g.status}`}>
                <td>{g.stage}</td>
                <td>{g.status}</td>
                <td>{g.count}</td>
                <td style={{ fontSize: 12 }}>{g.sample_messages.join(" | ") || "-"}</td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {g.first_seen} &rarr; {g.last_seen}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
