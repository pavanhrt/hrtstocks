import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import {
  getSwingAnalysisCandidates,
  WBP_AUTOMATED_GATES,
  WSP_AUTOMATED_GATES,
  WBP_MANUAL_GATES,
  WSP_MANUAL_GATES,
  type SwingCandidate,
} from "@/lib/data/swing-analysis";
import { Badge } from "../Badge";

const GATE_LABELS: Record<string, string> = {
  "WBP-M1": "M1 Weekly Dow",
  "WBP-M2": "M2 Weekly Elliott",
  "WBP-M3": "M3 Daily Dow",
  "WBP-M4": "M4 Daily wave + Tide",
  "WBP-M5": "M5 Hourly Elliott setup",
  "WBP-M6": "M6 PAPA trigger",
  "WBP-M7": "M7 SMM Bull Hat",
  "WBP-M8": "M8 Reward:Risk",
  "WSP-S1": "S1 Weekly Dow",
  "WSP-S2": "S2 Weekly Elliott",
  "WSP-S3": "S3 Daily Dow",
  "WSP-S4": "S4 Daily wave + Tide",
  "WSP-S5": "S5 Hourly Elliott setup",
  "WSP-S6": "S6 PAPA trigger",
  "WSP-S7": "S7 SMM Bear Hat",
  "WSP-S8": "S8 Reward:Risk",
};

function GateRow({ candidate, gates }: { candidate: SwingCandidate; gates: readonly string[] }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {gates.map((g) => (
        <span key={g} title={GATE_LABELS[g] ?? g} style={{ fontSize: 11 }}>
          <Badge status={candidate.gateResults[g] ?? "NO_DATA"} />
        </span>
      ))}
    </div>
  );
}

function CandidateTable({
  candidates,
  automatedGates,
  manualGates,
}: {
  candidates: SwingCandidate[];
  automatedGates: readonly string[];
  manualGates: readonly string[];
}) {
  if (candidates.length === 0) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>None this run.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Instrument</th>
          <th>Weekly+daily direction lock ({automatedGates.map((g) => g.split("-")[1]).join("/")})</th>
          <th>Passed</th>
          <th>Hourly / trigger / risk (blocked -- see below)</th>
          <th>Selected route</th>
          <th>Final action</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr key={c.instrumentId}>
            <td>
              <Link href={`/stocks/${c.instrumentId}`}>{c.name}</Link>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({c.symbol})</span>
            </td>
            <td>
              <GateRow candidate={c} gates={automatedGates} />
            </td>
            <td>
              {c.automatedGatesPassed} / {c.automatedGatesTotal}
            </td>
            <td>
              <GateRow candidate={c} gates={manualGates} />
            </td>
            <td style={{ fontSize: 12 }}>{c.selectedRoute ?? <span style={{ color: "var(--text-dim)" }}>none detected</span>}</td>
            <td>
              <Badge status={c.finalAction} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PendingConditionsList({ candidates }: { candidates: SwingCandidate[] }) {
  const withDirectionLock = candidates.filter((c) => c.automatedGatesPassed === c.automatedGatesTotal);
  if (withDirectionLock.length === 0) return null;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 15 }}>
        Cleared the direction lock -- why these still say WAIT ({withDirectionLock.length})
      </h2>
      {withDirectionLock.map((c) => (
        <details key={c.instrumentId} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: "pointer" }}>
            <Link href={`/stocks/${c.instrumentId}`}>{c.name}</Link>{" "}
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({c.symbol})</span>
          </summary>
          <ul style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {c.pendingConditions.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export default async function AnalysisPage() {
  const run = await getLatestPublishedRun();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Analysis</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No screening run has completed yet. Trigger one from the Dashboard (Researcher role or
          higher), then come back here.
        </p>
      </div>
    );
  }

  const [bullish, bearish] = await Promise.all([
    getSwingAnalysisCandidates(run.id, "bullish"),
    getSwingAnalysisCandidates(run.id, "bearish"),
  ]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Analysis</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Run {run.run_date} &middot; strategies/buy-swing.yaml + sell-swing.yaml (Weekly &rarr;
          Daily &rarr; 1-Hour)
        </p>
        <p style={{ fontSize: 13 }}>
          Each playbook requires M1 AND M2 AND M3 AND M4 (weekly Dow, weekly Elliott position,
          daily Dow, daily wave + MACD Tide) to all pass before the hourly chart is even opened.
          Those four gates are real, automated results below. M5-M8 -- the hourly Elliott setup,
          the PAPA price-action trigger, the SMM Hat, and the reward:risk gate -- all require
          1-hour bar ingestion and route/confirmation/veto logic that this project has not built
          yet (see <code>docs/architecture-plan.md</code>, Phase 4 REMAINING), so they show{" "}
          <Badge status="MANUAL_REVIEW" /> and{" "}
          <strong>Final action is always WAIT today -- this pipeline has no honest basis to call
          BUY or SELL yet</strong>, even for a stock that clears the direction lock. Expand a row
          below to see exactly which condition is still open for each stock.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bullish (Buy Signal Playbook) -- {bullish.length} evaluated</h2>
        <CandidateTable candidates={bullish} automatedGates={WBP_AUTOMATED_GATES} manualGates={WBP_MANUAL_GATES} />
      </div>
      <PendingConditionsList candidates={bullish} />

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bearish (Sell Signal Playbook) -- {bearish.length} evaluated</h2>
        <CandidateTable candidates={bearish} automatedGates={WSP_AUTOMATED_GATES} manualGates={WSP_MANUAL_GATES} />
      </div>
      <PendingConditionsList candidates={bearish} />
    </div>
  );
}
