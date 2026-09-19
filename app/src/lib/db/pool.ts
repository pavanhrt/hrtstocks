import pg from "pg";
import { databaseConfig } from "../config.ts";

/**
 * Server-only (never import from a client component). Minimal database surface used by every repository. Keeping it this small
 * (query + one) makes repositories trivially testable against any Postgres and
 * keeps SQL explicit: there is no query builder or ORM in this app.
 */
export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
};

// Match what the old PostgREST client returned so pages keep working:
//  - int8 / numeric  -> JS number (pg's default is string)
//  - timestamptz     -> ISO-8601 string (pg's default is a Date)
//  - date            -> 'YYYY-MM-DD' string (pg's default is a local-midnight Date)
const OID = { int8: 20, numeric: 1700, timestamptz: 1184, timestamp: 1114, date: 1082 } as const;
const types = {
  getTypeParser: (oid: number, format?: "text" | "binary") => {
    if (oid === OID.int8) return (v: string) => Number(v);
    if (oid === OID.numeric) return (v: string) => Number(v);
    if (oid === OID.timestamptz) return (v: string) => new Date(v).toISOString();
    if (oid === OID.timestamp) return (v: string) => new Date(`${v.replace(" ", "T")}Z`).toISOString();
    if (oid === OID.date) return (v: string) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

let pool: pg.Pool | undefined;
let testDb: Db | undefined;

function wrap(p: pg.Pool): Db {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await p.query({ text: sql, values: [...params], types });
      return res.rows as T[];
    },
    async one<T>(sql: string, params: readonly unknown[] = []) {
      const res = await p.query({ text: sql, values: [...params], types });
      return (res.rows[0] as T | undefined) ?? null;
    },
  };
}

async function createPool(): Promise<pg.Pool> {
  const cfg = databaseConfig();
  if (cfg.DATABASE_URL) {
    return new pg.Pool({ connectionString: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, idleTimeoutMillis: 10_000 });
  }
  // Cloud SQL: IAM database authentication through the Cloud SQL connector.
  // No password and no long-lived credential: the runtime service account's
  // identity is exchanged for a short-lived token (Application Default Credentials).
  const { Connector, AuthTypes, IpAddressTypes } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: cfg.CLOUD_SQL_INSTANCE!,
    authType: AuthTypes.IAM,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new pg.Pool({
    ...clientOpts,
    user: cfg.DB_USER,
    database: cfg.DB_NAME,
    max: cfg.DB_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

let poolPromise: Promise<pg.Pool> | undefined;

/** The shared database handle (lazy, one pool per server instance). */
export function getDb(): Db {
  if (testDb) return testDb;
  const lazy = async () => {
    poolPromise ??= createPool().then((p) => (pool = p));
    return wrap(await poolPromise);
  };
  return {
    query: async (sql, params) => (await lazy()).query(sql, params),
    one: async (sql, params) => (await lazy()).one(sql, params),
  };
}

/** Test hook: route every repository to a supplied database handle. */
export function setDbForTests(db: Db | undefined) {
  testDb = db;
}

/** For tests/scripts that own a pg.Pool: adapt it to the Db interface with the app's type parsing. */
export function dbFromPool(p: pg.Pool): Db {
  return wrap(p);
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
  poolPromise = undefined;
}
