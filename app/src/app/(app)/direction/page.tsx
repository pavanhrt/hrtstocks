import Link from "next/link";
import { getDirectionPage, FINAL_ALIGNMENT_VALUES, type FinalAlignment } from "@/lib/data/direction";
import DirectionTable from "./DirectionTable";
import DirectionControls from "./DirectionControls";

function isFinalAlignment(v: string): v is FinalAlignment {
  return (FINAL_ALIGNMENT_VALUES as readonly string[]).includes(v);
}

function PageLink({
  page,
  disabled,
  query,
  alignment,
  children,
}: {
  page: number;
  disabled: boolean;
  query: string;
  alignment: FinalAlignment | "all";
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{children}</span>;
  }
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (query) params.set("q", query);
  if (alignment !== "all") params.set("alignment", alignment);
  const href = `/direction${params.toString() ? `?${params.toString()}` : ""}`;
  return (
    <Link href={href} style={{ fontSize: 13 }}>
      {children}
    </Link>
  );
}

export default async function DirectionPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; alignment?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const query = sp.q ?? "";
  const alignment: FinalAlignment | "all" = sp.alignment && isFinalAlignment(sp.alignment) ? sp.alignment : "all";

  const result = await getDirectionPage({ page, query, alignment });
  const isFiltered = query.trim().length > 0 || alignment !== "all";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Direction</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Monthly, weekly, and daily Dow-theory swing structure (HH/HL/LH/LL) for every stock, with a best-effort
          Elliott-wave label where the last swings validate against GUE&apos;s documented hard gates. Confluence is
          computed server-side (features/alignment.js, combining all three timeframes plus pattern evidence) --
          never re-derived in the browser. Charts are replaced in place on each run; if the underlying structure
          hasn&apos;t changed, the existing chart is kept rather than re-rendered.
        </p>
      </div>

      {!result ? (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
        </div>
      ) : result.totalCount === 0 && !isFiltered ? (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>
            No direction data yet for run {result.runDate} -- it is populated once market data is flowing for at
            least one stock.
          </p>
        </div>
      ) : (
        <div className="card">
          <DirectionControls initialQuery={query} initialAlignment={alignment} />
          <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "0 0 8px" }}>
            Run {result.runDate} &middot; {result.totalCount} stock{result.totalCount === 1 ? "" : "s"} match
            {result.totalCount > 0 ? ` -- page ${result.page} of ${result.pageCount}` : ""}.
          </p>
          <DirectionTable rows={result.rows} startIndex={(result.page - 1) * result.pageSize} />
          {result.pageCount > 1 && (
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
              <PageLink page={result.page - 1} disabled={result.page <= 1} query={query} alignment={alignment}>
                &larr; Prev
              </PageLink>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Page {result.page} of {result.pageCount}
              </span>
              <PageLink page={result.page + 1} disabled={result.page >= result.pageCount} query={query} alignment={alignment}>
                Next &rarr;
              </PageLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
