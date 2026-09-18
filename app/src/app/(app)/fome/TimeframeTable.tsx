"use client";

import type { FomeTimeframeRow } from "@/lib/data/fome";

const TIMEFRAME_ORDER: FomeTimeframeRow["timeframe"][] = ["monthly", "weekly", "daily", "15m"];
const TIMEFRAME_LABEL: Record<string, string> = { monthly: "Monthly", weekly: "Weekly", daily: "Daily", "15m": "15-minute" };

function fmt(n: number | null | undefined, digits = 2) {
  return n == null ? "-" : n.toFixed(digits);
}

/** The Monthly/Weekly/Daily/15-minute direction table. Formats only -- every value is read directly from the server-computed row. */
export default function TimeframeTable({ timeframes }: { timeframes: Record<string, FomeTimeframeRow> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Timeframe</th>
            <th>Latest candle</th>
            <th>Freshness</th>
            <th>Dow/price structure</th>
            <th>Pivots</th>
            <th>MACD</th>
            <th>RSI</th>
            <th>ADX (slope)</th>
            <th>Bollinger</th>
            <th>Support</th>
            <th>Resistance</th>
            <th>Breakout</th>
            <th>Direction</th>
            <th>Confidence</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {TIMEFRAME_ORDER.map((tf) => {
            const row = timeframes[tf];
            if (!row) {
              return (
                <tr key={tf}>
                  <td>{TIMEFRAME_LABEL[tf]}</td>
                  <td colSpan={13} style={{ color: "var(--text-dim)" }}>
                    Unavailable
                  </td>
                </tr>
              );
            }
            return (
              <tr key={tf}>
                <td>{TIMEFRAME_LABEL[tf]}</td>
                <td style={{ fontSize: 12 }}>
                  {row.isProvisional ? (
                    <span title="Latest candle is still forming -- excluded from close-confirmed structure">PROVISIONAL</span>
                  ) : row.latestCompletedCandleAt ? (
                    new Date(row.latestCompletedCandleAt).toLocaleString()
                  ) : (
                    "-"
                  )}
                </td>
                <td>{row.freshness ?? "-"}</td>
                <td>{row.dowState?.replace(/_/g, " ") ?? "-"}</td>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{row.pivotSequence?.join(" ") ?? "-"}</td>
                <td>{row.macdState ?? "-"}</td>
                <td>{fmt(row.rsi, 1)}</td>
                <td>
                  {fmt(row.adx, 1)} {row.adxSlope ? `(${row.adxSlope})` : ""}
                </td>
                <td>
                  {row.bollingerState ?? "-"}
                  {row.bollingerPriceLocation ? ` / ${row.bollingerPriceLocation.replace(/_/g, " ")}` : ""}
                </td>
                <td>{fmt(row.support)}</td>
                <td>{fmt(row.resistance)}</td>
                <td>{row.breakoutState?.replace(/_/g, " ") ?? "-"}</td>
                <td style={{ fontWeight: 600 }}>{row.direction ?? "-"}</td>
                <td>{row.confidence}</td>
                <td style={{ fontSize: 12, maxWidth: 320 }}>
                  {row.explanation}
                  {row.reusedFromRunId && <div style={{ color: "var(--text-dim)" }}>(reused from a prior analysis)</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
