export type RunLike = {
  run_date: string;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  providers?: unknown;
  [key: string]: unknown;
};

function firstString(run: RunLike, keys: string[]): string | null {
  for (const key of keys) {
    const value = run[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type PublishedRunMetadata = {
  cutoff: string | null;
  publicationState: string;
  adjustmentState: string | null;
  analysisSeriesVersion: string | null;
  analysisProvider: string | null;
  validatedAt: string | null;
  publishedAt: string | null;
  providers: Array<{ category: string; provider: string }>;
};

/**
 * Reads both the legacy screening_runs shape and forward-compatible snapshot
 * columns. The UI never substitutes completion time for the market-data
 * cutoff: a legacy row without a cutoff is labelled as unrecorded.
 */
export function getPublishedRunMetadata(run: RunLike): PublishedRunMetadata {
  const providersObject = objectValue(run.providers);
  const providers = Object.entries(providersObject ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([category, provider]) => ({ category, provider }));

  return {
    cutoff: firstString(run, ["as_of_timestamp", "cutoff_timestamp", "data_cutoff_at"]),
    publicationState:
      firstString(run, ["publication_state", "lifecycle_state"]) ??
      (run.status === "completed" ? "COMPLETED (legacy lifecycle)" : run.status.toUpperCase()),
    adjustmentState: firstString(run, ["analysis_adjustment_state", "adjustment_state"]),
    analysisSeriesVersion: firstString(run, ["analysis_series_version"]),
    analysisProvider: firstString(run, ["analysis_provider"]),
    validatedAt: firstString(run, ["validated_at"]),
    publishedAt: firstString(run, ["published_at"]),
    providers,
  };
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
