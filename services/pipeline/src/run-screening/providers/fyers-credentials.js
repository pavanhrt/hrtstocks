// The single place FYERS credentials are read. Everything that talks to FYERS
// goes through here, so a future supported automatic-refresh mechanism (which
// needs its own security review -- see docs/gcp/runbooks/fyers-token.md) only has
// to replace `readAccessToken`, not every provider call.
//
// Today the token is refreshed MANUALLY each trading day (FYERS tokens expire
// daily) and supplied through the environment:
//   deployed: Secret Manager secret mounted by Cloud Run as FYERS_ACCESS_TOKEN
//   local:    ignored file services/pipeline/.env.local (never committed)
//
// Credential values are never logged and never included in any error message:
//   - both values are trimmed as soon as they are read (a secret stored from a Windows shell ends with CR/LF)
//   - a value that is empty after trimming, is the deployment placeholder, or still holds a control character
//     (CR/LF/tab/NUL) is refused with a message that says WHICH variable is wrong, never its value
//   - every FYERS request goes through fyersFetch, which turns any client failure into a fixed message: HTTP
//     clients (undici) echo the offending header value in their own error text, so that text is never forwarded

export class FyersAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "FyersAuthError";
  }
}

/** A network-level failure talking to FYERS. The message never carries client error text (which can embed headers). */
export class FyersRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "FyersRequestError";
  }
}

/**
 * Cloud Run cannot start a job whose secret has no version, so the secret containers are given a non-secret
 * placeholder version at deployment. It means "not configured yet" and is treated exactly like a missing value.
 */
export const NOT_CONFIGURED = "not-configured";

const ROTATION_HINT = "Rotate it following docs/gcp/runbooks/fyers-token.md, then re-run.";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** FYERS API error codes that mean the token is missing, expired or invalid. */
const AUTH_ERROR_CODES = new Set([-8, -15, -16, -17]);

/** Trims a credential and refuses anything unusable. The error names the variable, never the value. */
function cleanCredential(name, raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value === NOT_CONFIGURED) {
    throw new FyersAuthError(`${name} is not set (never configured, empty after trimming whitespace, or still the deployment placeholder). ${ROTATION_HINT}`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new FyersAuthError(
      `${name} contains a line break or control character inside the value. Store it again without one, for example: printf %s "$VALUE" | gcloud secrets versions add <secret> --data-file=-`
    );
  }
  return value;
}

export function fyersAppId(env = process.env) {
  return cleanCredential("FYERS_APP_ID", env.FYERS_APP_ID);
}

/** Returns the token or throws a clear, actionable error. */
export function readAccessToken(env = process.env) {
  return cleanCredential("FYERS_ACCESS_TOKEN", env.FYERS_ACCESS_TOKEN);
}

/** `APP_ID:ACCESS_TOKEN`, the Authorization header value FYERS expects. */
export function fyersAuthHeader(env = process.env) {
  return `${fyersAppId(env)}:${readAccessToken(env)}`;
}

// Only well-known error codes are ever surfaced from a failed fetch, never its message.
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,40}$/;

function describeFetchFailure(err) {
  const name = typeof err?.name === "string" && /^[A-Za-z]{2,40}$/.test(err.name) ? err.name : "Error";
  const code = [err?.code, err?.cause?.code].find((c) => typeof c === "string" && SAFE_CODE.test(c));
  return code ? `${name} ${code}` : name;
}

/**
 * The only way the pipeline calls FYERS. Builds the Authorization header (throwing FyersAuthError, with no value in
 * the message, if a credential is unusable) and converts any failure of the request itself into a fixed message.
 */
export async function fyersFetch(url, init = {}, env = process.env) {
  const headers = { ...(init.headers ?? {}), Authorization: fyersAuthHeader(env) };
  try {
    return await globalThis.fetch(url, { ...init, headers });
  } catch (err) {
    // Deliberately no `cause` and no err.message: either can hold the header value.
    throw new FyersRequestError(`FYERS request failed before a response was received (${describeFetchFailure(err)}).`);
  }
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
