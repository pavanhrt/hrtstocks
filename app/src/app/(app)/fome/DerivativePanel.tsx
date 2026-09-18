"use client";

import type { FomeRuleTrace } from "@/lib/data/fome";

const OI_RULE_IDS = ["FOME-SIG-FUT-OI-001", "FOME-SIG-FUT-OI-002", "FOME-SIG-OPT-OI-BULL-001", "FOME-SIG-OPT-OI-BEAR-001"];

/**
 * Futures and option-chain/OI analysis. Contract-level strike/premium
 * detail lives in the Strategy comparison table below (each candidate's own
 * `legs`) -- this panel focuses on the OI interpretation, which is exactly
 * what the FOME-SIG-FUT-OI/OPT-OI rule traces already disclose with full
 * provenance.
 */
export default function DerivativePanel({
  derivativeEligible,
  derivativeSource,
  selectedExpiry,
  spotDerivativeAligned,
  spotDerivativeSkewReason,
  ruleTraces,
}: {
  derivativeEligible: boolean | null;
  derivativeSource: string | null;
  selectedExpiry: string | null;
  spotDerivativeAligned: boolean | null;
  spotDerivativeSkewReason: string | null;
  ruleTraces: FomeRuleTrace[];
}) {
  if (derivativeEligible === false) {
    return (
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        NOT_APPLICABLE -- this instrument currently has no futures/options contract data available from the
        provider. The technical direction above still applies; no derivative overlay is shown.
      </p>
    );
  }

  const oiTraces = ruleTraces.filter((t) => OI_RULE_IDS.includes(t.ruleId));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        Source: {derivativeSource ?? "unknown"} (a licensed broker feed, not the official NSE contract master -- this project has no
        NSE contract-master ingestion; see the implementation report&apos;s disclosed limitation).
        {selectedExpiry ? ` Selected expiry: ${selectedExpiry}.` : ""}
        {spotDerivativeAligned === false && (
          <span style={{ color: "var(--fail)", display: "block", marginTop: 4 }}>
            Spot and derivative timestamps are materially mismatched ({spotDerivativeSkewReason}) -- futures OI evidence below is
            withheld until they realign.
          </span>
        )}
      </div>
      {oiTraces.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Derivative data is available, but no OI evidence could be evaluated for this run.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Observed</th>
                <th>Result</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {oiTraces.map((t) => (
                <tr key={t.id}>
                  <td>{t.ruleId}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{t.observedValues ? JSON.stringify(t.observedValues) : "-"}</td>
                  <td>{t.result}</td>
                  <td style={{ fontSize: 12 }}>{t.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
        Contract-level strikes and premiums appear per strategy in the Strategy comparison section below.
      </p>
    </div>
  );
}
