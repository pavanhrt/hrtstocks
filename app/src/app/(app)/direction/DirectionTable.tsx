import Link from "next/link";
import type { StockDirection, DirectionRow, FinalAlignment } from "@/lib/data/direction";

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
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 150 }}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={`${row.instrument_id} ${row.timeframe} chart`} width={150} height={75} style={{ borderRadius: 4, border: "1px solid var(--panel-border)", objectFit: "cover" }} />
        </a>
      ) : (
        <div style={{ width: 150, height: 75, borderRadius: 4, background: "var(--panel-border)" }} />
      )}
      <span style={{ fontSize: 12, color: dowStateColor(row.dow_state), fontWeight: 600 }}>{(row.dow_state ?? "unknown").replace(/_/g, " ")}</span>
      <span style={{ fontSize: 11, color: row.wave_confidence === "confirmed" ? "var(--pass)" : "var(--text-dim)" }}>
        {row.wave_label ? row.wave_label : "Wave: unconfirmed"}
      </span>
    </div>
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
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>S.No</th>
            <th>Stock</th>
            <th>Monthly</th>
            <th>Weekly</th>
            <th>Daily</th>
            <th>Confluence</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "var(--text-dim)" }}>
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
              <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
