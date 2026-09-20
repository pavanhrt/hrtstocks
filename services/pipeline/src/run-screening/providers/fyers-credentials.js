// The single place FYERS credentials are read. Everything that talks to FYERS
// goes through here, so a future supported automatic-refresh mechanism (which
// needs its own security review -- see docs/gcp/runbooks/fyers-token.md) only has
// to replace `readAccessToken`, not every provider call.
//
// Today the token is refreshed MANUALLY each trading day (FYERS tokens expire
// daily) and supplied through the environment:
//   deployed: Secret Manager secret mounted by Cloud Run as FYERS_ACCESS_TOKEN
//   local:    ignored file services/pipeline/.env.local (never committed)
// The token is never logged and never included in error messages.

export class FyersAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "FyersAuthError";
  }
}

/**
 * Cloud Run cannot start a job whose secret has no version, so the secret containers are given a non-secret
 * placeholder version at deployment. It means "not configured yet" and is treated exactly like a missing value.
 */
export const NOT_CONFIGURED = "not-configured";

const ROTATION_HINT = "Rotate it following docs/gcp/runbooks/fyers-token.md, then re-run.";

/** FYERS API error codes that mean the token is missing, expired or invalid. */
const AUTH_ERROR_CODES = new Set([-8, -15, -16, -17]);

export function fyersAppId(env = process.env) {
  const appId = env.FYERS_APP_ID;
  if (!appId || appId === NOT_CONFIGURED) throw new FyersAuthError(`FYERS_APP_ID is not set. ${ROTATION_HINT}`);
  return appId;
}

/** Returns the token or throws a clear, actionable error. */
export function readAccessToken(env = process.env) {
  const token = env.FYERS_ACCESS_TOKEN;
  if (!token || token === NOT_CONFIGURED) throw new FyersAuthError(`FYERS_ACCESS_TOKEN is not set (the daily token was never configured or was cleared). ${ROTATION_HINT}`);
  return token;
}

/** `APP_ID:ACCESS_TOKEN`, the Authorization header value FYERS expects. */
export function fyersAuthHeader(env = process.env) {
  return `${fyersAppId(env)}:${readAccessToken(env)}`;
}

/**
 * Call with a non-OK / error response: throws FyersAuthError when the response
 * shows an expired or invalid token, so the run stops with a clear cause instead
 * of recording thousands of per-instrument "NO_DATA" failures.
 */
export function assertNotAuthFailure(status, body) {
  const code = typeof body?.code === "number" ? body.code : null;
  const looksLikeToken = typeof body?.message === "string" && /token|authenticat|unauthori[sz]ed/i.test(body.message);
  if (status === 401 || status === 403 || (code !== null && AUTH_ERROR_CODES.has(code)) || (status >= 400 && looksLikeToken)) {
    throw new FyersAuthError(`FYERS rejected the access token (HTTP ${status}${code !== null ? `, code ${code}` : ""}). It has probably expired. ${ROTATION_HINT}`);
  }
}
