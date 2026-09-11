"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "../Badge";

type LedgerRow = {
  id: number;
  instrument_id: string;
  terminal_state: string;
  tier: string | null;
  direction: string | null;
  score: number | null;
  data_quality: string | null;
  failed_gates: string[];
  instruments: { symbol: string; name: string | null } | null;
};

export default function StockLedgerTable({ rows, runId }: { rows: LedgerRow[]; runId: string }) {
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.instrument_id} ${r.instruments?.symbol ?? ""} ${r.instruments?.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (tierFilter !== "all" && (r.tier ?? "unclassified") !== tierFilter) return false;
      if (stateFilter !== "all" && r.terminal_state !== stateFilter) return false;
      return true;
    });
  }, [rows, query, tierFilter, stateFilter]);

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          aria-label="Search symbol or name"
          placeholder="Search symbol or name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "6px 10px" }}
        />
        <select aria-label="Filter by tier" value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
          <option value="all">All tiers</option>
          <option value="tier_a">Tier A</option>
          <option value="tier_b">Tier B</option>
          <option value="watch">Watch</option>
          <option value="manual_review">Manual review</option>
          <option value="rejected">Rejected</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <select aria-label="Filter by result" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="all">All results</option>
          <option value="PASS">PASS</option>
          <option value="WATCH">WATCH</option>
          <option value="MANUAL_REVIEW">MANUAL_REVIEW</option>
          <option value="FAIL">FAIL</option>
          <option value="NO_DATA">NO_DATA</option>
        </select>
        <a href={`/api/export/stocks?runId=${runId}`} style={{ marginLeft: "auto" }}>
          Export CSV
        </a>
      </div>

      <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "0 0 8px" }}>
        Showing {filtered.length} of {rows.length} unique constituents.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th>Result</th>
              <th>Tier</th>
              <th>Direction</th>
              <th>Score</th>
              <th>Data quality</th>
              <th>Failed gates</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/stocks/${r.instrument_id}`}>{r.instruments?.symbol ?? r.instrument_id}</Link>
                </td>
                <td>{r.instruments?.name ?? "-"}</td>
                <td>
                  <Badge status={r.terminal_state} />
                </td>
                <td>{r.tier ?? "-"}</td>
                <td>{r.direction ?? "-"}</td>
                <td>{r.score ?? "-"}</td>
                <td>{r.data_quality ?? "-"}</td>
                <td style={{ fontSize: 12, color: "var(--text-dim)" }}>{r.failed_gates?.join(", ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
