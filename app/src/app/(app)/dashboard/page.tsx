import Link from "next/link";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { getLatestRun, getCoverage, getTierCounts, getIndexResults, getTopCandidates, getRunProgress } from "@/lib/data/runs";
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
  const run = await getLatestRun();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Daily dashboard</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No screening run has completed yet. Once one runs -- scheduled end-of-day, or triggered
          manually -- the index regime summary, complete stock ledger, and ranked candidates will
          appear here.
        </p>
        {user && roleAtLeast(user.role, "researcher") && <RunScreeningButton />}
      </div>
    );
  }

  const isInFlight = run.status === "queued" || run.status === "running";
  const [coverage, tierCounts, indexResults, candidates, progress] = await Promise.all([
    getCoverage(run.id),
    getTierCounts(run.id),
    getIndexResults(run.id),
    getTopCandidates(run.id, 10),
    isInFlight ? getRunProgress(run.id) : Promise.resolve(null),
  ]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Daily dashboard</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-dim)", fontSize: 13 }}>
            Run {run.run_date} &middot; {run.mode} &middot; status <Badge status={run.status.toUpperCase()} /> &middot;{" "}
            universe {run.universe_version} &middot; {run.trigger_type}
          </p>
        </div>
        {user && roleAtLeast(user.role, "researcher") && <RunScreeningButton />}
      </div>

      {isInFlight && progress && (
        <div className="card" style={{ borderColor: "var(--watch)" }}>
          <h2 style={{ marginTop: 0, fontSize: 15 }}>
            Run in progress -- {progress.processedCount}/{progress.expectedCount || "?"} instruments attempted
          </h2>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
            <span>Chunks done: <strong>{progress.batchesDone}</strong></span>
            <span>In progress: <strong>{progress.batchesInProgress}</strong></span>
            <span>Pending: <strong>{progress.batchesPending}</strong></span>
            <span>Failed: <strong>{progress.batchesFailed}</strong></span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 0 }}>
            Runs resume automatically (self-continuation, with a recovery sweep as a safety net) --
            refresh this page to see progress advance. Full detail on <Link href="/data-health">Data health</Link>.
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
        <div style={{ overflowX: "auto" }}>
          <table>
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
                  <td>{(r as any).instruments?.name ?? r.instrument_id}</td>
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
        <div style={{ overflowX: "auto" }}>
          <table>
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
                      {(c as any).instruments?.name ?? c.instrument_id}
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
