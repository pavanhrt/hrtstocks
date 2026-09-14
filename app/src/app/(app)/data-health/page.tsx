import { getLatestRun, getLatestPublishedRun, getCoverage, getDataQualityIssues, getPipelineAuditLog, getRecentRuns, getRunProgress, getPublicationManifest, getPersistenceErrorCount } from "@/lib/data/runs";
import { groupDataQualityIssues, groupAuditLog } from "@/lib/data/group-issues";
import { formatTimestamp, getPublishedRunMetadata } from "@/lib/data/run-metadata";
import { Badge } from "../Badge";

export default async function DataHealthPage() {
  const [run, publishedRun, recentRuns] = await Promise.all([getLatestRun(), getLatestPublishedRun(), getRecentRuns(15)]);
  const publishedMetadata = publishedRun
    ? getPublishedRunMetadata(publishedRun as unknown as Parameters<typeof getPublishedRunMetadata>[0])
    : null;
  const [coverage, manifest, persistenceErrors] = publishedRun
    ? await Promise.all([getCoverage(publishedRun.id), getPublicationManifest(publishedRun.id), getPersistenceErrorCount(publishedRun.id)])
    : [null, null, null];

  return (
    <div className="page-grid">
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Data health</h1>
        {publishedRun && publishedMetadata ? (
          <div className="metadata-grid">
            <div><span>Published run</span><strong>{publishedRun.run_date}</strong></div>
            <div><span>Run cutoff</span><strong>{formatTimestamp(publishedMetadata.cutoff)}</strong></div>
            <div><span>Publication</span><strong>{publishedMetadata.publicationState}</strong></div>
            <div><span>Analysis provider</span><strong>{publishedMetadata.analysisProvider ?? publishedMetadata.providers.find((item) => item.category === "ohlcv")?.provider ?? "Not recorded"}</strong></div>
            <div><span>Adjustment state</span><strong>{publishedMetadata.adjustmentState ?? "Not recorded"}</strong></div>
            <div><span>Series version</span><strong>{publishedMetadata.analysisSeriesVersion ?? "Not recorded"}</strong></div>
            <div><span>Universe</span><strong>{coverage ? `${coverage.unique_stock_count} equities` : "Not recorded"}</strong></div>
            <div><span>Coverage</span><strong>{coverage?.reconciled ? "Reconciled" : "Not reconciled"}</strong></div>
            <div><span>Manifest</span><strong>{manifest ? `${manifest.result_equities}/${manifest.expected_equities} equities` : "Not recorded"}</strong></div>
            <div><span>Direction rows</span><strong>{manifest ? `${manifest.direction_rows} / ${manifest.eligible_equities * 3} eligible timeframe rows` : "Not recorded"}</strong></div>
            <div><span>Chart objects</span><strong>{manifest ? manifest.chart_rows : "Not recorded"}</strong></div>
            <div><span>Critical persistence errors</span><strong>{persistenceErrors ?? manifest?.critical_persistence_errors ?? "Not recorded"}</strong></div>
          </div>
        ) : <p className="supporting-text">No published snapshot is available.</p>}
        <p className="supporting-text">Provider and adjustment labels above come from persisted run metadata; missing provenance is shown as not recorded.</p>
        {manifest && (manifest.validation_errors.length > 0 || manifest.future_analysis_bars > 0 || manifest.missing_storage_objects > 0) && (
          <div className="validation-warning" role="alert">
            <strong>Publication warnings</strong>
            <ul>
              {manifest.validation_errors.map((message) => <li key={message}>{message}</li>)}
              {manifest.future_analysis_bars > 0 && <li>{manifest.future_analysis_bars} analysis bars exceed the frozen cutoff.</li>}
              {manifest.missing_storage_objects > 0 && <li>{manifest.missing_storage_objects} required chart objects are missing.</li>}
            </ul>
          </div>
        )}
      </div>

      {run ? (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Latest run providers &amp; timestamps</h2>
            <pre className="metadata-json">
              {run.providers ? JSON.stringify(run.providers, null, 2) : "No provider metadata recorded."}
            </pre>
            <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Started {formatTimestamp(run.started_at)} &middot; Completed {formatTimestamp(run.completed_at)}
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
        <div className="table-scroll" tabIndex={0} aria-label="Pipeline history; scroll horizontally for all columns">
          <table>
            <caption className="sr-only">Recent pipeline runs and publication status</caption>
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
        <div className="table-scroll" tabIndex={0} aria-label="Quarantined instruments; scroll horizontally for all columns">
          <table>
            <caption className="sr-only">Grouped data-quality issues for the latest operational run</caption>
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
        </div>
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
        <div className="table-scroll" tabIndex={0} aria-label="Pipeline audit log; scroll horizontally for all columns">
          <table>
            <caption className="sr-only">Grouped pipeline audit events for the latest operational run</caption>
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
                  <td>
                    <Badge status={g.status.toUpperCase()} />
                  </td>
                  <td>{g.count}</td>
                  <td style={{ fontSize: 12 }}>{g.sample_messages.join(" | ") || "-"}</td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {g.first_seen} &rarr; {g.last_seen}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
