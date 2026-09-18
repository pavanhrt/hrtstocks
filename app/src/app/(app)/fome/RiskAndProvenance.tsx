"use client";

import type { FomeAnalysisResult } from "@/lib/data/fome";

/**
 * Risk, limitations, conflicts, and data provenance -- every conclusion's
 * freshness/provenance in one place, plus the standing disclosures this
 * project always shows (naked-option-selling policy, the bearish NP
 * conflict, unresolved TLBO/Ungali/BKP/BKT terms, lot-size/margin honesty).
 */
export default function RiskAndProvenance({ result }: { result: FomeAnalysisResult }) {
  return (
    <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
      <p>
        This page supports research and human decision-making. It does not place orders, guarantee returns, or
        provide personalized investment advice. Nothing here should be read as &quot;guaranteed,&quot; &quot;safe,&quot;
        &quot;certain,&quot; or &quot;will work&quot; -- classifications describe the best fit under available evidence only.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
        <li>
          <strong>Frozen cutoff (as_of_timestamp):</strong> {new Date(result.asOfTimestamp).toLocaleString()} -- every bar/quote/rule in this run respects
          this one instant, never a moving target.
        </li>
        <li>
          <strong>Algorithm/rule/parameter versions:</strong> {result.algorithmVersion ?? "-"} / {result.ruleVersion ?? "-"} /{" "}
          {result.parameterVersion ?? "-"}.
        </li>
        <li>
          <strong>Data quality:</strong> {result.dataQuality ?? "-"}.
        </li>
        <li>
          <strong>Started:</strong> {result.startedAt ? new Date(result.startedAt).toLocaleString() : "-"} &middot;{" "}
          <strong>Completed:</strong> {result.completedAt ? new Date(result.completedAt).toLocaleString() : "still running"}.
        </li>
        <li>
          Derivative eligibility and contract data (strikes, premiums, OI, expiry) are broker-sourced (Fyers), not
          the official NSE contract/security master -- this project has no NSE contract-master ingestion. Lot size
          and margin are shown only when a real source resolves them, never estimated.
        </li>
        {result.spotDerivativeSkewReason && (
          <li style={{ color: "var(--fail)" }}>
            Spot/derivative timestamp mismatch detected: {result.spotDerivativeSkewReason} -- contract-level
            qualification was withheld for the affected evidence.
          </li>
        )}
        <li>
          TLBO, TLBD, bullish/bearish Ungali, and Bollinger BKP/BKT have no validated deterministic definition in this
          project&apos;s source register -- they always show as MANUAL_REVIEW in the rule checklist above, never a guessed
          pass or fail.
        </li>
        <li>
          The bearish guide-sheet row containing a naked-put (&quot;NP&quot;) recommendation is a documented CONFLICT -- this
          project never automates that leg; it always shows MANUAL_REVIEW.
        </li>
        <li>Naked option selling is never shown as a default recommendation; only defined-risk structures and covered variants are compared.</li>
        <li>Calendar spreads always show NO_DATA for payoff figures -- this project has no option-pricing model to value a far-month leg.</li>
        {result.errorMessage && (
          <li style={{ color: "var(--fail)" }}>
            <strong>Error:</strong> {result.errorMessage}
          </li>
        )}
      </ul>
    </div>
  );
}
