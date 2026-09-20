import pg from "pg";
import { redactDeep } from "../security/redact.js";

/**
 * Minimal database handle for the pipeline: `query` returns rows, `one` returns
 * the first row or null. Every statement is explicit SQL with bound parameters.
 * (Same surface as the web app's helper so repositories look alike.)
 *
 * Result parsing matches what the previous PostgREST client returned so the
 * existing rule / feature modules keep working unchanged:
 *   int8 / numeric -> number, timestamptz -> ISO string, date -> 'YYYY-MM-DD'.
 */
const OID = { int8: 20, numeric: 1700, timestamptz: 1184, timestamp: 1114, date: 1082 };

const types = {
  getTypeParser: (oid, format) => {
    if (oid === OID.int8 || oid === OID.numeric) return (v) => Number(v);
    if (oid === OID.timestamptz) return (v) => new Date(v).toISOString();
    if (oid === OID.timestamp) return (v) => new Date(`${v.replace(" ", "T")}Z`).toISOString();
    if (oid === OID.date) return (v) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

// Nothing that reaches the database may contain a credential: strings and JSON parameters are redacted here,
// so error text persisted anywhere (details, messages, audit rows) is clean whatever code produced it.
const clean = (params) => (params.length === 0 ? params : params.map((p) => redactDeep(p)));

function wrap(executor) {
  return {
    async query(sql, params = []) {
      const res = await executor.query({ text: sql, values: clean(params), types });
      return res.rows;
    },
    async one(sql, params = []) {
      const res = await executor.query({ text: sql, values: clean(params), types });
      return res.rows[0] ?? null;
    },
    /** Escape hatch for code that needs the raw pool/client (e.g. transactions). */
    raw: executor,
  };
}

/** Wraps an existing pg.Pool / pg.Client (tests, scripts). */
export function dbFromPool(pool) {
  return wrap(pool);
}

/**
 * Opens the pipeline database from the environment:
 *   DATABASE_URL           local development / tests
 *   CLOUD_SQL_INSTANCE     Cloud Run Jobs: connector + IAM database auth (no password)
 *   DB_NAME, DB_USER, DB_POOL_MAX
 */
export async function openDb(env = process.env) {
  const max = Number(env.DB_POOL_MAX ?? 4);
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max, idleTimeoutMillis: 10_000 });
    return { ...wrap(pool), close: () => pool.end() };
  }
  if (!env.CLOUD_SQL_INSTANCE || !env.DB_USER) {
    throw new Error("Database is not configured: set DATABASE_URL (local) or CLOUD_SQL_INSTANCE and DB_USER (Cloud Run).");
  }
  const { Connector, AuthTypes, IpAddressTypes } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const options = await connector.getOptions({
    instanceConnectionName: env.CLOUD_SQL_INSTANCE,
    authType: AuthTypes.IAM,
    ipType: IpAddressTypes.PUBLIC,
  });
  const pool = new pg.Pool({
    ...options,
    user: env.DB_USER,
    database: env.DB_NAME ?? "hrtstocks",
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return {
    ...wrap(pool),
    close: async () => {
      await pool.end();
      connector.close();
    },
  };
}
