"use client";

import { useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { FINAL_ALIGNMENT_VALUES, type FinalAlignment } from "@/lib/data/direction-shared";

const ALIGNMENT_LABEL: Record<FinalAlignment, string> = {
  ALIGNED_BULLISH: "Aligned bullish",
  ALIGNED_BEARISH: "Aligned bearish",
  SIDEWAYS: "Sideways",
  MIXED: "Mixed",
  MANUAL_REVIEW: "Manual review",
  UNAVAILABLE: "Unavailable",
};

const SEARCH_DEBOUNCE_MS = 400;

/**
 * Search + confluence filter, both driving the URL (?q=&alignment=) rather
 * than local table state -- the page this lives on reruns
 * getDirectionPage() server-side on navigation, so filtering always sees
 * the full dataset (via the DB query), not just whatever page is currently
 * loaded client-side. Any change resets ?page (dropped from the URL
 * entirely), since a stale page number from a wider result set could
 * otherwise land past the end of a narrower one.
 */
export default function DirectionControls({
  initialQuery,
  initialAlignment,
}: {
  initialQuery: string;
  initialAlignment: FinalAlignment | "all";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(next: { q: string; alignment: FinalAlignment | "all" }) {
    const params = new URLSearchParams();
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.alignment !== "all") params.set("alignment", next.alignment);
    router.push(params.toString() ? `${pathname}?${params.toString()}` : pathname);
  }

  function onQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => navigate({ q: value, alignment: initialAlignment }), SEARCH_DEBOUNCE_MS);
  }

  function onAlignmentChange(value: string) {
    navigate({ q: query, alignment: value as FinalAlignment | "all" });
  }

  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
      <input
        aria-label="Search symbol or name"
        placeholder="Search symbol or name..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        style={{ flex: 1, minWidth: 200, padding: "6px 10px" }}
      />
      <select aria-label="Filter by confluence" value={initialAlignment} onChange={(e) => onAlignmentChange(e.target.value)}>
        <option value="all">All confluence</option>
        {FINAL_ALIGNMENT_VALUES.map((v) => (
          <option key={v} value={v}>
            {ALIGNMENT_LABEL[v]}
          </option>
        ))}
      </select>
    </div>
  );
}
