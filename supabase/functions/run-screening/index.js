// run-screening Edge Function -- the orchestrator described in
// references/technical-architecture.md's "Job sequence":
//   universe -> ingest -> validate -> features -> rule evaluation ->
//   ranking -> coverage reconciliation -> persist -> (publish only if
//   reconciled).
//
// Invoked either by pg_cron on the EOD schedule, or by the Next.js
// POST /api/screening-runs route (Researcher+ only) -- both call this URL
// with the service role key as a Bearer token, which is also this
// function's own auth check below.
//
// NOTE: written and unit-tested at the module level under Node (see the
// sibling *.test.js files, run via `npm test` from stock-platform/), but
// this entrypoint itself requires the Deno runtime (Deno.serve, npm: import
// specifiers).
//
// Data sources (as of 2026-09-07): index constituent lists come from NSE's
// static archive CSVs (providers/nse-archives.js); OHLCV comes from Fyers'
// licensed data API (providers/fyers.js). The original all-in-one NSE public
// endpoint scraper (providers/nse-public.js) is retired from this pipeline --
// its interactive API blocked Supabase's egress IPs with a 403 on every
// index, confirmed via a real deployed run (see pipeline_audit_log for run
// 8b6cb557-a990-4b72-8ba5-d8f99ea2dece). The file is kept for reference/in
// case a future environment isn't blocked, but nothing here imports it.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchIndexConstituents } from "./providers/nse-archives.js";
import { fetchOHLCV } from "./providers/fyers.js";
import { validateBars } from "./quality.js";
import { buildFeatureContext } from "./features/context.js";
import { evaluateRules } from "./rules/evaluate.js";
import { classify, scoreComponents, rankWithinTiers } from "./rank.js";
import { reconcileCoverage } from "./reconcile.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const INDEX_IDS = ["nifty-50", "nifty-bank", "nifty-100", "nifty-500"];
const UNIVERSE_VERSION = "1.0.0";
const OHLCV_LOOKBACK_DAYS = 400;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json().catch(() => ({}));
  const triggerType = body.trigger_type === "scheduled" ? "scheduled" : "manual";
  const triggeredBy = body.triggered_by ?? null;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const runId = crypto.randomUUID();
  const runDate = new Date().toISOString().slice(0, 10);

  const { data: parameterVersion } = await supabase
    .from("parameter_versions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const parameterValues = flattenParameters(parameterVersion?.values ?? {});

  const { data: strategyVersions } = await supabase
    .from("strategy_versions")
    .select("id, framework")
    .eq("is_active", true);

  const strategyVersionIds = (strategyVersions ?? []).map((v) => v.id);
  const { data: ruleDefinitions } = strategyVersionIds.length
    ? await supabase.from("rule_definitions").select("*").in("strategy_version_id", strategyVersionIds)
    : { data: [] };

  const ruleDirectionById = Object.fromEntries((ruleDefinitions ?? []).map((r) => [r.rule_id, r.direction]));

  await supabase.from("screening_runs").insert({
    id: runId,
    run_date: runDate,
    mode: "EOD",
    status: "running",
    universe_version: UNIVERSE_VERSION,
    parameter_version_id: parameterVersion?.id ?? null,
    strategy_version_ids: strategyVersionIds,
    providers: { universe: "nse_archives", ohlcv: "fyers" },
    trigger_type: triggerType,
    triggered_by: triggeredBy,
    started_at: new Date().toISOString(),
  });
  await logStage(supabase, runId, "start", "ok", `Run started (${triggerType})`);

  try {
    const membership = await buildUniverse(supabase, runId, runDate);
    const allInstruments = [
      ...INDEX_IDS.map((id) => ({ instrumentId: id, symbol: id, isIndex: true })),
      ...[...membership.entries()].map(([id, m]) => ({ instrumentId: id, symbol: m.symbol, isIndex: false })),
    ];
    await logStage(
      supabase,
      runId,
      "universe",
      "ok",
      `${INDEX_IDS.length} indexes, ${membership.size} unique constituents`
    );

    const stockResults = [];
    const rankingInputs = [];

    for (const instrument of allInstruments) {
      const { resultRow, componentScores } = await evaluateInstrument({
        supabase,
        runId,
        instrument,
        ruleDefinitions: ruleDefinitions ?? [],
        parameterValues,
        ruleDirectionById,
      });

      if (!instrument.isIndex) stockResults.push(resultRow);
      // Indexes are contextual evidence, never ranked candidates (AGENTS.md).
      if (!instrument.isIndex && (resultRow.tier === "tier_a" || resultRow.tier === "tier_b")) {
        rankingInputs.push({
          instrumentId: instrument.instrumentId,
          direction: resultRow.direction,
          tier: resultRow.tier,
          score: resultRow.score ?? 0,
          componentScores,
        });
      }
    }

    const ranked = rankWithinTiers(rankingInputs);
    if (ranked.length > 0) {
      await supabase.from("rankings").insert(
        ranked.map((r) => ({
          run_id: runId,
          instrument_id: r.instrumentId,
          direction: r.direction,
          tier: r.tier,
          total_score: r.score,
          component_scores: r.componentScores,
          rank_within_tier: r.rankWithinTier,
        }))
      );
    }

    const coverage = reconcileCoverage(stockResults);
    await supabase.from("coverage_reconciliation").insert({ run_id: runId, ...coverage });

    // shared-gates.yaml: publish_when_false is false -- a run that doesn't
    // reconcile is marked partial, never completed, so Viewers (who only see
    // completed runs per RLS) never see an inconsistent ledger.
    await supabase
      .from("screening_runs")
      .update({
        status: coverage.reconciled ? "completed" : "partial",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    await logStage(
      supabase,
      runId,
      "complete",
      coverage.reconciled ? "ok" : "warning",
      `unique_stock_count=${coverage.unique_stock_count} reconciled=${coverage.reconciled}`
    );

    return json({ runId, status: coverage.reconciled ? "completed" : "partial", coverage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logStage(supabase, runId, "error", "failed", message);
    await supabase
      .from("screening_runs")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("id", runId);
    return json({ runId, status: "failed", error: message }, 500);
  }
});

async function buildUniverse(supabase, runId, runDate) {
  const membership = new Map(); // instrumentId -> { symbol, name, indexIds: Set }

  for (const indexId of INDEX_IDS) {
    try {
      const { data: constituents } = await fetchIndexConstituents(indexId);
      for (const c of constituents) {
        if (!membership.has(c.instrumentId)) {
          membership.set(c.instrumentId, { symbol: c.symbol, name: c.name, indexIds: new Set() });
        }
        membership.get(c.instrumentId).indexIds.add(indexId);
      }
    } catch (err) {
      await logStage(supabase, runId, "universe", "warning", `${indexId} constituent fetch failed: ${err.message}`);
    }
  }

  const instrumentRows = [
    ...INDEX_IDS.map((id) => ({ id, symbol: id, name: id, exchange: "NSE", is_index: true })),
    ...[...membership.entries()].map(([id, m]) => ({
      id,
      symbol: m.symbol,
      name: m.name,
      exchange: "NSE",
      is_index: false,
    })),
  ];
  if (instrumentRows.length > 0) {
    await supabase.from("instruments").upsert(instrumentRows, { onConflict: "id" });
  }

  const membershipRows = [];
  for (const [instrumentId, m] of membership.entries()) {
    for (const indexId of m.indexIds) {
      membershipRows.push({
        index_id: indexId,
        instrument_id: instrumentId,
        effective_date: runDate,
        is_current: true,
      });
    }
  }
  if (membershipRows.length > 0) {
    await supabase
      .from("index_memberships")
      .upsert(membershipRows, { onConflict: "index_id,instrument_id,effective_date" });
  }

  return membership;
}

async function evaluateInstrument({ supabase, runId, instrument, ruleDefinitions, parameterValues, ruleDirectionById }) {
  // SMM/PAPA/GUE all declare `scope: [index, equity]` at the strategy level
  // (strategies/*.yaml), so indexes run through the same OHLCV -> quality ->
  // rule-evaluation -> classify pipeline as stocks, using Fyers' index
  // symbols (providers/fyers.js). Indexes are still excluded from coverage
  // reconciliation and rankings below (AGENTS.md: "Index state is
  // contextual evidence and must never be copied into a member stock's own
  // result") -- they get a real terminal_state/tier for the index-analysis
  // page, they just never compete as a ranked candidate.
  let bars = [];
  let dataQuality = "NO_DATA";
  try {
    const ohlcv = await fetchOHLCV(instrument.instrumentId, instrument.symbol, OHLCV_LOOKBACK_DAYS);
    bars = ohlcv.data;
    const validation = validateBars(bars);
    dataQuality = validation.result;
    if (validation.issues.length > 0) {
      await supabase.from("data_quality_results").insert({
        run_id: runId,
        instrument_id: instrument.instrumentId,
        check_name: "bar_validation",
        result: dataQuality,
        details: { issues: validation.issues.slice(0, 20) },
      });
    }
  } catch (err) {
    await supabase.from("data_quality_results").insert({
      run_id: runId,
      instrument_id: instrument.instrumentId,
      check_name: "ingestion",
      result: "NO_DATA",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  if (dataQuality !== "PASS") {
    const resultRow = {
      run_id: runId,
      instrument_id: instrument.instrumentId,
      is_index: instrument.isIndex,
      terminal_state: "NO_DATA",
      tier: "unavailable",
      direction: null,
      score: null,
      failed_gates: [],
      data_quality: dataQuality,
    };
    await supabase.from("instrument_run_results").insert(resultRow);
    return { resultRow, componentScores: {} };
  }

  await supabase.from("market_bars_raw").upsert(
    bars.map((b) => ({
      instrument_id: instrument.instrumentId,
      session_date: b.date,
      ts: `${b.date}T00:00:00+05:30`,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      provider: "fyers",
      freshness: "EOD",
    })),
    { onConflict: "instrument_id,session_date,provider" }
  );

  const context = buildFeatureContext(bars, parameterValues.documented ?? {});
  const { traces, failedGates } = evaluateRules(ruleDefinitions, context, parameterValues);

  if (traces.length > 0) {
    await supabase
      .from("rule_traces")
      .insert(traces.map((t) => ({ run_id: runId, instrument_id: instrument.instrumentId, ...t })));
  }

  const { terminalState, tier } = classify(traces, failedGates, dataQuality);
  const tracesByFramework = groupBy(traces, (t) => t.rule_id.split("-")[0]);
  const { total, componentScores } = scoreComponents(tracesByFramework);
  const direction = inferDirection(traces, ruleDirectionById);

  const resultRow = {
    run_id: runId,
    instrument_id: instrument.instrumentId,
    is_index: instrument.isIndex,
    terminal_state: terminalState,
    tier,
    direction,
    score: total,
    failed_gates: failedGates,
    data_quality: dataQuality,
  };
  await supabase.from("instrument_run_results").insert(resultRow);

  return { resultRow, componentScores };
}

/** Majority vote of PASSed bullish vs. bearish rules. Ties/no signal are undirected, not guessed. */
function inferDirection(traces, ruleDirectionById) {
  let bullish = 0;
  let bearish = 0;
  for (const t of traces) {
    if (t.result !== "PASS") continue;
    const dir = ruleDirectionById[t.rule_id];
    if (dir === "bullish") bullish++;
    else if (dir === "bearish") bearish++;
  }
  if (bullish > bearish) return "bullish";
  if (bearish > bullish) return "bearish";
  return null;
}

function flattenParameters(values) {
  return {
    ...(values.documented ?? {}),
    ...(values.project_defaults_requiring_backtest ?? {}),
    documented: values.documented ?? {},
  };
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

async function logStage(supabase, runId, stage, status, message) {
  await supabase.from("pipeline_audit_log").insert({ run_id: runId, stage, status, message });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
