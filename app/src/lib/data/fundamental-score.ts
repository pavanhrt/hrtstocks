import { currentViewer } from "../access.ts";
import { getDb } from "../db/pool.ts";
import { isStaff } from "../db/visibility.ts";
import { getLatestPublishedRun } from "./runs.ts";

// Fundamental Analysis Score detail -- a completely independent research
// overlay (fundamentals/fundamental-score.yaml, PROJECT_DEFAULT). This file
// has no import relationship with buy-setup-analysis.ts's technical
// condition table and must never be merged into it -- see that file's own
// getBuySetupInstrumentDetail(), which renders the technical condition table
// on its own, and page.tsx, which renders this section separately.
//
// Historical score pinning (migration 0014, correction 1): this looks up the
// SAME immutable buy_setup_fundamental_score_bindings row the main table's
// buy_setup_analysis_ledger view joins against -- never its own independent
// "latest cutoff" query. That guarantees the main table and this detail
// page can never disagree about which fundamental result applies to the
// current published run, and that neither a later filing nor a later score
// version can retroactively change what's shown here.

export type FundamentalSubMetricEvidence = {
  key: string;
  weight: number;
  applicable: boolean;
  earned: number;
  status: "OK" | "NOT_APPLICABLE" | "NO_DATA" | "MANUAL_REVIEW";
  value: number | null;
  raw: unknown;
  explanation: string;
};

export type FundamentalComponentEvidence = {
  key: string;
  name: string;
  weight: number;
  totalApplicableWeight: number;
  earned: number;
  status: "OK" | "NOT_APPLICABLE" | "NO_DATA" | "MANUAL_REVIEW";
  subMetrics: FundamentalSubMetricEvidence[];
};

export type FundamentalScoreDetail = {
  scoreVersion: string;
  sectorModel: string;
  asOf: string;
  totalScore: number | null;
  grade: string | null;
  coveragePercentage: number;
  terminalStatus: "SCORED" | "NO_DATA" | "MANUAL_REVIEW" | "NOT_APPLICABLE";
  computedAt: string;
  components: FundamentalComponentEvidence[];
};

type AnyRow = Record<string, unknown>;

/**
 * Returns null when no fundamental score exists yet for this instrument as
 * of the current published run's cutoff -- rendered as a plain NO_DATA
 * section by the caller, never fabricated.
 */
export async function getFundamentalScoreDetail(instrumentId: string): Promise<FundamentalScoreDetail | null> {
  const run = await getLatestPublishedRun();
  if (!run) return null;
  const viewer = await currentViewer();
  const staff = isStaff(viewer);
  const db = getDb();

  // Look up the immutable binding for THIS run/instrument -- not an
  // independent "latest cutoff" query -- so this can never disagree with
  // buy_setup_analysis_ledger's own join. Visibility (former RLS): the bound
  // result must belong to a published refresh manifest unless the viewer is staff.
  const resultRow = await db.one<AnyRow>(
    `select r.*
       from buy_setup_fundamental_score_bindings b
       join fundamental_score_results r on r.id = b.fundamental_score_result_id
       left join fundamental_refresh_manifests m on m.id = r.refresh_manifest_id
      where b.run_id = $1 and b.instrument_id = $2
        and ($3::boolean or m.refresh_state = 'published')`,
    [run.id, instrumentId, staff],
  );
  // No binding for this run/instrument (or not visible to this viewer) --
  // genuine NO_DATA, not an error.
  if (!resultRow) return null;
  const result = resultRow;

  const componentRows = await db.query<AnyRow>(
    `select * from fundamental_score_components where score_result_id = $1`,
    [result.id as number],
  );

  const components: FundamentalComponentEvidence[] = componentRows.map((c) => ({
    key: c.component_key as string,
    name: c.component_name as string,
    weight: c.weight as number,
    totalApplicableWeight: c.total_applicable_weight as number,
    earned: c.earned as number,
    status: c.status as FundamentalComponentEvidence["status"],
    subMetrics: (c.sub_metrics as FundamentalSubMetricEvidence[] | null) ?? [],
  }));

  return {
    // Denormalized directly on the result row (migration 0014, correction
    // 3) -- never a second query against fundamental_score_versions, which
    // is Researcher+-only and would silently return nothing for a Viewer.
    scoreVersion: result.score_version as string,
    sectorModel: result.sector_model as string,
    asOf: result.cutoff_at as string,
    totalScore: (result.total_score as number | null) ?? null,
    grade: (result.grade as string | null) ?? null,
    coveragePercentage: result.coverage_percentage as number,
    terminalStatus: result.terminal_status as FundamentalScoreDetail["terminalStatus"],
    computedAt: result.computed_at as string,
    components,
  };
}
