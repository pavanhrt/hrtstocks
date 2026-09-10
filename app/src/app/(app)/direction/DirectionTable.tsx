"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { StockDirection, DirectionRow } from "@/lib/data/direction";

const BULLISH = new Set(["uptrend_intact", "confirmed_reversal_bullish"]);
const BEARISH = new Set(["downtrend_intact", "confirmed_reversal_bearish"]);

type Confluence = "aligned_bullish" | "aligned_bearish" | "mixed" | "unavailable";

function confluenceOf(row: StockDirection): Confluence {
  const states = (["daily", "weekly", "monthly"] as const).map((tf) => row.timeframes[tf]?.dow_state ?? null);
  if (states.some((s) => s == null)) return "unavailable";
  if (states.every((s) => BULLISH.has(s!))) return "aligned_bullish";
  if (states.every((s) => BEARISH.has(s!))) return "aligned_bearish";
  return "mixed";
}

const CONFLUENCE_LABEL: Record<Confluence, string> = {
  aligned_bullish: "Aligned bullish",
  aligned_bearish: "Aligned bearish",
  mixed: "Mixed",
  unavailable: "Unavailable",
};

const CONFLUENCE_COLOR: Record<Confluence, string> = {
  aligned_bullish: "var(--pass)",
  aligned_bearish: "var(--fail)",
  mixed: "var(--watch)",
  unavailable: "var(--nodata)",
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

export default function DirectionTable({ rows }: { rows: StockDirection[] }) {
  const [query, setQuery] = useState("");
  const [confluenceFilter, setConfluenceFilter] = useState<"all" | Confluence>("all");

  const withConfluence = useMemo(() => rows.map((r) => ({ row: r, confluence: confluenceOf(r) })), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return withConfluence.filter(({ row, confluence }) => {
      if (q) {
        const hay = `${row.instrumentId} ${row.symbol} ${row.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (confluenceFilter !== "all" && confluence !== confluenceFilter) return false;
      return true;
    });
  }, [withConfluence, query, confluenceFilter]);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          placeholder="Search symbol or name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "6px 10px" }}
        />
        <select value={confluenceFilter} onChange={(e) => setConfluenceFilter(e.target.value as typeof confluenceFilter)}>
          <option value="all">All confluence</option>
          <option value="aligned_bullish">Aligned bullish</option>
          <option value="aligned_bearish">Aligned bearish</option>
          <option value="mixed">Mixed</option>
          <option value="unavailable">Unavailable</option>
        </select>
      </div>

      <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "0 0 8px" }}>
        Showing {filtered.length} of {rows.length} stocks. Dow-theory structure and wave labels are best-effort and
        automated -- an "unconfirmed" wave means the last swings did not satisfy GUE&apos;s hard gates, not that no
        pattern exists.
      </p>

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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "var(--text-dim)" }}>
                  No stocks match.
                </td>
              </tr>
            )}
            {filtered.map(({ row, confluence }, i) => (
              <tr key={row.instrumentId}>
                <td>{i + 1}</td>
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
                  <span style={{ color: CONFLUENCE_COLOR[confluence], fontWeight: 600, fontSize: 13 }}>{CONFLUENCE_LABEL[confluence]}</span>
                </td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
