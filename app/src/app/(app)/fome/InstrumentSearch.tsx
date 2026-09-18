"use client";

import { useEffect, useRef, useState } from "react";
import type { InstrumentSearchResult } from "@/lib/data/fome";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Symbol/name/id autocomplete. Debounced and only ever calls this app's own
 * /api/instruments/search route (a plain DB query) -- never a market-data
 * provider.
 */
export default function InstrumentSearch({ onSelect }: { onSelect: (instrument: InstrumentSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function onChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length === 0) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(value)}`);
        const body = await res.json();
        setResults(body.results ?? []);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <div ref={containerRef} style={{ position: "relative", maxWidth: 480 }}>
      <input
        aria-label="Search NSE stocks and indexes"
        placeholder="Search by symbol, name, or instrument id (e.g. RELIANCE, NIFTY 50)..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        style={{ width: "100%", padding: "10px 12px", fontSize: 15 }}
      />
      {open && (
        <div
          className="card"
          style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, maxHeight: 320, overflowY: "auto", padding: 4 }}
        >
          {loading && <div style={{ padding: 8, fontSize: 13, color: "var(--text-dim)" }}>Searching...</div>}
          {!loading && results.length === 0 && <div style={{ padding: 8, fontSize: 13, color: "var(--text-dim)" }}>No matches.</div>}
          {!loading &&
            results.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  onSelect(r);
                  setQuery(`${r.symbol}${r.name ? ` -- ${r.name}` : ""}`);
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                <strong>{r.symbol}</strong>
                {r.name ? <span style={{ color: "var(--text-dim)" }}> -- {r.name}</span> : null}
                <span style={{ float: "right", fontSize: 11, color: "var(--text-dim)" }}>{r.isIndex ? "Index" : "Stock"} · {r.exchange}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
