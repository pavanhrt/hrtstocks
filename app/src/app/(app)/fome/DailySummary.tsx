"use client";

import type { FomeTimeframeRow } from "@/lib/data/fome";
import ChartPreview from "../ChartPreview";

/**
 * Daily chart + plain-language summary (trend/structure, support/
 * resistance, target, invalidation, momentum, extended/pullback/breakout).
 * This component only arranges already server-computed fields into labeled
 * bullets -- it never computes a new indicator or threshold itself.
 * "Target" and "invalidation" are the row's own support/resistance read in
 * the trade direction, not a separately-modeled price target.
 */
export default function DailySummary({ row }: { row: FomeTimeframeRow | undefined }) {
  if (!row) return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Daily data is unavailable.</p>;

  const bullish = row.direction === "bullish";
  const bearish = row.direction === "bearish";
  const target = bullish ? row.resistance : bearish ? row.support : null;
  const invalidation = bullish ? row.support : bearish ? row.resistance : null;

  const extension =
    row.bollingerPriceLocation === "at_or_above_upper_band"
      ? "Price is trading at or above the upper Bollinger band -- potentially extended to the upside."
      : row.bollingerPriceLocation === "at_or_below_lower_band"
        ? "Price is trading at or below the lower Bollinger band -- potentially extended to the downside."
        : "Price is inside its Bollinger bands -- not currently extended.";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ChartPreview src={row.chartUrl} alt={`Daily chart -- support ${row.support ?? "unavailable"}, resistance ${row.resistance ?? "unavailable"}`} />
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "grid", gap: 4 }}>
        <li>
          <strong>Trend and structure:</strong> {row.dowState?.replace(/_/g, " ") ?? "unavailable"}
          {row.pivotSequence && row.pivotSequence.length > 0 ? ` (recent pivots: ${row.pivotSequence.join(", ")})` : ""}.
        </li>
        <li>
          <strong>Support:</strong> {row.support ?? "unavailable"} &middot; <strong>Resistance:</strong> {row.resistance ?? "unavailable"}.
        </li>
        <li>
          <strong>Target:</strong> {target ?? "not determinable from the current structure"} (the {bullish ? "resistance" : bearish ? "support" : "opposite"}{" "}
          level in the {row.direction ?? "current"} direction -- a conservative reference, not a guarantee).
        </li>
        <li>
          <strong>Invalidation:</strong> {invalidation ?? "not determinable from the current structure"} (a close beyond this level would contradict the current
          read).
        </li>
        <li>
          <strong>Momentum:</strong> MACD {row.macdState ?? "unavailable"}, RSI {row.rsi?.toFixed(1) ?? "-"}, ADX {row.adx?.toFixed(1) ?? "-"}
          {row.adxSlope ? ` (${row.adxSlope})` : ""}.
        </li>
        <li>{extension}</li>
        {row.breakoutState && row.breakoutState !== "none" && (
          <li>
            <strong>Breakout/breakdown:</strong> {row.breakoutState.replace(/_/g, " ")}.
          </li>
        )}
      </ul>
    </div>
  );
}
