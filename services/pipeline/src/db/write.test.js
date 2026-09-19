import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startTestPostgres } from "../../../../db/tests/pg-harness.mjs";
import { dbFromPool } from "./client.js";
import { deleteWhere, insertMany, updateWhere, upsertMany } from "./write.js";

let pgx;
let pool;
let db;

before(async () => {
  pgx = await startTestPostgres();
  pool = new pg.Pool({ connectionString: pgx.url, max: 3 });
  await pool.query(`create table wtest (
    id bigint generated always as identity primary key,
    k text not null, v integer, meta jsonb, tags text[], d date, ts timestamptz, n numeric,
    unique (k)
  )`);
  db = dbFromPool(pool);
});
after(async () => {
  await pool?.end();
  await pgx?.stop();
});

const count = async () => Number((await pool.query("select count(*) from wtest")).rows[0].count);

describe("insertMany", () => {
  test("JSON arrays go to jsonb columns as JSON, text arrays stay Postgres arrays", async () => {
    await insertMany(db, "wtest", [{ k: "a", meta: [1, 2, { x: 3 }], tags: ["p", "q"], v: 1 }]);
    const row = (await pool.query("select * from wtest where k = 'a'")).rows[0];
    assert.deepEqual(row.meta, [1, 2, { x: 3 }]);
    assert.deepEqual(row.tags, ["p", "q"]);
  });

  test("returns requested columns, and objects/strings/null bind correctly", async () => {
    const out = await insertMany(db, "wtest", [{ k: "b", meta: { a: 1 } }, { k: "c", meta: "text-as-json" }, { k: "d", meta: null }], { returning: ["k", "meta"] });
    assert.deepEqual(out.map((r) => r.k), ["b", "c", "d"]);
    assert.equal(out[1].meta, "text-as-json");
    assert.equal(out[2].meta, null);
  });

  test("rows with different key sets are unioned; missing keys become NULL", async () => {
    await insertMany(db, "wtest", [{ k: "e", v: 5 }, { k: "f", n: 1.5 }]);
    const rows = (await pool.query("select k, v, n from wtest where k in ('e','f') order by k")).rows;
    assert.equal(rows[0].v, 5);
    assert.equal(rows[1].v, null);
    assert.equal(Number(rows[1].n), 1.5);
  });

  test("large batches are chunked below the 65535 bind-parameter limit", async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ k: `bulk-${i}`, v: i, d: "2026-09-15" }));
    const before = await count();
    await insertMany(db, "wtest", rows);
    assert.equal((await count()) - before, 30_000);
  });
});

describe("upsertMany", () => {
  test("merges supplied columns into the existing row and leaves the rest", async () => {
    await insertMany(db, "wtest", [{ k: "u1", v: 1, tags: ["keep"] }]);
    await upsertMany(db, "wtest", [{ k: "u1", v: 2 }], { conflict: ["k"] });
    const row = (await pool.query("select v, tags from wtest where k = 'u1'")).rows[0];
    assert.equal(row.v, 2);
    assert.deepEqual(row.tags, ["keep"]);
  });

  test("ignoreDuplicates never overwrites", async () => {
    await upsertMany(db, "wtest", [{ k: "u1", v: 99 }, { k: "u2", v: 7 }], { conflict: ["k"], ignoreDuplicates: true });
    assert.equal((await pool.query("select v from wtest where k = 'u1'")).rows[0].v, 2);
    assert.equal((await pool.query("select v from wtest where k = 'u2'")).rows[0].v, 7);
  });

  test("requires conflict columns", async () => {
    await assert.rejects(upsertMany(db, "wtest", [{ k: "x" }], { conflict: [] }), /conflict columns/);
  });
});

describe("updateWhere / deleteWhere", () => {
  test("update supports equality, in, neq and null conditions", async () => {
    await insertMany(db, "wtest", [{ k: "w1", v: 1 }, { k: "w2", v: 1 }, { k: "w3" }]);
    const changed = await updateWhere(db, "wtest", { v: 10 }, { k: { in: ["w1", "w2"] }, v: { neq: 10 } }, { returning: ["k"] });
    assert.deepEqual(changed.map((r) => r.k).sort(), ["w1", "w2"]);
    const nulls = await updateWhere(db, "wtest", { v: 3 }, { k: "w3", v: null }, { returning: ["k"] });
    assert.equal(nulls.length, 1);
    assert.deepEqual(await updateWhere(db, "wtest", { v: 3 }, { k: "w3", v: null }, { returning: ["k"] }), []);
  });

  test("update serializes JSON values", async () => {
    await updateWhere(db, "wtest", { meta: [{ stage: "x" }] }, { k: "w1" });
    assert.deepEqual((await pool.query("select meta from wtest where k = 'w1'")).rows[0].meta, [{ stage: "x" }]);
  });

  test("delete returns the deleted count and refuses an empty WHERE", async () => {
    assert.equal(await deleteWhere(db, "wtest", { k: { in: ["w1", "w2", "w3"] } }), 3);
    await assert.rejects(deleteWhere(db, "wtest", {}), /empty WHERE/);
    await assert.rejects(updateWhere(db, "wtest", { v: 1 }, {}), /empty WHERE/);
  });
});

describe("safety", () => {
  test("hostile values are bound, not executed", async () => {
    await insertMany(db, "wtest", [{ k: "x'); drop table wtest; --" }]);
    assert.ok((await count()) > 0);
    assert.equal((await pool.query("select count(*) from wtest where k like 'x''%'")).rows[0].count, "1");
  });

  test("unsafe identifiers, unknown tables and unknown columns are rejected before any SQL runs", async () => {
    await assert.rejects(insertMany(db, "wtest; drop table wtest", [{ k: "a" }]), /Unsafe SQL identifier/);
    await assert.rejects(insertMany(db, "wtest", [{ 'k"; drop table wtest; --': 1 }]), /Unsafe SQL identifier/);
    await assert.rejects(insertMany(db, "wtest", [{ nope: 1 }]), /Unknown column/);
    await assert.rejects(insertMany(db, "no_such_table", [{ a: 1 }]), /Unknown table/);
    await assert.rejects(deleteWhere(db, "wtest", { "k or 1=1": 1 }), /Unsafe SQL identifier/);
  });
});
