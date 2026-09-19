// Thin HTTP adapter for the official Upstox Company Fundamentals API
// (https://upstox.com/developer/api-documentation/fundamentals, inspected
// 2026-09-16 -- see CONTINUATION.md for the full findings). Every endpoint
// is keyed by ISIN, matching this project's own instruments.isin column --
// never a fuzzy company-name match.
//
// CRITICAL FINDING (2026-09-16, confirmed by reading the live docs for
// profile/balance-sheet/income-statement/share-holdings/key-ratios): NONE
// of these responses carry the filing's actual publication/submission
// timestamp. Every historical endpoint returns only a financial-period
// LABEL (e.g. "Mar 2025"); key-ratios returns no period at all (a single
// current snapshot). upstox-normalize.js handles this per the task's own
// instruction -- see that file's header.
//
// Credentials: UPSTOX_ACCESS_TOKEN (short-lived, daily-regenerated per
// Upstox's own auth model) is read from the environment by the caller and
// passed in -- this module never reads an env var itself and never logs or
// includes the token in any error message or thrown object.
//
// Rate limiting (per https://upstox.com/developer/api-documentation/rate-limiting,
// inspected 2026-09-16): the Fundamentals endpoints are not separately
// listed and so fall under the documented "Other Standard APIs" bucket --
// 50 requests/second, 500/minute, 2000/30 minutes, enforced per-user. This
// client does not itself throttle (that is the ingestion batcher's job,
// see ingestion-plan.js) -- it only classifies a 429 response as
// RETRYABLE and a 401/403 as NOT retryable (an expired/invalid token must
// never be blindly retried -- it needs a fresh UPSTOX_ACCESS_TOKEN).

const BASE_URL = "https://api.upstox.com/v2/fundamentals";

export class UpstoxApiError extends Error {
  constructor(message, { status, retryable, isin, endpoint }) {
    super(message);
    this.name = "UpstoxApiError";
    this.status = status;
    this.retryable = retryable;
    this.isin = isin;
    this.endpoint = endpoint;
  }
}

function classify(status) {
  if (status === 429) return { retryable: true, reason: "rate_limited" };
  if (status === 401 || status === 403) return { retryable: false, reason: "authentication" };
  if (status >= 500) return { retryable: true, reason: "server_error" };
  if (status >= 400) return { retryable: false, reason: "invalid_request" }; // e.g. invalid ISIN -> 4xx, never blindly retried
  return { retryable: false, reason: "ok" };
}

/**
 * @param {string} accessToken -- never logged; passed straight into the Authorization header.
 * @param {typeof fetch} [fetchImpl] -- injectable for tests (recorded fixtures), defaults to global fetch.
 */
export function createUpstoxClient(accessToken, fetchImpl = fetch) {
  if (!accessToken) throw new Error("createUpstoxClient: accessToken is required (expected UPSTOX_ACCESS_TOKEN)");

  async function get(isin, endpoint, query = {}) {
    if (!isin || typeof isin !== "string" || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) {
      throw new UpstoxApiError(`invalid ISIN "${isin}" -- refusing to call the Upstox API with an unvalidated identifier`, { status: null, retryable: false, isin, endpoint });
    }
    const url = new URL(`${BASE_URL}/${isin}/${endpoint}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

    const res = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => null);

    if (!res.ok || body?.status === "error") {
      const { retryable } = classify(res.status);
      throw new UpstoxApiError(`Upstox ${endpoint} request failed for ${isin} (HTTP ${res.status})`, { status: res.status, retryable, isin, endpoint });
    }
    return body.data;
  }

  return {
    getProfile: (isin) => get(isin, "profile"),
    getBalanceSheet: (isin, { type = "consolidated", fs = true } = {}) => get(isin, "balance-sheet", { type, fs }),
    getIncomeStatement: (isin, { type = "consolidated", time_period = "yearly", fs = true } = {}) => get(isin, "income-statement", { type, time_period, fs }),
    // REVISED 2026-09-16: official Get Cash Flow docs list only `type` and
    // `fs` as query params -- `time_period` is NOT documented for this
    // endpoint (it IS documented for income-statement, which is presumably
    // where the earlier version of this call wrongly copied it from). Sending
    // an undocumented param risks being silently ignored or, on a future API
    // version, rejected -- removed rather than guessed. Still unconfirmed
    // whether `fs=true` populates `full_statement` for cash-flow at all (the
    // live response inspected 2026-09-16 was called without `fs` and
    // returned `full_statement: null`) -- see CONTINUATION.md's pending
    // "one more live check" item.
    getCashFlow: (isin, { type = "consolidated", fs = true } = {}) => get(isin, "cash-flow", { type, fs }),
    getShareHoldings: (isin) => get(isin, "share-holdings"),
    getKeyRatios: (isin) => get(isin, "key-ratios"),
    getCorporateActions: (isin) => get(isin, "corporate-actions"),
  };
}
