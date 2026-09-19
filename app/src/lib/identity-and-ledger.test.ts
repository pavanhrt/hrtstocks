import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../../../db/migrate.mjs";
import { startTestPostgres } from "../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "./db/pool.ts";
import { findLinkedUser, resolveAuthorizedUser } from "./auth-profile.ts";
import { buildLedgerOrderBy, buildLedgerWhere } from "./data/buy-setup-ledger-sql.ts";
import { buildSortSpecs } from "./data/buy-setup-sort.ts";
import { isSameOrigin } from "./same-origin.ts";
import { isSafeObjectPath, chartUrl } from "./charts.ts";

let pgx: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: pg.Pool;

before(async () => {
  pgx = await startTestPostgres();
  const c = await pgx.newClient();
  await migrate(c);
  await c.end();
  pool = new pg.Pool({ connectionString: pgx.url, max: 3 });
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

const db = () => dbFromPool(pool);

describe("invite-only identity resolution", () => {
  test("an uninvited person is refused, even with a verified email", async () => {
    assert.equal(await resolveAuthorizedUser(db(), { uid: "u-stranger", email: "stranger@example.com", emailVerified: true }), null);
  });

  test("an invited person is linked on first verified sign-in and keeps their role", async () => {
    await pool.query(`insert into profiles (email, role) values ('Invited@Example.com', 'researcher')`);
    const user = await resolveAuthorizedUser(db(), { uid: "u-invited", email: "invited@example.com", emailVerified: true });
    assert.equal(user?.role, "researcher");
    assert.equal((await findLinkedUser(db(), "u-invited"))?.email, "Invited@Example.com");
    // Later sign-ins resolve by uid alone, and the role is read fresh from the database.
    await pool.query(`update profiles set role = 'strategy_admin' where auth_uid = 'u-invited'`);
    assert.equal((await findLinkedUser(db(), "u-invited"))?.role, "strategy_admin");
  });

  test("an unverified email can never claim an invite", async () => {
    await pool.query(`insert into profiles (email, role) values ('unverified@example.com', 'researcher')`);
    assert.equal(await resolveAuthorizedUser(db(), { uid: "u-unverified", email: "unverified@example.com", emailVerified: false }), null);
    assert.equal(await findLinkedUser(db(), "u-unverified"), null);
  });

  test("a second account cannot take over an already-linked profile", async () => {
    const attacker = await resolveAuthorizedUser(db(), { uid: "u-attacker", email: "invited@example.com", emailVerified: true });
    assert.equal(attacker, null);
    assert.equal((await findLinkedUser(db(), "u-invited"))?.email, "Invited@Example.com");
  });

  test("bootstrap admin emails become system_admin, once", async () => {
    await pool.query(`insert into bootstrap_admin_emails (email) values ('root@example.com')`);
    const first = await resolveAuthorizedUser(db(), { uid: "u-root", email: "ROOT@example.com", emailVerified: true });
    assert.equal(first?.role, "system_admin");
    assert.equal((await pool.query(`select count(*) from profiles where lower(email) = 'root@example.com'`)).rows[0].count, "1");
  });

  test("open signup creates viewers only when explicitly enabled", async () => {
    const identity = { uid: "u-new", email: "new@example.com", emailVerified: true };
    assert.equal(await resolveAuthorizedUser(db(), identity), null);
    assert.equal(await resolveAuthorizedUser(db(), identity, { signupMode: "invite_only" }), null);
    assert.equal((await resolveAuthorizedUser(db(), identity, { signupMode: "open" }))?.role, "viewer");
  });

  test("concurrent first sign-ins of one invite create no duplicates", async () => {
    await pool.query(`insert into profiles (email, role) values ('race@example.com', 'viewer')`);
    const identity = { uid: "u-race", email: "race@example.com", emailVerified: true };
    const results = await Promise.all([1, 2, 3].map(() => resolveAuthorizedUser(db(), identity)));
    assert.ok(results.every((r) => r?.email === "race@example.com"));
    assert.equal((await pool.query(`select count(*) from profiles where lower(email) = 'race@example.com'`)).rows[0].count, "1");
  });

  test("a missing uid or email is refused outright", async () => {
    assert.equal(await resolveAuthorizedUser(db(), { uid: "", email: "a@b.c", emailVerified: true }), null);
    assert.equal(await resolveAuthorizedUser(db(), { uid: "x", email: " ", emailVerified: true }), null);
  });
});

describe("buy-setup ledger SQL builder", () => {
  const everyFilter = {
    query: "50%_ltd'; --",
    monthlyState: "uptrend",
    weeklyState: "uptrend",
    dailyState: "reversal",
    gate: "PASS",
    wave: "impulse",
    reversal: "either_pass",
    overallStatus: "TECHNICAL_EVIDENCE_PRESENT",
    dataAvailability: "has_data",
    minFundamentalScore: 40,
    fundamentalDataStatus: "SCORED",
  };

  test("user input is bound as parameters, never interpolated", () => {
    const { where, params } = buildLedgerWhere(everyFilter);
    assert.ok(!where.includes("ltd"), "search text must not appear in SQL text");
    assert.ok(!where.includes("uptrend"), "filter values must not appear in SQL text");
    assert.ok(params.includes("%50\\%\\_ltd'; --%"));
  });

  test("the generated SQL runs against the real ledger view (all filters, both sort columns, viewer and staff)", async () => {
    for (const staff of [true, false]) {
      for (const sortBy of ["symbol", "overall_status", "gate_result", "fundamental_score"]) {
        for (const dir of ["asc", "desc"]) {
          const { where, params } = buildLedgerWhere(everyFilter);
          const order = buildLedgerOrderBy(buildSortSpecs(sortBy, dir));
          const sql = `select * from buy_setup_analysis_ledger where ${where} order by ${order} limit $${params.length + 3} offset $${params.length + 4}`;
          const res = await pool.query(sql, ["11111111-1111-1111-1111-111111111111", staff, ...params, 25, 0]);
          assert.equal(res.rows.length, 0);
        }
      }
    }
    const { where } = buildLedgerWhere({});
    assert.equal(where, "run_id = $1");
  });

  test("only allow-listed columns can be ordered", () => {
    assert.throws(() => buildLedgerOrderBy([{ column: "1; drop table x" as never, ascending: true, nullsFirst: false }]));
  });

  test("viewers cannot filter or sort on fundamentals from unpublished manifests", () => {
    const { where } = buildLedgerWhere({ minFundamentalScore: 10 });
    assert.match(where, /\$2::boolean or fundamental_result_published/);
    assert.match(buildLedgerOrderBy(buildSortSpecs("fundamental_score", "desc")), /\$2::boolean or fundamental_result_published/);
  });
});

describe("request hardening helpers", () => {
  const req = (headers: Record<string, string>) => new Request("http://app.test/api/x", { method: "POST", headers });

  test("state-changing requests must be same-origin", () => {
    assert.equal(isSameOrigin(req({ origin: "https://app.example", host: "app.example" })), true);
    assert.equal(isSameOrigin(req({ origin: "https://evil.example", host: "app.example" })), false);
    assert.equal(isSameOrigin(req({ host: "app.example" })), false);
    assert.equal(isSameOrigin(req({ origin: "not a url", host: "app.example" })), false);
    assert.equal(isSameOrigin(req({ origin: "https://app.example", "x-forwarded-host": "app.example", host: "internal:8080" })), true);
  });

  test("chart object paths reject traversal and odd input", () => {
    for (const bad of ["", "/abs/path.svg", "../secret", "a/../b.svg", "a//b.svg", "a\\b.svg", "a/b.svg?x=1", "a b.svg", "%2e%2e/x", ".hidden/x.svg", "x".repeat(600)]) {
      assert.equal(isSafeObjectPath(bad), false, bad);
    }
    for (const ok of ["runs/2026-09-15/AAA/daily-3f9a.svg", "direction/abc/def.svg"]) assert.equal(isSafeObjectPath(ok), true, ok);
    assert.equal(chartUrl("runs/a b/x.svg"), "/api/charts/runs/a%20b/x.svg");
  });
});

describe("invite tooling", () => {
  test("creates the profile and account, is idempotent, updates roles, and never emails", async () => {
    const { inviteUser } = await import("./invite.ts");
    const created: string[] = [];
    const auth = {
      getUserByEmail: async (email: string) => {
        if (!created.includes(email)) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
        return { uid: `uid-${email}` };
      },
      createUser: async (p: { email: string; emailVerified: boolean; disabled: boolean }) => {
        assert.equal(p.emailVerified, false, "an invited account is not pre-verified");
        created.push(p.email);
        return { uid: `uid-${p.email}` };
      },
      generatePasswordResetLink: async (email: string) => `https://reset.example/?for=${email}`,
    };
    const first = await inviteUser(db(), auth, { email: "  New.Person@Example.COM ", role: "researcher" });
    assert.equal(first.createdAccount, true);
    assert.equal(first.resetLink, null, "no link unless asked");
    const again = await inviteUser(db(), auth, { email: "new.person@example.com", role: "strategy_admin", includeResetLink: true });
    assert.equal(again.createdAccount, false);
    assert.equal(again.profileId, first.profileId, "same person, same profile");
    assert.match(again.resetLink ?? "", /reset\.example/);
    assert.equal((await pool.query(`select role from profiles where lower(email) = 'new.person@example.com'`)).rows[0].role, "strategy_admin");
    // The invited person can now sign in: their verified identity links to the pre-created profile.
    assert.equal((await resolveAuthorizedUser(db(), { uid: "uid-x", email: "new.person@example.com", emailVerified: true }))?.role, "strategy_admin");
  });

  test("rejects malformed e-mail addresses and unknown roles", async () => {
    const { inviteUser } = await import("./invite.ts");
    const auth = { getUserByEmail: async () => ({ uid: "u" }), createUser: async () => ({ uid: "u" }), generatePasswordResetLink: async () => "x" };
    await assert.rejects(inviteUser(db(), auth, { email: "not-an-email", role: "viewer" }), /valid e-mail/);
    await assert.rejects(inviteUser(db(), auth, { email: "a@b.co", role: "superuser" }), /role must be one of/);
    await assert.rejects(inviteUser(db(), auth, { email: "a@b.co", role: "viewer'; drop table profiles; --" }), /role must be one of/);
  });
});
