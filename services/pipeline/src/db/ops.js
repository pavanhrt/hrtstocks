// Thin result-shaping layer over explicit SQL + the write helpers in ./write.js.
//
// The entry points (run-screening, analyze-buy-setup) were written against a
// `{ data, error }` result shape and check `error` after each call. These
// functions keep that shape so the (large, well-tested) pipeline logic is
// untouched, but every call site now carries its own explicit, parameterized
// SQL or explicit table/column/conflict arguments. Database failures THROW (the
// call sites' `if (error) throw error` lines become unreachable, which is the
// same outcome: the error propagates to the surrounding try/catch).
import { deleteWhere, insertMany, updateWhere, upsertMany } from "./write.js";

const asArray = (x) => (Array.isArray(x) ? x : [x]);

function shape(rows, mode) {
  if (mode === "many") return { data: rows, error: null };
  if (mode === "maybe") {
    if (rows.length > 1) throw new Error("Query returned more than one row where at most one was expected");
    return { data: rows[0] ?? null, error: null };
  }
  if (rows.length !== 1) throw new Error(`Query returned ${rows.length} rows where exactly one was expected`);
  return { data: rows[0], error: null };
}

/** mode: "many" (array), "maybe" (row or null), "single" (exactly one row). */
export async function select(db, sql, params = [], mode = "many") {
  return shape(await db.query(sql, params), mode);
}

/** `select count(*) as n ...` -> { count, error }. */
export async function count(db, sql, params = []) {
  const row = await db.one(sql, params);
  return { count: row?.n ?? 0, data: null, error: null };
}

export async function insert(db, table, rows, { returning = null, mode = "many" } = {}) {
  const out = await insertMany(db, table, asArray(rows), { returning });
  return returning ? shape(out, mode) : { data: null, error: null };
}

export async function upsert(db, table, rows, { conflict, ignoreDuplicates = false, returning = null, mode = "many" }) {
  const out = await upsertMany(db, table, asArray(rows), { conflict, ignoreDuplicates, returning });
  return returning ? shape(out, mode) : { data: null, error: null };
}

export async function update(db, table, set, where, { returning = null, mode = "many" } = {}) {
  const out = await updateWhere(db, table, set, where, { returning });
  return returning ? shape(out, mode) : { data: null, error: null };
}

export async function remove(db, table, where) {
  await deleteWhere(db, table, where);
  return { data: null, error: null };
}
