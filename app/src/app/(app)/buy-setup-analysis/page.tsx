import Link from "next/link";
import { getBuySetupAnalysisPage, BUY_SETUP_PAGE_SIZE, type BuySetupFilters } from "@/lib/data/buy-setup-analysis";
import { getPublishedRunMetadata } from "@/lib/data/run-metadata";
import { getLatestPublishedRun } from "@/lib/data/runs";
import { getCurrentUser, roleAtLeast } from "@/lib/auth";
import { formatIstDateTime } from "@/lib/date-format";
import BuySetupControls from "./BuySetupControls";
import BuySetupTable from "./BuySetupTable";
import RunBuySetupAnalysisButton from "./RunBuySetupAnalysisButton";

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ fontSize: 20, fontWeight: 600 }}>{value}</span>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

function PageLink({ page, disabled, params, children }: { page: number; disabled: boolean; params: URLSearchParams; children: React.ReactNode }) {
  if (disabled) return <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{children}</span>;
  const next = new URLSearchParams(params);
  if (page > 1) next.set("page", String(page));
  else next.delete("page");
  const href = `/buy-setup-analysis${next.toString() ? `?${next.toString()}` : ""}`;
  return (
    <Link href={href} style={{ fontSize: 13 }}>
      {children}
    </Link>
  );
}

export default async function BuySetupAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string; q?: string; monthly?: string; weekly?: string; daily?: string; gate?: string; reversal?: string; status?: string; data?: string;
    minScore?: string; fdata?: string; sort?: string; dir?: string;
  }>;
}) {
  const sp = await searchParams;
  const minScoreParsed = Number(sp.minScore);
  const filters: BuySetupFilters = {
    page: Math.max(1, Number(sp.page) || 1),
    pageSize: BUY_SETUP_PAGE_SIZE,
    query: sp.q ?? "",
    monthlyState: sp.monthly ?? "all",
    weeklyState: sp.weekly ?? "all",
    dailyState: sp.daily ?? "all",
    gate: (sp.gate as BuySetupFilters["gate"]) ?? "all",
    reversal: (sp.reversal as BuySetupFilters["reversal"]) ?? "all",
    overallStatus: sp.status ?? "all",
    dataAvailability: (sp.data as BuySetupFilters["dataAvailability"]) ?? "all",
    minFundamentalScore: sp.minScore && Number.isFinite(minScoreParsed) ? minScoreParsed : undefined,
    fundamentalDataStatus: (sp.fdata as BuySetupFilters["fundamentalDataStatus"]) ?? "all",
    sortBy: (sp.sort as BuySetupFilters["sortBy"]) ?? "symbol",
    sortDirection: (sp.dir as BuySetupFilters["sortDirection"]) ?? "asc",
  };

  const [result, run, user] = await Promise.all([getBuySetupAnalysisPage(filters), getLatestPublishedRun(), getCurrentUser()]);
  const runMetadata = run ? getPublishedRunMetadata(run as unknown as Parameters<typeof getPublishedRunMetadata>[0]) : null;
  const canTrigger = !!user && roleAtLeast(user.role, "researcher");

  const paramsForLinks = new URLSearchParams();
  if (filters.query) paramsForLinks.set("q", filters.query);
  if (filters.monthlyState && filters.monthlyState !== "all") paramsForLinks.set("monthly", filters.monthlyState);
  if (filters.weeklyState && filters.weeklyState !== "all") paramsForLinks.set("weekly", filters.weeklyState);
  if (filters.dailyState && filters.dailyState !== "all") paramsForLinks.set("daily", filters.dailyState);
  if (filters.gate && filters.gate !== "all") paramsForLinks.set("gate", filters.gate);
  if (filters.reversal && filters.reversal !== "all") paramsForLinks.set("reversal", filters.reversal);
  if (filters.overallStatus && filters.overallStatus !== "all") paramsForLinks.set("status", filters.overallStatus);
  if (filters.dataAvailability && filters.dataAvailability !== "all") paramsForLinks.set("data", filters.dataAvailability);
  if (filters.minFundamentalScore != null) paramsForLinks.set("minScore", String(filters.minFundamentalScore));
  if (filters.fundamentalDataStatus && filters.fundamentalDataStatus !== "all") paramsForLinks.set("fdata", filters.fundamentalDataStatus);
  if (filters.sortBy && filters.sortBy !== "symbol") paramsForLinks.set("sort", filters.sortBy);
  if (filters.sortDirection && filters.sortDirection !== "asc") paramsForLinks.set("dir", filters.sortDirection);

  return (
    <div className="page-grid">
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Buy setup analysis</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Requires a stock&apos;s Monthly, Weekly, and Daily Dow structure to each independently be bullish
          (strategies/buy-setup-analysis.yaml -- <strong>user-requested, project-default logic reusing the Buy Signal
          Playbook&apos;s own documented Dow predicate; not itself extracted from the GUE or Buy Signal Playbook
          documents</strong>) before proceeding to a genuine 15-minute Fyers data pull, indicators, GUE wave read, and
          bullish-reversal (RSI/MACD divergence) evidence. See <Link href="/buy-signals">Buy signals</Link> for the
          separate, playbook-derived positional screen.
        </p>
        {run && (
          <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Published run {run.run_date} &middot; run id {run.id.slice(0, 8)} &middot; analysis cutoff{" "}
            {runMetadata?.cutoff ? formatIstDateTime(runMetadata.cutoff) : "not recorded"} &middot; provider fyers &middot; rule v
            {result?.manifest?.ruleVersion ?? "1.0.0"} / parameter v{result?.manifest?.parameterVersion ?? "1.0.0"}.
          </p>
        )}
        <p style={{ fontSize: 12, fontWeight: 600 }}>This page is research evidence only -- it is not an order, a recommendation, or a guarantee of any outcome.</p>
        {canTrigger && run && <RunBuySetupAnalysisButton initialEnrichmentState={result?.manifest?.enrichmentState ?? null} />}
      </div>

      {result?.patternCoverage && (
        <div className="card">
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Detector coverage (which patterns are actually implemented)</summary>
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 0 }}>
              Candlestick patterns implemented: {result.patternCoverage.candlestickImplemented.join(", ") || "none"}; not evaluated (absence is not evidence of no pattern):{" "}
              {result.patternCoverage.candlestickNotEvaluated.join(", ") || "none"}. Chart patterns implemented: {result.patternCoverage.chartPatternImplemented.join(", ") || "none"}; not evaluated:{" "}
              {result.patternCoverage.chartPatternNotEvaluated.join(", ") || "none"}.
            </p>
          </details>
        </div>
      )}

      {!result ? (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
            <SummaryCard label="Total equities evaluated" value={result.summary.totalEquities} />
            <SummaryCard label="Monthly bullish" value={result.summary.monthlyBullish} />
            <SummaryCard label="Weekly bullish" value={result.summary.weeklyBullish} />
            <SummaryCard label="Daily bullish" value={result.summary.dailyBullish} />
            <SummaryCard label="3-timeframe qualified" value={result.summary.threeTimeframeQualified} />
            <SummaryCard label="15-minute analysis completed" value={result.summary.fifteenMinCompleted} />
            <SummaryCard label="Manual review" value={result.summary.manualReview} />
            <SummaryCard label="No data" value={result.summary.noData} />
          </div>

          {result.manifest?.enrichmentState && result.manifest.enrichmentState !== "published" && (
            <div className="card">
              <p style={{ color: "var(--watch)", fontSize: 13 }}>
                15-minute enrichment for this run is <strong>{result.manifest.enrichmentState}</strong>
                {result.manifest.validationErrors.length > 0 ? `: ${result.manifest.validationErrors.join("; ")}` : "."} Monthly/Weekly/Daily gate
                results below are still current (computed during the main screening run); 15-minute columns will read
                NO_DATA until enrichment publishes.
              </p>
            </div>
          )}
          {!result.manifest && (
            <div className="card">
              <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
                15-minute enrichment has not been run yet for this published run. Monthly/Weekly/Daily gate results
                below are current; a Researcher+ user must trigger the buy-setup analysis enrichment separately.
              </p>
            </div>
          )}

          <div className="card">
            <BuySetupControls
              initial={{
                q: filters.query ?? "",
                monthlyState: filters.monthlyState ?? "all",
                weeklyState: filters.weeklyState ?? "all",
                dailyState: filters.dailyState ?? "all",
                gate: filters.gate ?? "all",
                reversal: filters.reversal ?? "all",
                overallStatus: filters.overallStatus ?? "all",
                dataAvailability: filters.dataAvailability ?? "all",
                minFundamentalScore: filters.minFundamentalScore != null ? String(filters.minFundamentalScore) : "",
                fundamentalDataStatus: filters.fundamentalDataStatus ?? "all",
                sortBy: filters.sortBy ?? "symbol",
                sortDirection: filters.sortDirection ?? "asc",
              }}
            />
            <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "8px 0" }}>
              {result.totalCount} stock{result.totalCount === 1 ? "" : "s"} match
              {result.totalCount > 0 ? ` -- page ${result.page} of ${result.pageCount}` : ""}.
            </p>
            <BuySetupTable rows={result.rows} startIndex={(result.page - 1) * result.pageSize} />
            {result.pageCount > 1 && (
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                <PageLink page={result.page - 1} disabled={result.page <= 1} params={paramsForLinks}>
                  &larr; Prev
                </PageLink>
                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  Page {result.page} of {result.pageCount}
                </span>
                <PageLink page={result.page + 1} disabled={result.page >= result.pageCount} params={paramsForLinks}>
                  Next &rarr;
                </PageLink>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
