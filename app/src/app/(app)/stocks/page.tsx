import Link from "next/link";
import { getLatestPublishedRun, getStockLedgerPage } from "@/lib/data/runs";
import StockLedgerTable from "./StockLedgerTable";

export default async function StocksPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string; tier?: string; state?: string }> }) {
  const params = await searchParams;
  const run = await getLatestPublishedRun();
  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Complete stock ledger</h1>
        <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
      </div>
    );
  }

  const page = Math.max(1, Number(params.page) || 1);
  const query = params.q ?? "";
  const tier = params.tier ?? "all";
  const state = params.state ?? "all";
  const result = await getStockLedgerPage(run.id, { page, query, tier, state });
  const pageHref = (nextPage: number) => {
    const next = new URLSearchParams();
    if (nextPage > 1) next.set("page", String(nextPage));
    if (query) next.set("q", query);
    if (tier !== "all") next.set("tier", tier);
    if (state !== "all") next.set("state", state);
    return `/stocks${next.size ? `?${next}` : ""}`;
  };

  return (
    <div className="page-grid">
      <h1 style={{ margin: 0, fontSize: 20 }}>Complete stock ledger &mdash; {run.run_date}</h1>
      <StockLedgerTable rows={result.rows as never[]} runId={run.id} query={query} tier={tier} state={state} totalCount={result.totalCount} universeCount={result.universeCount} />
      {result.pageCount > 1 && <nav className="pagination" aria-label="Stock ledger pages">
        {result.page > 1 ? <Link href={pageHref(result.page - 1)}>← Previous</Link> : <span className="disabled-link">← Previous</span>}
        <span>Page {result.page} of {result.pageCount}</span>
        {result.page < result.pageCount ? <Link href={pageHref(result.page + 1)}>Next →</Link> : <span className="disabled-link">Next →</span>}
      </nav>}
    </div>
  );
}
