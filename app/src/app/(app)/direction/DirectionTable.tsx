import Link from "next/link";
import type { StockDirection, DirectionRow, FinalAlignment } from "@/lib/data/direction";
import ChartPreview from "../ChartPreview";
import { Badge } from "../Badge";

const BULLISH = new Set(["uptrend_intact", "confirmed_reversal_bullish"]);
const BEARISH = new Set(["downtrend_intact", "confirmed_reversal_bearish"]);

const CONFLUENCE_LABEL: Record<FinalAlignment, string> = {
  ALIGNED_BULLISH: "Aligned bullish",
  ALIGNED_BEARISH: "Aligned bearish",
  SIDEWAYS: "Sideways",
  MIXED: "Mixed",
  MANUAL_REVIEW: "Manual review",
  UNAVAILABLE: "Unavailable",
};

const CONFLUENCE_COLOR: Record<FinalAlignment, string> = {
  ALIGNED_BULLISH: "var(--pass)",
  ALIGNED_BEARISH: "var(--fail)",
  SIDEWAYS: "var(--watch)",
  MIXED: "var(--watch)",
  MANUAL_REVIEW: "var(--manual)",
  UNAVAILABLE: "var(--nodata)",
};

function dowStateColor(state: string | null | undefined): string {
  if (!state) return "var(--nodata)";
  if (BULLISH.has(state)) return "var(--pass)";
  if (BEARISH.has(state)) return "var(--fail)";
  if (state === "sideways") return "var(--watch)";
  return "var(--nodata)";
}

function TimeframeCell({ row, url }: { row: DirectionRow | null; url: string | null }) {
  if (!row) {
    return <span style={{ color: "var(--nodata)", fontSize: 12 }}>Unavailable</span>;
  }
  return (
    <div className="direction-timeframe">
      <ChartPreview src={url} alt={`${row.instrument_id} ${row.timeframe} direction chart`} compact />
      <span style={{ fontSize: 12, color: dowStateColor(row.dow_state), fontWeight: 600 }}>{(row.dow_state ?? "unknown").replace(/_/g, " ")}</span>
      <span style={{ fontSize: 11, color: row.wave?.confidence === "confirmed" ? "var(--pass)" : "var(--text-dim)" }}>
        {row.wave
          ? `${row.wave.structureType} · wave ${row.wave.currentWave} (${row.wave.state}, ${row.wave.confidence})`
          : "Wave: unconfirmed"}
      </span>
      {row.wave?.invalidationPrice != null && <span className="supporting-text">Flip/invalidation: {row.wave.invalidationPrice}</span>}
    </div>
  );
}

function PatternCell({ row }: { row: StockDirection }) {
  if (row.patterns.length === 0) return <span className="supporting-text">No active break recorded</span>;
  return (
    <ul className="compact-list">
      {row.patterns.slice(0, 4).map((pattern, index) => (
        <li key={`${pattern.name}-${pattern.timeframe}-${index}`}>
          <span className={`direction-marker ${pattern.direction}`}>{pattern.direction === "bullish" ? "▲" : "▼"}</span>{" "}
          {pattern.name} · {pattern.timeframe} · {pattern.state.toLowerCase()}
        </li>
      ))}
    </ul>
  );
}

/**
 * Purely presentational -- the page this renders inside already did the
 * search/filter/pagination server-side (lib/data/direction.ts's
 * getDirectionPage), so `rows` is exactly what should be shown, in order.
 * finalAlignment is read straight off each row (computed server-side by
 * features/alignment.js), never re-derived here.
 */
export default function DirectionTable({ rows, startIndex = 0 }: { rows: StockDirection[]; startIndex?: number }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Direction results; scroll horizontally for all columns">
      <table>
        <caption className="sr-only">Monthly, weekly and daily direction evidence for the published equity universe</caption>
        <thead>
          <tr>
            <th>S.No</th>
            <th>Stock</th>
            <th>Monthly</th>
            <th>Weekly</th>
            <th>Daily</th>
            <th>Confluence</th>
            <th>Pattern breaks</th>
            <th>Evidence</th>
            <th>Data status</th>
            <th>Run cutoff</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} style={{ color: "var(--text-dim)" }}>
                No stocks match.
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.instrumentId}>
              <td>{startIndex + i + 1}</td>
              <td>
                <Link href={`/stocks/${row.instrumentId}`}>{row.symbol}</Link>
                {row.name && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{row.name}</div>}
              </td>
              <td>
                <TimeframeCell row={row.timeframes.monthly} url={row.chartUrls.monthly} />
              </td>
              <td>
                <TimeframeCell row={row.timeframes.weekly} url={row.chartUrls.weekly} />
              </td>
              <td>
                <TimeframeCell row={row.timeframes.daily} url={row.chartUrls.daily} />
              </td>
              <td>
                <span style={{ color: CONFLUENCE_COLOR[row.finalAlignment], fontWeight: 600, fontSize: 13 }}>
                  {CONFLUENCE_LABEL[row.finalAlignment]}
                </span>
              </td>
              <td><PatternCell row={row} /></td>
              <td className="supporting-text">
                {row.updatedAt ? `Computed ${new Date(row.updatedAt).toLocaleString("en-IN")}` : "No direction evidence recorded"}
              </td>
              <td><Badge status={row.dataStatus} /></td>
              <td className="supporting-text">{row.runCutoff ? new Date(row.runCutoff).toLocaleString("en-IN") : "Not recorded"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
