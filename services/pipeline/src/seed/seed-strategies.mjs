// Loads strategies/*.yaml, strategies/shared-gates.yaml, and
// config/parameters.yaml into the database. Safe to re-run: each strategy is
// upserted by (strategy_id, rule_version), so editing a yaml file and bumping
// its rule_version (per AGENTS.md Change Control) creates a new version rather
// than silently overwriting the previous one. Re-running with an unchanged
// rule_version replaces that version's rule_definitions so fixed typos don't
// require a version bump.
//
// Usage (from the repo root):
//   DATABASE_URL=postgres://... npm run seed:strategies
// In a container the YAML specs are copied next to the code; point SPEC_ROOT at them.
//
// Connects with the pipeline's database settings (DATABASE_URL locally;
// CLOUD_SQL_INSTANCE + DB_USER with IAM auth in Cloud Run).

import { openDb } from "../db/client.js";
import * as ops from "../db/ops.js";
import { parseAllStrategies, parseSharedGates, parseParameters } from "./parse-strategies.mjs";

async function upsertStrategy(db, strategy, rules) {
  const { data: versionRow } = await ops.upsert(
    db,
    "strategy_versions",
    {
      framework: strategy.framework,
      strategy_id: strategy.strategy_id,
      rule_version: strategy.rule_version,
      parameter_version: strategy.parameter_version,
      status: strategy.status,
      is_active: true,
      raw_yaml: strategy.raw_yaml,
    },
    { conflict: ["strategy_id", "rule_version"], returning: ["id"], mode: "single" },
  );

  if (rules.length === 0) return { strategyVersionId: versionRow.id, ruleCount: 0 };

  await ops.upsert(
    db,
    "rule_definitions",
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
    { conflict: ["strategy_version_id", "rule_id"] },
  );

  return { strategyVersionId: versionRow.id, ruleCount: rules.length };
}

/** Seeds every strategy, the shared gates and the parameter version. Returns a summary. */
export async function seedStrategies(db, { log = () => {} } = {}) {
  const summary = { strategies: 0, rules: 0 };
  for (const { strategy, rules, skipped } of parseAllStrategies()) {
    const result = await upsertStrategy(db, strategy, rules);
    summary.strategies += 1;
    summary.rules += result.ruleCount;
    log(
      `${strategy.strategy_id} (${strategy.rule_version}): ${result.ruleCount} decision rules seeded` +
        (skipped.length ? `, ${skipped.length} non-decision entries skipped (${skipped.join(", ")})` : ""),
    );
  }

  const sharedGates = parseSharedGates();
  await upsertStrategy(db, sharedGates, []);
  log(`${sharedGates.strategy_id} (${sharedGates.rule_version}): registered, no per-rule expressions`);

  const params = parseParameters();
  await ops.upsert(db, "parameter_versions", { version: params.version, status: params.status, values: params.values }, { conflict: ["version"] });
  log(`parameter_version ${params.version}: seeded`);
  return summary;
}

// CLI entry point
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await openDb();
  try {
    await seedStrategies(db, { log: (m) => console.log(m) });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
