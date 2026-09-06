import { evaluateExpression } from "./engine.js";

const MANUAL_REVIEW_SENTINEL = "manual_review";

/**
 * Evaluates one rule_definitions row against a computed feature context.
 *
 * @param {object} rule - a row from rule_definitions (rule_id, expression, inputs,
 *   parameters, true_result, false_result, missing_result, hard_gate, ...)
 * @param {Record<string, unknown>} featureContext - computed indicator/price values,
 *   keyed by the identifier names used in strategies/*.yaml expressions
 * @param {Record<string, unknown>} parameterValues - the active parameter_version's
 *   flattened documented + project_defaults_requiring_backtest values
 * @returns {{ result: string, observedValues: object, thresholds: object, explanation: string }}
 */
export function evaluateRule(rule, featureContext, parameterValues) {
  // A rule authored as a fixed sentinel (PAPA-DOW-003, FOME-NP-001) has no
  // executable condition -- it is documented as always requiring a human,
  // per its source_status (UNRESOLVED/CONFLICT). Never run it through the
  // expression engine.
  if (rule.expression === MANUAL_REVIEW_SENTINEL) {
    return {
      result: rule.missing_result,
      observedValues: {},
      thresholds: {},
      explanation: `${rule.rule_id} is documented as requiring manual review (source_status=${rule.source_status}); it has no automatable condition.`,
    };
  }

  // null_policy (config/parameters.yaml): a rule that depends on a parameter
  // still awaiting backtest-derived resolution must not silently assume a
  // value -- it resolves to the rule's own missing_result (MANUAL_REVIEW or
  // NO_DATA, as documented) rather than guessing.
  const unresolvedParams = (rule.parameters ?? []).filter(
    (name) => parameterValues[name] === null || parameterValues[name] === undefined
  );
  if (unresolvedParams.length > 0) {
    return {
      result: rule.missing_result,
      observedValues: {},
      thresholds: {},
      explanation: `${rule.rule_id} depends on unresolved parameter(s) [${unresolvedParams.join(", ")}] that config/parameters.yaml marks as requiring a backtest before use.`,
    };
  }

  const context = { ...featureContext, ...parameterValues };

  const missingInputs = (rule.inputs ?? []).filter(
    (name) => context[name] === null || context[name] === undefined
  );

  let raw;
  try {
    raw = evaluateExpression(rule.expression, context);
  } catch (err) {
    return {
      result: rule.missing_result,
      observedValues: pick(context, rule.inputs ?? []),
      thresholds: pick(context, rule.parameters ?? []),
      explanation: `${rule.rule_id} could not be evaluated: ${err.message}`,
    };
  }

  const observedValues = pick(context, rule.inputs ?? []);
  const thresholds = pick(context, rule.parameters ?? []);

  let result;
  if (raw === null) {
    result = rule.missing_result;
  } else if (raw === true) {
    result = rule.true_result;
  } else {
    result = rule.false_result;
  }

  const explanation =
    raw === null
      ? `${rule.rule_id} could not be determined${missingInputs.length ? ` -- missing input(s): ${missingInputs.join(", ")}` : ""}.`
      : `${rule.rule_id} (${rule.name}) evaluated to ${String(raw)} -> ${result}.`;

  return { result, observedValues, thresholds, explanation };
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

/**
 * Evaluates every rule_definitions row for one instrument and returns
 * rule_traces-ready rows plus the list of failed hard gates (for
 * instrument_run_results.failed_gates).
 */
export function evaluateRules(rules, featureContext, parameterValues) {
  const traces = [];
  const failedGates = [];

  for (const rule of rules) {
    const { result, observedValues, thresholds, explanation } = evaluateRule(
      rule,
      featureContext,
      parameterValues
    );

    traces.push({
      rule_id: rule.rule_id,
      rule_version: rule.raw?.rule_version ?? null,
      observed_values: observedValues,
      thresholds,
      result,
      data_source: featureContext.__dataSource ?? null,
      source_document: rule.source_refs?.document ?? null,
      source_locator: rule.source_refs?.locator ?? null,
      explanation,
    });

    if (rule.hard_gate && result !== rule.true_result) {
      failedGates.push(rule.rule_id);
    }
  }

  return { traces, failedGates };
}
