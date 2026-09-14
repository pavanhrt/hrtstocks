import Link from "next/link";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { getLatestRun, getLatestPublishedRun, getCoverage, getTierCounts, getIndexResults, getTopCandidates, getRunProgress } from "@/lib/data/runs";
import { formatTimestamp, getPublishedRunMetadata } from "@/lib/data/run-metadata";
import { Badge } from "../Badge";
import RunScreeningButton from "../RunScreeningButton";

const TIER_LABELS: Record<string, string> = {
  tier_a: "Tier A",
  tier_b: "Tier B",
  watch: "Watch",
  manual_review: "Manual review",
  rejected: "Rejected",
  unavailable: "Unavailable",
};

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const [latestRun, run] = await Promise.all([getLatestRun(), getLatestPublishedRun()]);

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Daily dashboard</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No validated snapshot has been published yet. Operational progress remains available on Data health.
        </p>
        {user && roleAtLeast(user.role, "researcher") && <RunScreeningButton />}
      </div>
    );
  }

  const isInFlight = latestRun?.status === "queued" || latestRun?.status === "running";
  const metadata = getPublishedRunMetadata(run as unknown as Parameters<typeof getPublishedRunMetadata>[0]);
  const [coverage, tierCounts, indexResults, candidates, progress] = await Promise.all([
    getCoverage(run.id),
    getTierCounts(run.id),
    getIndexResults(run.id),
    getTopCandidates(run.id, 10),
    isInFlight && latestRun ? getRunProgress(latestRun.id) : Promise.resolve(null),
  ]);

  return (
    <div className="page-grid">
      <div className="card dashboard-heading">
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Daily dashboard</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: 13 }}>
            Published run {run.run_date} &middot; cutoff {formatTimestamp(metadata.cutoff)} &middot; {run.mode} &middot;{" "}
            publication <Badge status={metadata.publicationState} /> &middot; universe {run.universe_version}
          </p>
        </div>
        {user && roleAtLeast(user.role, "researcher") && <RunScreeningButton />}
      </div>

      {isInFlight && latestRun && progress && (
        <div className="card" style={{ borderColor: "var(--watch)" }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>
            Newer run in progress -- {progress.processedCount}/{progress.expectedCount || "?"} instruments attempted
          </h2>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
            <span>Chunks done: <strong>{progress.batchesDone}</strong></span>
            <span>In progress: <strong>{progress.batchesInProgress}</strong></span>
            <span>Pending: <strong>{progress.batchesPending}</strong></span>
            <span>Failed: <strong>{progress.batchesFailed}</strong></span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 0 }}>
            Published metrics below remain pinned to run {run.run_date}; unfinished work cannot change them. Full detail on <Link href="/data-health">Data health</Link>.
          </p>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Tier totals</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {Object.entries(TIER_LABELS).map(([key, label]) => (
            <div key={key}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{tierCounts[key] ?? 0}</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Coverage reconciliation</h2>
        {coverage ? (
          <p style={{ fontSize: 13 }}>
            {coverage.unique_stock_count} unique stocks ={" "}
            {coverage.tier_a} Tier A + {coverage.tier_b} Tier B + {coverage.watch} Watch +{" "}
            {coverage.manual_review} Manual review + {coverage.rejected} Rejected +{" "}
            {coverage.unavailable} Unavailable ={" "}
            <strong style={{ color: coverage.reconciled ? "var(--pass)" : "var(--fail)" }}>
              {coverage.reconciled ? "reconciled" : "NOT reconciled"}
            </strong>
          </p>
        ) : (
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Not yet computed for this run.</p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Index regime summary</h2>
        <div className="table-scroll" tabIndex={0} aria-label="Index regime summary; scroll horizontally for all columns">
          <table>
            <caption className="sr-only">Index regime summary for the published run</caption>
            <thead>
              <tr>
                <th>Index</th>
                <th>Direction</th>
                <th>Result</th>
                <th>Data quality</th>
              </tr>
            </thead>
            <tbody>
              {indexResults.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--text-dim)" }}>
                    No index results for this run.
                  </td>
                </tr>
              )}
              {indexResults.map((r) => (
                <tr key={r.id}>
                  <td>{r.instruments?.name ?? r.instrument_id}</td>
                  <td>{r.direction ?? "-"}</td>
                  <td>
                    <Badge status={r.terminal_state} />
                  </td>
                  <td>{r.data_quality ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 8 }}>
          <Link href="/indexes">Full index analysis -&gt;</Link>
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Highest-ranked research candidates</h2>
        <div className="table-scroll" tabIndex={0} aria-label="Ranked candidates; scroll horizontally for all columns">
          <table>
            <caption className="sr-only">Highest ranked published research candidates</caption>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Instrument</th>
                <th>Tier</th>
                <th>Direction</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: "var(--text-dim)" }}>
                    No Tier A/B candidates this run.
                  </td>
                </tr>
              )}
              {candidates.map((c) => (
                <tr key={c.id}>
                  <td>{c.rank_within_tier ?? "-"}</td>
                  <td>
                    <Link href={`/stocks/${c.instrument_id}`}>
                      {c.instruments?.name ?? c.instrument_id}
                    </Link>
                  </td>
                  <td>{TIER_LABELS[c.tier] ?? c.tier}</td>
                  <td>{c.direction ?? "-"}</td>
                  <td>{c.total_score ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginTop: 8 }}>
          <Link href="/stocks">Complete stock ledger -&gt;</Link>
        </p>
      </div>
    </div>
  );
}
