/** Returns the lowercase SHA-256 digest of exact chart bytes. */
export async function chartContentHash(svg) {
  const bytes = new TextEncoder().encode(svg);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Content-addressed chart identity. A published object is never overwritten;
 * identical bytes reuse the same path and changed bytes necessarily get a
 * different path.
 */
export async function immutableChartIdentity(instrumentId, timeframe, svg) {
  const contentHash = await chartContentHash(svg);
  return {
    contentHash,
    objectPath: `${instrumentId}/${timeframe}/${contentHash}.svg`,
  };
}

/**
 * An immutable-path reuse is reported as an "already exists" conflict: HTTP 412
 * (Cloud Storage `ifGenerationMatch: 0` precondition failure) or 409.
 */
export function isExistingChartObjectError(error) {
  const status = String(error?.code ?? error?.statusCode ?? error?.status ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  return status === "412" || status === "409" || message.includes("already exists") || message.includes("duplicate") || message.includes("conditionnotmet");
}
