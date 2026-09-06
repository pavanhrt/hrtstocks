// Parses strategies/*.yaml + shared-gates.yaml + config/parameters.yaml into
// the row shapes stored in strategy_versions / rule_definitions / parameter_versions.
// Shared by seed-strategies.mjs (writes via supabase-js, for re-seeding after a
// strategy edit) and any one-off tooling that needs the same normalized data.
//
// YAML stays the authored source of truth (per AGENTS.md: "Markdown explains
// intent; YAML defines executable semantics") -- this module never edits it,
// only reads and normalizes it for storage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const STRATEGY_FILES = ["smm.yaml", "papa.yaml", "gue.yaml", "fome.yaml"];

function loadYaml(relativePath) {
  const full = path.join(ROOT, relativePath);
  return yaml.load(readFileSync(full, "utf8"));
}

/**
 * A rule counts as an executable decision rule only if it declares all three
 * outcome fields. Entries like PAPA-HA-001 (a derived-value calculation used
 * as supporting evidence, not a pass/fail gate) are intentionally excluded --
 * they're preserved verbatim in the strategy's raw_yaml, just not modeled as
 * a rule_definitions row.
 */
function isDecisionRule(rule) {
  return Boolean(rule.true_result && rule.false_result && rule.missing_result);
}

function normalizeTimeframe(timeframe) {
  if (timeframe === undefined) return null;
  return Array.isArray(timeframe) ? timeframe.join(",") : String(timeframe);
}

function normalizeRule(rule, framework) {
  return {
    rule_id: rule.id,
    framework,
    name: rule.name ?? rule.id,
    source_status: rule.source_status,
    scope: rule.scope ?? null,
    timeframe: normalizeTimeframe(rule.timeframe),
    direction: rule.direction ?? null,
    inputs: rule.inputs ?? [],
    expression: rule.expression,
    true_result: rule.true_result,
    false_result: rule.false_result,
    missing_result: rule.missing_result,
    // GUE's impulse rules gate wave-count validity via `hard_gate_for_count`
    // rather than `hard_gate`; both mean "failure blocks qualification" so
    // they're stored in the same column.
    hard_gate: Boolean(rule.hard_gate ?? rule.hard_gate_for_count ?? false),
    parameters: rule.parameters ?? [],
    source_refs: null, // framework-level provenance only until page/row mapping is done (see rule-schema.md)
    raw: rule,
  };
}

export function parseStrategyFile(filename) {
  const doc = loadYaml(path.join("strategies", filename));
  const framework = doc.strategy.framework;
  const rulesArray = doc.rules ?? doc.impulse_rules ?? [];
  const rules = rulesArray.filter(isDecisionRule).map((r) => normalizeRule(r, framework));
  const skipped = rulesArray.filter((r) => !isDecisionRule(r)).map((r) => r.id);
  return {
    strategy: {
      framework,
      strategy_id: doc.strategy.id,
      rule_version: doc.strategy.rule_version,
      parameter_version: doc.strategy.parameter_version ?? null,
      status: doc.strategy.status,
      raw_yaml: doc,
    },
    rules,
    skipped,
  };
}

export function parseAllStrategies() {
  return STRATEGY_FILES.map(parseStrategyFile);
}

export function parseSharedGates() {
  const doc = loadYaml(path.join("strategies", "shared-gates.yaml"));
  return {
    framework: "RISK",
    strategy_id: doc.definition.id,
    rule_version: doc.definition.rule_version,
    parameter_version: doc.definition.parameter_version ?? null,
    status: "extracted_original",
    raw_yaml: doc,
  };
}

export function parseParameters() {
  const doc = loadYaml(path.join("config", "parameters.yaml"));
  return {
    version: doc.parameter_version,
    status: doc.status,
    values: doc,
  };
}
