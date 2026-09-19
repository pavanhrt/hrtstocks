// System / reference seed for a freshly migrated (empty) database. This is the ONLY data inserted before the
// application starts; business, market, user and analysis data are produced later by the pipelines and by
// invitations. Every step is explicit, deterministic and idempotent (safe to run any number of times).
//
// What is seeded (documented in docs/gcp/seed-data.md):
//   screening_run_leases        two rows created by the migrations themselves (run-lease coordination): verified here
//   strategy_versions           strategy registry from strategies/*.yaml (+ shared gates)
//   rule_definitions            decision rules from those YAML files
//   parameter_versions          parameters from config/parameters.yaml
//   bootstrap_admin_emails      ONLY when BOOTSTRAP_ADMIN_EMAIL is explicitly supplied
//
// Usage:  DATABASE_URL=... [BOOTSTRAP_ADMIN_EMAIL=person@example.com] node src/seed/seed-system.mjs
import { fileURLToPath } from "node:url";
import { openDb } from "../db/client.js";
import { seedStrategies } from "./seed-strategies.mjs";

/** Tables this seed (plus the migrations) may populate. Everything else must stay empty until pipelines/users fill it. */
export const SEEDED_TABLES = ["screening_run_leases", "strategy_versions", "rule_definitions", "parameter_versions", "bootstrap_admin_emails"];

const REQUIRED_LEASES = ["eod_screening", "buy_setup_analysis"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function seedSystemData(db, { bootstrapAdminEmail = null, log = () => {} } = {}) {
  // 1. Lease rows come from the migrations; refuse to continue on a database that was not migrated.
  const leases = (await db.query("select run_type from screening_run_leases")).map((r) => r.run_type);
  for (const required of REQUIRED_LEASES) {
    if (!leases.includes(required)) throw new Error(`screening_run_leases is missing "${required}": run the migrations first.`);
  }
  log(`leases present: ${REQUIRED_LEASES.join(", ")}`);

  // 2. Strategy / rule / parameter registry (upserts keyed by strategy_id + rule_version).
  const registry = await seedStrategies(db, { log });

  // 3. Bootstrap administrator: only when explicitly supplied. This authorizes a sign-in; it creates no account.
  let admin = null;
  if (bootstrapAdminEmail) {
    const email = bootstrapAdminEmail.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new Error("BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail address.");
    await db.query("insert into bootstrap_admin_emails (email) values ($1) on conflict do nothing", [email]);
    admin = email;
    log("bootstrap administrator authorized (no account created; invite them: docs/gcp/runbooks/user-management.md)");
  } else {
    log("no bootstrap administrator supplied: none authorized");
  }
  return { ...registry, bootstrapAdmin: admin !== null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await openDb();
  try {
    const result = await seedSystemData(db, { bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL || null, log: (m) => console.log(m) });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
