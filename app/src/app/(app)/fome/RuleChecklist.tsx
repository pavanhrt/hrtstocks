"use client";

import type { FomeRuleTrace } from "@/lib/data/fome";
import { Badge } from "../Badge";

/** Per-rule trace table: Rule ID, source status, timeframe, observed value, result, source, explanation. */
export default function RuleChecklist({ traces }: { traces: FomeRuleTrace[] }) {
  if (traces.length === 0) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No FOME rules were evaluated for this run.</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>Source status</th>
            <th>Timeframe</th>
            <th>Observed</th>
            <th>Result</th>
            <th>Source</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id}>
              <td style={{ fontFamily: "monospace", fontSize: 12 }}>{t.ruleId}</td>
              <td style={{ fontSize: 12 }}>{t.sourceStatus ?? "-"}</td>
              <td>{t.timeframe ?? "-"}</td>
              <td style={{ fontFamily: "monospace", fontSize: 12 }}>{t.observedValues ? JSON.stringify(t.observedValues) : "-"}</td>
              <td>
                <Badge status={t.result} />
              </td>
              <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {t.sourceDocument ?? "-"}
                {t.sourceLocator ? ` (${t.sourceLocator})` : ""}
              </td>
              <td style={{ fontSize: 12 }}>{t.explanation ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
