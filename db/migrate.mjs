// Minimal forward-only migration runner for plain SQL files in db/migrations.
//
//   DATABASE_URL=postgres://... node db/migrate.mjs            apply pending
//   DATABASE_URL=postgres://... node db/migrate.mjs --status   list applied/pending
//   GRANT_ROLES="app_web=<web-sa>;app_pipeline=<pipeline-sa>" ... node db/migrate.mjs   also grant runtime roles
//
// Each file runs in its own transaction, guarded by an advisory lock so
// concurrent deploys cannot interleave. Applied files are checksummed: editing
// an already-applied migration fails loudly instead of silently diverging.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_KEY = 727_001;

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return { file, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    });
}

/** Applies all pending migrations with an existing client. Returns the files applied. */
export async function migrate(client, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    const { rows } = await client.query("select version, checksum from schema_migrations");
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const done = [];
    for (const m of listMigrations(dir)) {
      if (applied.has(m.file)) {
        if (applied.get(m.file) !== m.checksum) {
          throw new Error(`Migration ${m.file} was modified after it was applied (checksum mismatch).`);
        }
        continue;
      }
      log(`applying ${m.file}`);
      try {
        await client.query("begin");
        await client.query(m.sql);
        await client.query("insert into schema_migrations (version, checksum) values ($1, $2)", [m.file, m.checksum]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${m.file} failed: ${err.message}`);
      }
      done.push(m.file);
    }
    return done;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

/**
 * Grants the least-privilege DB roles (created by 0019_app_roles.sql) to the runtime
 * identities. Idempotent. Format: GRANT_ROLES="app_web=web-sa@p.iam;app_pipeline=job-sa@p.iam"
 * (Cloud SQL IAM service-account users are created by Terraform; membership is granted here
 * because Terraform cannot run SQL.) Identifiers are validated, never interpolated blindly.
 */
export async function grantRuntimeRoles(client, spec, { log = () => {} } = {}) {
  if (!spec) return [];
  const done = [];
  for (const pair of spec.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [role, user] = pair.split("=").map((x) => x.trim());
    if (!["app_web", "app_pipeline"].includes(role)) throw new Error(`GRANT_ROLES: unknown role "${role}"`);
    if (!user || !/^[A-Za-z0-9_.@-]{1,100}$/.test(user)) throw new Error(`GRANT_ROLES: invalid user for ${role}`);
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [user]);
    if (exists.rowCount === 0) throw new Error(`GRANT_ROLES: database user "${user}" does not exist yet (create it first)`);
    await client.query(`grant ${role} to "${user.replace(/"/g, '""')}"`);
    log(`granted ${role} to ${user}`);
    done.push(`${role}=${user}`);
  }
  return done;
}

/**
 * Connects with DATABASE_URL. Against Cloud SQL this is the operator's Cloud SQL Auth Proxy
 * (docs/gcp/runbooks/qa-deployment.md): migrations are applied deliberately from a workstation, never by CI
 * or by a runtime identity, so no runtime service account ever holds schema-owner rights.
 */
async function connect(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("Set DATABASE_URL (a local database, or the Cloud SQL Auth Proxy for QA).");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  return { client, close: () => client.end() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { client, close } = await connect();
  try {
    if (process.argv.includes("--status")) {
      await client.query("create table if not exists schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())");
      const { rows } = await client.query("select version from schema_migrations");
      const applied = new Set(rows.map((r) => r.version));
      for (const m of listMigrations()) console.log(`${applied.has(m.file) ? "applied " : "pending "} ${m.file}`);
    } else {
      const done = await migrate(client, { log: (m) => console.log(m) });
      console.log(done.length ? `Applied ${done.length} migration(s).` : "Database is up to date.");
      await grantRuntimeRoles(client, process.env.GRANT_ROLES, { log: (m) => console.log(m) });
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
