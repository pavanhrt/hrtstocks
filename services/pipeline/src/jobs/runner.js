import { openDb } from "../db/client.js";
import { redactSecrets, safeErrorMessage } from "../security/redact.js";

/** Structured logs: Cloud Logging parses JSON lines on stdout and reads `severity`. */
export function log(severity, message, fields = {}) {
  // Every string in a log line is redacted: a log must never carry a credential or an Authorization header.
  console.log(JSON.stringify({ severity, message, ...fields }, (_key, value) => (typeof value === "string" ? redactSecrets(value) : value)));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a required uuid argument from the environment (job arguments are env overrides). */
export function requireUuidEnv(name, env = process.env) {
  const value = env[name];
  if (!value || !UUID.test(value)) throw new Error(`${name} must be set to a valid uuid.`);
  return value;
}

/**
 * Runs a job body with a database handle, structured logging and a clean exit
 * code: 0 on success, 1 on failure (so Cloud Run marks the execution failed and
 * applies the job's retry policy).
 */
export async function runJob(name, body, { env = process.env, exit = (code) => process.exit(code) } = {}) {
  const startedAt = Date.now();
  let db;
  try {
    log("INFO", `job ${name} starting`);
    db = await openDb(env);
    const result = await body({ db, env });
    log("INFO", `job ${name} finished`, { result, durationMs: Date.now() - startedAt });
    await db.close?.();
    exit(0);
  } catch (err) {
    log("ERROR", `job ${name} failed: ${safeErrorMessage(err)}`, { errorName: err?.name, durationMs: Date.now() - startedAt });
    await db?.close?.().catch(() => {});
    exit(1);
  }
}
