"use client";

import type { FomeNewsItem } from "@/lib/data/fome";

const RELEVANCE_LABEL: Record<string, string> = { supportive: "Supportive", opposing: "Opposing", neutral: "Neutral", uncertain: "Uncertain" };
const RUN_RELEVANCE_LABEL: Record<string, string> = {
  SUPPORTS_TECHNICAL_TREND: "News supports the technical trend",
  OPPOSES_TECHNICAL_TREND: "News opposes the technical trend -- treat as an event-risk warning",
  MIXED_NEWS: "Mixed news -- some supportive, some opposing",
  NO_MATERIAL_NEWS: "No material recent news found",
  NEWS_UNAVAILABLE: "News could not be retrieved",
};

/** Recent news + technical-trend relevance. News never overrides the deterministic technical/FOME result. */
export default function NewsPanel({ newsRelevance, items }: { newsRelevance: string | null; items: FomeNewsItem[] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{newsRelevance ? (RUN_RELEVANCE_LABEL[newsRelevance] ?? newsRelevance) : "Retrieving news..."}</div>
      {items.length === 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No instrument-specific news matched within the lookback window.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
          {items.map((n) => (
            <li key={n.id} style={{ borderBottom: "1px solid var(--panel-border)", paddingBottom: 8 }}>
              <a href={n.url ?? undefined} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                {n.headline}
              </a>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {n.source ?? "Unknown source"}
                {n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleString()}` : ""}
                {n.eventCategory ? ` · ${n.eventCategory.replace(/_/g, " ")}` : ""}
              </div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {RELEVANCE_LABEL[n.relevance ?? ""] ?? n.relevance ?? "-"} ({n.confidence ?? "low"} confidence)
              </div>
              {n.explanation && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{n.explanation}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
