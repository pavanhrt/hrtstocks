// Central credential redaction. Error text from HTTP clients can embed the request headers they were given
// (undici's "Headers.append: <value> is an invalid header value" does exactly that), so nothing that may contain
// upstream error text is ever persisted or logged without passing through here.
//
// This is defense in depth: fyers-credentials.js also refuses to build an invalid header and its fetch wrapper never
// forwards a client error message. Redaction applies at the boundaries where text leaves the process:
//   - every string/JSON parameter written to PostgreSQL (db/client.js)
//   - every structured log line (jobs/runner.js)
//   - every place that turns an error into a message (safeErrorMessage / redactSecrets)

export const REDACTED = "[redacted]";

/** Environment variables whose values are credentials. Their exact values are removed wherever they appear. */
const CREDENTIAL_ENV = ["FYERS_APP_ID", "FYERS_ACCESS_TOKEN", "FYERS_SECRET_KEY", "UPSTOX_ACCESS_TOKEN"];
const MIN_SECRET_LENGTH = 8;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An HTTP client echoing the offending header value: Headers.append: "<value>" ...  (the value can span lines and be cut short)
const HEADER_ECHO_CLOSED = /(Headers\.\w+:\s*)(["'])[\s\S]*?\2/g;
const HEADER_ECHO_OPEN = /(Headers\.\w+:\s*)(["'])[\s\S]*$/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const AUTH_HEADER = /\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+(?:\s*:\s*[^\s,;"']+)?/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// FYERS style "<APP_ID>:<ACCESS_TOKEN>", possibly split by a stray CR/LF before the colon
const APP_TOKEN_PAIR = /\b[A-Z0-9]{4,}-\d{2,3}[\s\u0000-\u001f]*:[\s\u0000-\u001f]*[A-Za-z0-9._~+/=-]{8,}/g;

function knownSecrets(env) {
  const out = new Set();
  for (const name of CREDENTIAL_ENV) {
    const raw = env?.[name];
    if (typeof raw !== "string") continue;
    for (const candidate of [raw, raw.trim(), ...raw.split(/[\r\n]+/)]) {
      const v = candidate.trim();
      if (v.length >= MIN_SECRET_LENGTH) out.add(v);
    }
  }
  // Longest first so a value that contains another is removed whole.
  return [...out].sort((a, b) => b.length - a.length);
}

/** Removes credentials, header values and token-shaped strings from free text. Non-strings are returned unchanged. */
export function redactSecrets(input, env = process.env) {
  if (typeof input !== "string" || input.length === 0) return input;
  let text = input;
  text = text.replace(HEADER_ECHO_CLOSED, `$1$2${REDACTED}$2`);
  text = text.replace(HEADER_ECHO_OPEN, `$1$2${REDACTED}$2`);
  text = text.replace(AUTH_HEADER, `$1$2${REDACTED}`);
  text = text.replace(BEARER, `Bearer ${REDACTED}`);
  for (const secret of knownSecrets(env)) text = text.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  text = text.replace(APP_TOKEN_PAIR, REDACTED);
  text = text.replace(JWT, REDACTED);
  return text;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Deep-redacts strings inside plain objects and arrays (JSON-shaped values); other values are returned as they are. */
export function redactDeep(value, env = process.env) {
  if (typeof value === "string") return redactSecrets(value, env);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactDeep(v, env);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactDeep(v, env);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/** The message of any thrown value (Error, message-bearing object, string), redacted. Never includes a stack. */
export function safeErrorMessage(err, env = process.env) {
  let message;
  if (err instanceof Error) message = err.message;
  else if (err && typeof err === "object" && typeof err.message === "string") message = err.message;
  else message = String(err);
  return redactSecrets(message, env);
}

/** A stack trace (which repeats the message), redacted. */
export function safeErrorStack(err, env = process.env) {
  return redactSecrets(String(err?.stack ?? err), env);
}
