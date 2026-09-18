"use client";

import type { FomeTimeframeRow } from "@/lib/data/fome";
import ChartPreview from "../ChartPreview";

/**
 * 15-minute chart + plain-language summary (entry alignment with Daily
 * trend, current intraday structure, breakout/retest or breakdown/retest
 * evidence, immediate invalidation level, whether the latest candle is
 * complete). Pure presentation over already server-computed fields, same
 * convention as DailySummary.tsx.
 */
export default function FifteenMinSummary({ row, dailyRow }: { row: FomeTimeframeRow | undefined; dailyRow: FomeTimeframeRow | undefined }) {
  if (!row) return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>15-minute data is unavailable.</p>;

  const aligned = dailyRow?.direction && row.direction && dailyRow.direction !== "sideways" && row.direction === dailyRow.direction;
  const opposed = dailyRow?.direction && row.direction && dailyRow.direction !== "sideways" && row.direction !== dailyRow.direction && row.direction !== "sideways";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ChartPreview src={row.chartUrl} alt={`15-minute chart -- support ${row.support ?? "unavailable"}, resistance ${row.resistance ?? "unavailable"}${row.isProvisional ? ", latest candle provisional" : ""}`} />
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "grid", gap: 4 }}>
        <li>
          <strong>Entry alignment with Daily trend:</strong>{" "}
          {aligned
            ? `Aligned -- 15-minute momentum (${row.macdState ?? "unavailable"}) agrees with the Daily ${dailyRow?.direction} read.`
            : opposed
              ? `Opposed -- 15-minute momentum (${row.macdState ?? "unavailable"}) currently disagrees with the Daily ${dailyRow?.direction} read. Per this project's timeframe rules, this cannot reverse the Daily/Weekly/Monthly conclusion -- it only defers entry.`
              : "Not yet determinable."}
        </li>
        <li>
          <strong>Current intraday structure:</strong> {row.dowState?.replace(/_/g, " ") ?? row.breakoutState?.replace(/_/g, " ") ?? "unavailable"} (recent range{" "}
          {row.support ?? "-"} to {row.resistance ?? "-"}).
        </li>
        <li>
          <strong>Immediate invalidation level:</strong>{" "}
          {row.direction === "bullish" ? (row.support ?? "unavailable") : row.direction === "bearish" ? (row.resistance ?? "unavailable") : "unavailable"}.
        </li>
        <li>
          <strong>Latest candle:</strong>{" "}
          {row.isProvisional
            ? "Still forming -- excluded from this structure read (never treated as close-confirmed)."
            : "Complete and close-confirmed."}
        </li>
      </ul>
    </div>
  );
}
