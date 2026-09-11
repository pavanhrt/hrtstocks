import Link from "next/link";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getSwingAnalysisCandidates, type SwingCandidate } from "@/lib/data/swing-analysis";
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

const HOURLY_ROUTES_NOTE =
  'BUY-1/SELL-3 "Wave 3 Ignition", BUY-4/SELL-4 "Wave 2 Pullback"/"Bounce Failure", and SELL-1 "Wave 5 Exhaustion" (no bullish mirror) -- 3 of the 10 documented hourly routes';

function ConditionsTable({ candidate }: { candidate: SwingCandidate }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Gate</th>
            <th>Result</th>
            <th>Observed values</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {candidate.conditions.map((c) => (
            <tr key={c.ruleId}>
              <td style={{ whiteSpace: "nowrap" }}>{GATE_LABELS[c.ruleId] ?? c.ruleId}</td>
              <td>
                <Badge status={c.result} />
              </td>
              <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                {c.observedValues && Object.keys(c.observedValues).length > 0 ? JSON.stringify(c.observedValues) : "-"}
              </td>
              <td style={{ fontSize: 12 }}>{c.explanation ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RouteEvidence({ candidate }: { candidate: SwingCandidate }) {
  if (!candidate.routeEvidence) {
    const clearedLock = candidate.automatedGatesPassed === candidate.automatedGatesTotal;
    return (
      <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
        No 1-hour route evidence this run.{" "}
        {clearedLock
          ? `The weekly+daily direction lock is clear, but the evidence matched none of the ${HOURLY_ROUTES_NOTE}, or no 1-hour bars were available for this stock.`
          : "Blocked: the weekly+daily direction lock (M1-M4 above) hasn't cleared this run, so 1-hour bars are never fetched for this stock -- see which gate above failed."}
      </p>
    );
  }
  return (
    <div>
      <p style={{ fontSize: 12, margin: "0 0 6px" }}>
        Selected route: <strong>{candidate.selectedRoute ?? "none matched"}</strong> -- full evidence from{" "}
        <code>features/hourly-routes.js</code>:
      </p>
      <pre
        style={{
          fontSize: 11,
          background: "var(--bg)",
          border: "1px solid var(--panel-border)",
          borderRadius: 6,
          padding: 10,
          overflowX: "auto",
          margin: 0,
        }}
      >
        {JSON.stringify(candidate.routeEvidence, null, 2)}
      </pre>
    </div>
  );
}

function CandidateAccordion({ candidates }: { candidates: SwingCandidate[] }) {
  if (candidates.length === 0) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>None this run.</p>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {candidates.map((c, i) => (
        <details key={c.instrumentId} style={{ border: "1px solid var(--panel-border)", borderRadius: 6, padding: "8px 12px" }}>
          <summary style={{ cursor: "pointer", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-dim)", fontSize: 12, minWidth: 22 }}>{i + 1}</span>
            <span>
              <Link href={`/stocks/${c.instrumentId}`}>{c.name}</Link>{" "}
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>({c.symbol})</span>
            </span>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {c.automatedGatesPassed}/{c.automatedGatesTotal} direction-lock gates
            </span>
            <span style={{ fontSize: 12 }}>{c.selectedRoute ? `Route: ${c.selectedRoute}` : ""}</span>
            <span style={{ marginLeft: "auto" }}>
              <Badge status={c.finalAction} />
            </span>
          </summary>

          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            <div>
              <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>All conditions (M1-M8 / S1-S8)</h3>
              <ConditionsTable candidate={c} />
            </div>

            <div>
              <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>1-hour route evidence</h3>
              <RouteEvidence candidate={c} />
            </div>

            {c.pendingConditions.length > 0 && (
              <div>
                <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>
                  {c.finalAction === "WAIT" ? "Why final action is WAIT, not BUY/SELL" : "Evidence and disclosures behind this verdict"}
                </h3>
                <ul style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>
                  {c.pendingConditions.map((p, idx) => (
                    <li key={idx}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
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
          daily Dow, daily wave + MACD Tide) to all pass before the hourly chart is even opened --
          real, automated gates. As of Correction Cycle 2 (2026-09-11), M5-M8 are real too: M5
          (hourly Elliott setup) matches whenever one of {HOURLY_ROUTES_NOTE}, actually matched; M6
          (PAPA price-action trigger) requires a same-direction formation to have
          actually TRIGGERED, not merely been observed; M7 (SMM Bull/Bear Hat) requires the daily
          Tide and the hourly Wave to agree; M8 (reward:risk) requires a strict ratio above 3,
          computed from the selected route&apos;s own stop and target. A stock only shows{" "}
          <Badge status="BUY" />/<Badge status="SELL" /> when ALL EIGHT gates pass, at least 4 of 5
          confirmation groups are supportive, and zero vetoes have fired --{" "}
          <strong>otherwise it stays WAIT</strong>, with the specific blocking gate/group/veto
          named below, never a bare unexplained WAIT. Three of the ten hourly routes (BUY-2, BUY-3/
          SELL-2, BUY-5/SELL-5) and two PAPA formations (Accumulation/Distribution, Tweezers) remain
          unimplemented -- each for its own disclosed reason (see{" "}
          <code>docs/swing-strategy-extraction.md</code> and each module&apos;s own header comment) --
          so a WAIT verdict does not always mean a setup failed; it can also mean no implemented
          route/formation matched yet. Two cross-check-only vetoes ("EMA tangled while ADX ranges";
          "monthly/weekly Elliott count invalid") stay unimplemented too -- one would need inventing
          an unquantified "tangled" threshold, the other needs monthly Elliott position data this
          pipeline doesn&apos;t compute yet. Expand a stock to see every gate&apos;s real observed
          values and explanation, the full 1-hour route evidence when one exists, and exactly which
          condition is still open.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bullish (Buy Signal Playbook) -- {bullish.length} evaluated</h2>
        <CandidateAccordion candidates={bullish} />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Bearish (Sell Signal Playbook) -- {bearish.length} evaluated</h2>
        <CandidateAccordion candidates={bearish} />
      </div>
    </div>
  );
}
