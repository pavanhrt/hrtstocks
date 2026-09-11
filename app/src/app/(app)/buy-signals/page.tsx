import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getSignalCandidates, BUY_CODEABLE_GATES, BUY_MANUAL_GATES, type SignalCandidate } from "@/lib/data/signals";
import { Badge } from "../Badge";

const GATE_LABELS: Record<string, string> = {
  "BSP-M1": "M1 Monthly Dow",
  "BSP-M3": "M3 Weekly Dow",
  "BSP-M4B": "M4b Weekly MACD Tide",
  "BSP-M7A": "M7 Step1 Bull Hat Tide",
  "BSP-M7B": "M7 Step2 Bull Hat Wave",
  "BSP-M2": "M2 Monthly Elliott",
  "BSP-M4A": "M4a Weekly Elliott",
  "BSP-M5": "M5 Daily Elliott setup",
  "BSP-M6": "M6 PAPA trigger",
  "BSP-M8": "M8 Reward:Risk",
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
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Codeable gates (M1/M3/M4b/M7)</th>
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
                <GateRow candidate={c} gates={BUY_CODEABLE_GATES} />
              </td>
              <td>
                {c.codeableGatesPassed} / {c.codeableGatesTotal}
              </td>
              <td>
                <GateRow candidate={c} gates={BUY_MANUAL_GATES} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function BuySignalsPage() {
  const run = await getLatestPublishedRun();

  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Buy signals</h1>
        <p style={{ color: "var(--text-dim)" }}>
          No screening run has completed yet. Trigger one from the Dashboard (Researcher role or
          higher), then come back here.
        </p>
      </div>
    );
  }

  const candidates = await getSignalCandidates(run.id, "BSP");
  const highlyRecommended = candidates.filter((c) => c.codeableGatesPassed === c.codeableGatesTotal);
  const nextUp = candidates.filter((c) => c.codeableGatesPassed < c.codeableGatesTotal).slice(0, 20);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Buy signals</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Run {run.run_date} &middot; strategies/buy-signal-playbook.yaml (positional, Monthly &rarr;
          Weekly &rarr; Daily)
        </p>
        <p style={{ fontSize: 13 }}>
          This screens against the Buy Signal Playbook&apos;s eight mandatory gates. Four of them --
          Monthly Dow structure (M1), Weekly Dow structure (M3), the Weekly MACD Tide (M4b), and the
          SMM Bull Hat (M7) -- are computed deterministically from OHLCV bars. The other four --
          Elliott wave position and count (M2, M4a, M5), the PAPA price-action trigger (M6), and the
          reward:risk gate (M8) -- require Elliott wave labeling and an entry/stop/target this
          pipeline does not attempt to derive automatically, and are marked{" "}
          <Badge status="MANUAL_REVIEW" /> for every stock. <strong>&quot;Codeable gates fully cleared&quot;
          below means a stock cleared every gate this pipeline can check mechanically -- it is not a
          recommendation and not a complete pass of the playbook</strong>, and still needs a human (or AI-assisted) Elliott wave
          read before it is an actual trade candidate. Also note: M7&apos;s Step 1 needs about 35
          monthly closes (~3 years) of history to compute a monthly MACD, but only 365 days of daily
          bars are ingested today -- so M7 will often read NO_DATA rather than PASS/FAIL until that
          lookback is extended.
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
