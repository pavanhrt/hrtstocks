import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getSignalCandidates, SELL_CODEABLE_GATES, SELL_MANUAL_GATES, type SignalCandidate } from "@/lib/data/signals";
import { Badge } from "../Badge";

const GATE_LABELS: Record<string, string> = {
  "SSP-S1": "S1 Monthly Dow",
  "SSP-S3": "S3 Weekly Dow",
  "SSP-S4B": "S4b Weekly MACD Tide",
  "SSP-S7A": "S7 Step1 Bear Hat Tide",
  "SSP-S7B": "S7 Step2 Bear Hat Wave",
  "SSP-S2": "S2 Monthly Elliott",
  "SSP-S4A": "S4a Weekly Elliott",
  "SSP-S5": "S5 Daily Elliott setup",
  "SSP-S6": "S6 PAPA trigger",
  "SSP-S8": "S8 Reward:Risk",
};

function GateRow({ candidate, gates }: { candidate: SignalCandidate; gates: readonly string[] }) {
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

function CandidateTable({ candidates }: { candidates: SignalCandidate[] }) {
  if (candidates.length === 0) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>None this run.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Instrument</th>
          <th>Codeable gates (S1/S3/S4b/S7)</th>
          <th>Passed</th>
          <th>Still needs manual review</th>
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
              <GateRow candidate={c} gates={SELL_CODEABLE_GATES} />
            </td>
            <td>
              {c.codeableGatesPassed} / {c.codeableGatesTotal}
            </td>
            <td>
              <GateRow candidate={c} gates={SELL_MANUAL_GATES} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function SellSignalsPage() {
  const run = await getLatestPublishedRun();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Sell signals</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No screening run has completed yet. Trigger one from the Dashboard (Researcher role or
          higher), then come back here.
        </p>
      </div>
    );
  }

  const candidates = await getSignalCandidates(run.id, "SSP");
  const highlyRecommended = candidates.filter((c) => c.codeableGatesPassed === c.codeableGatesTotal);
  const nextUp = candidates.filter((c) => c.codeableGatesPassed < c.codeableGatesTotal).slice(0, 20);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Sell signals (short entry)</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Run {run.run_date} &middot; strategies/sell-signal-playbook.yaml, Tier 2 short-entry only
          (positional, Monthly &rarr; Weekly &rarr; Daily)
        </p>
        <p style={{ fontSize: 13 }}>
          This screens against the Sell Signal Playbook&apos;s Tier 2 (short-entry) eight mandatory
          gates -- Tier 1 (the exit-long warning ladder for a position you already hold) is not
          screened here, since this pipeline has no notion of a held position or its entry price.
          Four gates -- Monthly Dow structure (S1), Weekly Dow structure (S3), the Weekly MACD Tide
          (S4b), and the SMM Bear Hat (S7) -- are computed deterministically from OHLCV bars. The
          other four -- Elliott wave position and count (S2, S4a, S5), the PAPA price-action trigger
          (S6), and the reward:risk gate (S8) -- require Elliott wave labeling and an entry/stop/target
          this pipeline does not derive automatically, and are marked <Badge status="MANUAL_REVIEW" />{" "}
          for every stock. <strong>&quot;Codeable gates fully cleared&quot; below means a stock cleared
          every gate this pipeline can check mechanically -- it is not a recommendation and not a
          complete pass of the playbook</strong>,
          and still needs a human (or AI-assisted) Elliott wave read before it is an actual short
          candidate. As on the buy side, S7&apos;s Step 1 needs ~3 years of monthly history for a
          monthly MACD, which the current 365-day daily lookback does not provide -- expect NO_DATA
          there until that&apos;s extended.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>
          Codeable gates fully cleared -- not a recommendation ({highlyRecommended.length})
        </h2>
        <CandidateTable candidates={highlyRecommended} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Next up -- ranked by codeable gates passed (top 20)</h2>
        <CandidateTable candidates={nextUp} />
      </div>
    </div>
  );
}
