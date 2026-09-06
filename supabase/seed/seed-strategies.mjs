// Loads strategies/*.yaml, strategies/shared-gates.yaml, and
// config/parameters.yaml into the hrtstocks database. Safe to re-run: each
// strategy is upserted by (strategy_id, rule_version), so editing a yaml file
// and bumping its rule_version (per AGENTS.md Change Control) creates a new
// version rather than silently overwriting the previous one. Re-running with
// an unchanged rule_version replaces that version's rule_definitions so fixed
// typos don't require a version bump.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:strategies
//
// The service role key is required because this writes to tables that RLS
// otherwise reserves for the run-screening Edge Function.

import { createClient } from "@supabase/supabase-js";
import { parseAllStrategies, parseSharedGates, parseParameters } from "./parse-strategies.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function upsertStrategy(strategy, rules) {
  const { data: versionRow, error: versionError } = await supabase
    .from("strategy_versions")
    .upsert(
      {
        framework: strategy.framework,
        strategy_id: strategy.strategy_id,
        rule_version: strategy.rule_version,
        parameter_version: strategy.parameter_version,
        status: strategy.status,
        is_active: true,
        raw_yaml: strategy.raw_yaml,
      },
      { onConflict: "strategy_id,rule_version" }
    )
    .select("id")
    .single();

  if (versionError) throw versionError;

  if (rules.length === 0) return { strategyVersionId: versionRow.id, ruleCount: 0 };

  const { error: rulesError } = await supabase.from("rule_definitions").upsert(
    rules.map((r) => ({
      strategy_version_id: versionRow.id,
      rule_id: r.rule_id,
      framework: r.framework,
      name: r.name,
      source_status: r.source_status,
      scope: r.scope,
      timeframe: r.timeframe,
      direction: r.direction,
      inputs: r.inputs,
      expression: r.expression,
      true_result: r.true_result,
      false_result: r.false_result,
      missing_result: r.missing_result,
      hard_gate: r.hard_gate,
      parameters: r.parameters,
      source_refs: r.source_refs,
      raw: r.raw,
    })),
    { onConflict: "strategy_version_id,rule_id" }
  );

  if (rulesError) throw rulesError;

  return { strategyVersionId: versionRow.id, ruleCount: rules.length };
}

async function main() {
  const strategies = parseAllStrategies();
  for (const { strategy, rules, skipped } of strategies) {
    const result = await upsertStrategy(strategy, rules);
    console.log(
      `${strategy.strategy_id} (${strategy.rule_version}): ${result.ruleCount} decision rules seeded` +
        (skipped.length ? `, ${skipped.length} non-decision entries skipped (${skipped.join(", ")})` : "")
    );
  }

  const sharedGates = parseSharedGates();
  const gatesResult = await upsertStrategy(sharedGates, []);
  console.log(`${sharedGates.strategy_id} (${sharedGates.rule_version}): registered, no per-rule expressions`);

  const params = parseParameters();
  const { error: paramError } = await supabase
    .from("parameter_versions")
    .upsert(
      { version: params.version, status: params.status, values: params.values },
      { onConflict: "version" }
    );
  if (paramError) throw paramError;
  console.log(`parameter_version ${params.version}: seeded`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
