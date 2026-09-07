import Link from "next/link";
import { getLatestRun, getStockLedger } from "@/lib/data/runs";
import { fetchNewsArticles } from "@/lib/news/rss";
import { matchArticlesToLedger, type LedgerInstrument } from "@/lib/news/match";
import { NEWS_FEEDS } from "@/lib/news/feeds";

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function NewsPage() {
  const run = await getLatestRun();
  const ledgerRows = run ? await getStockLedger(run.id) : [];

  const instruments: LedgerInstrument[] = ledgerRows.map((r: any) => ({
    instrumentId: r.instrument_id,
    symbol: r.instruments?.symbol ?? r.instrument_id,
    name: r.instruments?.name ?? null,
  }));

  let matched: ReturnType<typeof matchArticlesToLedger> = [];
  let fetchError: string | null = null;
  try {
    const articles = await fetchNewsArticles();
    matched = matchArticlesToLedger(articles, instruments);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Failed to load news";
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Latest stock news</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Headlines and snippets pulled live from public RSS feeds ({NEWS_FEEDS.map((f) => f.source).join(", ")}),
          filtered to stocks in the current ledger by a heuristic symbol/name match &mdash; not a verified tag.
          Always check the source article; this is supplementary context, not a screened result.
        </p>
      </div>

      {instruments.length === 0 && (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>
            The stock ledger is empty (no completed run with results yet), so there is nothing to match news
            against. See <Link href="/data-health">Data health</Link> for why.
          </p>
        </div>
      )}

      {fetchError && (
        <div className="card" style={{ borderColor: "var(--fail)" }}>
          <p style={{ color: "var(--fail)", fontSize: 13 }}>Could not load news feeds: {fetchError}</p>
        </div>
      )}

      {instruments.length > 0 && !fetchError && (
        <div className="card">
          {matched.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
              No recent headlines matched a stock in the current ledger.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {matched.map((article, i) => (
                <div key={i} style={{ borderBottom: "1px solid var(--panel-border)", paddingBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    {article.matchedInstruments.map((inst) => (
                      <Link key={inst.instrumentId} href={`/stocks/${inst.instrumentId}`} className="badge badge-PASS">
                        {inst.symbol}
                      </Link>
                    ))}
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                      {article.source} &middot; {timeAgo(article.publishedAt)}
                    </span>
                  </div>
                  <a
                    href={article.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontWeight: 600, display: "block", margin: "4px 0" }}
                  >
                    {article.title}
                  </a>
                  {article.snippet && (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)" }}>{article.snippet}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
