// Resolves ONE immutable parameter_versions row into the flat parameter set
// buy-setup/*.js's calculation modules need -- pure function of its single
// argument, so an enrichment run that resolved its parameters once at start
// can never be affected by a later change to which parameter_versions row is
// "currently active" (config/parameters.yaml being re-seeded mid-run,
// another run starting concurrently, etc.). The caller is responsible for
// fetching the row ONCE (analyze-buy-setup/index.ts does this at the start
// of an enrichment run) and threading the SAME resolved object through
// every batch -- this module has no notion of "the active version," only of
// whatever row it is given.
//
// parameter_versions.values is the ENTIRE parsed config/parameters.yaml
// document (services/pipeline/src/seed/parse-strategies.mjs's parseParameters: `values:
// doc`), so `documented` and `buy_setup_analysis_defaults` are nested
// namespaces within it, not flat top-level keys -- mirrors
// run-screening/index.ts's own flattenParameters() for the `documented` +
// `project_defaults_requiring_backtest` namespaces, extended here for
// `buy_setup_analysis_defaults` (buy-setup's own PROJECT_DEFAULT parameters,
// config/parameters.yaml's own dated comments).

const REQUIRED_FIELDS = [
  "emaPeriods",
  "rsiPeriod",
  "stochasticLookback",
  "stochasticSmoothing",
  "bollingerLookback",
  "bollingerDeviation",
  "adxDmiPeriod",
  "macdFast",
  "macdSlow",
  "macdSignal",
  "volumeLookback",
  "volumeMultiplier",
  "zigzagDailyPct",
  "pivotLeftWindow",
  "pivotRightWindow",
  "srTolerance",
  "srTouchCountMin",
  "breakoutBuffer",
  "channelMinPivots",
  "channelSlopeThreshold",
  "emaCrossoverConfirmationWindow",
  "divergenceLookback",
  "zigzagFifteenMinutePct",
];

/**
 * @param {{id: string, version: string, values: object}} parameterVersionRow a single row from parameter_versions
 * @returns {{parameterVersionId: string, parameterVersion: string, [key: string]: unknown}}
 */
export function resolveBuySetupParameters(parameterVersionRow) {
  if (!parameterVersionRow || !parameterVersionRow.id) {
    throw new Error("resolveBuySetupParameters requires a parameter_versions row with an id -- refusing to guess an unpinned parameter set");
  }
  const values = parameterVersionRow.values ?? {};
  const documented = values.documented ?? {};
  const defaults = values.buy_setup_analysis_defaults ?? {};

  const resolved = {
    parameterVersionId: parameterVersionRow.id,
    parameterVersion: values.parameter_version ?? parameterVersionRow.version,
    emaPeriods: documented.ema_periods ?? null,
    rsiPeriod: documented.rsi_period ?? null,
    stochasticLookback: documented.stochastic_lookback ?? null,
    stochasticSmoothing: documented.stochastic_smoothing ?? null,
    bollingerLookback: documented.bollinger_lookback ?? null,
    bollingerDeviation: documented.standard_bollinger_deviation ?? null,
    adxDmiPeriod: documented.adx_dmi_period ?? null,
    macdFast: documented.macd_fast ?? null,
    macdSlow: documented.macd_slow ?? null,
    macdSignal: documented.macd_signal ?? null,
    volumeLookback: documented.volume_lookback ?? null,
    volumeMultiplier: documented.volume_multiplier ?? null,
    zigzagDailyPct: documented.zigzag_daily_pct ?? null,
    pivotLeftWindow: defaults.pivot_left_window ?? null,
    pivotRightWindow: defaults.pivot_right_window ?? null,
    srTolerance: defaults.support_resistance_tolerance ?? null,
    srTouchCountMin: defaults.sr_touch_count_min ?? null,
    breakoutBuffer: defaults.breakout_buffer ?? null,
    channelMinPivots: defaults.channel_min_pivots ?? null,
    channelSlopeThreshold: defaults.channel_slope_threshold ?? null,
    emaCrossoverConfirmationWindow: defaults.ema_crossover_confirmation_window ?? null,
    divergenceLookback: defaults.divergence_lookback ?? null,
    zigzagFifteenMinutePct: defaults.zigzag_fifteen_minute_pct ?? null,
  };

  const missing = REQUIRED_FIELDS.filter((key) => resolved[key] == null || (Array.isArray(resolved[key]) && resolved[key].length === 0));
  if (missing.length > 0) {
    throw new Error(
      `parameter_versions ${resolved.parameterVersion} (id ${resolved.parameterVersionId}) is missing required buy-setup parameter(s): ${missing.join(", ")} -- refusing to substitute a hardcoded default`
    );
  }

  return resolved;
}

/** The two documented EMA slow periods (13, 26) buy-setup uses alongside the fast period (5) -- reuses `documented.ema_periods` verbatim, never a separate list. */
export function emaCrossoverPeriods(resolved) {
  const [fast, ...rest] = resolved.emaPeriods;
  const slowCandidates = rest.filter((p) => [13, 26].includes(p));
  if (slowCandidates.length === 0) {
    throw new Error(`documented ema_periods (${resolved.emaPeriods.join(",")}) does not contain either of the expected slow periods (13, 26)`);
  }
  return { fastPeriod: fast, slowPeriods: slowCandidates };
}
