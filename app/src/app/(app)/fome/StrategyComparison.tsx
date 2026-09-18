"use client";

import type { FomeStrategyCandidate } from "@/lib/data/fome";

const STRATEGY_LABEL: Record<string, string> = {
  long_futures: "Long futures",
  short_futures: "Short futures",
  long_call: "Long call",
  long_put: "Long put",
  bull_call_spread: "Bull call spread",
  bear_put_spread: "Bear put spread",
  bull_put_spread: "Bull put spread",
  bear_call_spread: "Bear call spread",
  bullish_call_ratio_spread: "Bullish call ratio spread",
  bearish_put_ratio_spread: "Bearish put ratio spread",
  covered_call: "Covered call",
  covered_put: "Covered put",
  long_collar: "Long collar",
  short_collar: "Short collar",
  long_straddle: "Long straddle",
  long_strangle: "Long strangle",
  short_straddle: "Short straddle",
  short_strangle: "Short strangle",
  short_iron_butterfly: "Short iron butterfly",
  short_iron_condor: "Short iron condor",
  long_iron_butterfly: "Long iron butterfly",
  long_iron_condor: "Long iron condor",
  calendar_spread: "Calendar spread",
};

const QUALIFICATION_LABEL: Record<string, string> = {
  qualified: "Qualified",
  watch: "Watch (tail risk)",
  not_qualified: "Not qualified",
  manual_review: "Manual review",
  no_data: "No data",
};

function money(n: number | null | undefined) {
  return n == null ? "-" : n.toFixed(2);
}

/**
 * Strategy comparison table plus the "best-fit strategy or no-trade
 * decision" lead. Never claims a strategy "will work" -- uses "best fit
 * under the available evidence" language only. A tail-risk candidate
 * (unlimitedRisk) is always visually flagged.
 */
export default function StrategyComparison({ candidates, derivativeEligible }: { candidates: FomeStrategyCandidate[]; derivativeEligible: boolean | null }) {
  if (derivativeEligible === false) {
    return (
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        NO_DATA -- no current derivative (futures/options) contract data is available for this instrument, so no
        contract-level FOME strategy can be evaluated. The technical/direction result above is unaffected.
      </p>
    );
  }
  if (candidates.length === 0) {
    return (
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        No strategy comparison was produced -- the current alignment (mixed, wait-for-entry-confirmation, manual
        review, unavailable, or a spot/derivative timestamp mismatch) does not qualify for a regime-based strategy
        comparison. This is not a technical failure; it means the evidence does not yet support a directional
        derivative decision.
      </p>
    );
  }

  const best = candidates.find((c) => c.qualificationStatus === "qualified");
  const lotSizeKnown = candidates.some((c) => c.lotSize != null);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!lotSizeKnown && (
        <p style={{ fontSize: 12, color: "var(--watch)" }}>
          Lot size is unavailable from the current provider -- every payoff figure below is per single unit, not
          per lot, until a real lot size is resolved. Never estimated.
        </p>
      )}
      {best ? (
        <div className="card" style={{ background: "var(--panel-bg-alt, transparent)" }}>
          <strong>Best fit under the available FOME evidence:</strong> {STRATEGY_LABEL[best.strategyId] ?? best.strategyId}
          {best.whyFits && <div style={{ fontSize: 13, marginTop: 4 }}>{best.whyFits}</div>}
        </div>
      ) : (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          No candidate satisfied every hard prerequisite (valid strikes, defined risk, resolved lot size, computable
          payoff) -- see the leading candidates and their unresolved requirement below.
        </p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Strategy</th>
              <th>Status</th>
              <th>Why it fits / fails</th>
              <th>Net debit/credit</th>
              <th>Break-even(s)</th>
              <th>Max profit</th>
              <th>Max loss</th>
              <th>Margin</th>
              <th>Reward/risk</th>
              <th>Classification</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.strategyId}>
                <td>{c.rank}</td>
                <td>
                  {STRATEGY_LABEL[c.strategyId] ?? c.strategyId}
                  {c.unlimitedRisk && (
                    <div style={{ color: "var(--fail)", fontSize: 11, fontWeight: 600 }}>UNLIMITED-RISK LEG -- prefer a defined-risk alternative above</div>
                  )}
                </td>
                <td>{QUALIFICATION_LABEL[c.qualificationStatus] ?? c.qualificationStatus}</td>
                <td style={{ fontSize: 12, maxWidth: 260 }}>{c.whyFits ?? c.whyFails ?? "-"}</td>
                <td>{money(c.netDebitOrCredit)}</td>
                <td>{c.breakEvens && c.breakEvens.length > 0 ? c.breakEvens.map((b) => b.toFixed(2)).join(" / ") : "-"}</td>
                <td>{money(c.maxProfit)}</td>
                <td>{money(c.maxLoss)}</td>
                <td>{c.marginState === "available" ? money(c.margin) : "unavailable"}</td>
                <td>{c.rewardRisk == null ? "-" : c.rewardRisk.toFixed(2)}</td>
                <td>{c.finalClassification ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
