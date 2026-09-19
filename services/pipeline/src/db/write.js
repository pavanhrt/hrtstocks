// Explicit, parameterized write helpers for the pipeline. Each call names its
// table and columns; nothing is inferred from a query builder. Identifiers are
// validated against a strict pattern AND (for columns) against the table's real
// column list, and every value is bound as a parameter, so no caller-supplied
// text can reach SQL text.

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name) {
  if (typeof name !== "string" || !IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${String(name)}`);
  return `"${name}"`;
}

/** `returning` is null, "*", or a list of column names. */
function returningSql(returning) {
  if (!returning) return "";
  if (returning === "*") return " returning *";
  return ` returning ${returning.map(ident).join(", ")}`;
}

const columnCache = new WeakMap();

/** Column name -> udt_name for a table, cached per database handle. */
async function columnTypes(db, table) {
  ident(table);
  let perDb = columnCache.get(db);
  if (!perDb) columnCache.set(db, (perDb = new Map()));
  if (!perDb.has(table)) {
    const rows = await db.query(
      `select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [table],
    );
    if (rows.length === 0) throw new Error(`Unknown table: ${table}`);
    perDb.set(table, new Map(rows.map((r) => [r.column_name, r.udt_name])));
  }
  return perDb.get(table);
}

/** JSON/JSONB values must be serialized explicitly: node-postgres would send a JS array as a Postgres array. */
function bindValue(value, udt) {
  if (value === undefined) return null;
  if (value === null) return null;
  if ((udt === "jsonb" || udt === "json") && typeof value !== "string") return JSON.stringify(value);
  if ((udt === "jsonb" || udt === "json") && typeof value === "string") return JSON.stringify(value);
  return value;
}

function unionColumns(rows) {
  const cols = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] === undefined) continue;
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

// PostgreSQL allows at most 65535 bind parameters per statement.
const MAX_PARAMS = 60_000;

async function insertChunks(db, table, rows, { onConflictSql = "", returning = null }) {
  if (rows.length === 0) return [];
  const types = await columnTypes(db, table);
  const cols = unionColumns(rows);
  if (cols.length === 0) throw new Error(`No columns to write to ${table}`);
  for (const c of cols) {
    ident(c);
    if (!types.has(c)) throw new Error(`Unknown column ${table}.${c}`);
  }
  const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const out = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    const tuples = chunk.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(bindValue(row[c], types.get(c)));
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const ret = returningSql(returning);
    const sql = `insert into ${ident(table)} (${cols.map(ident).join(", ")}) values ${tuples.join(", ")}${onConflictSql(cols)}${ret}`;
    const res = await db.query(sql, params);
    out.push(...res);
  }
  return out;
}

/** INSERT rows. Returns the requested `returning` columns for every inserted row. */
export async function insertMany(db, table, rows, { returning = null } = {}) {
  return insertChunks(db, table, rows, { onConflictSql: () => "", returning });
}

/**
 * INSERT ... ON CONFLICT. `conflict` lists the unique columns. By default the
 * existing row is updated with every supplied non-key column (merge); with
 * `ignoreDuplicates` the existing row is left untouched.
 */
export async function upsertMany(db, table, rows, { conflict, ignoreDuplicates = false, returning = null }) {
  if (!Array.isArray(conflict) || conflict.length === 0) throw new Error("upsertMany requires conflict columns");
  conflict.forEach(ident);
  const onConflictSql = (cols) => {
    const target = `(${conflict.map(ident).join(", ")})`;
    const updates = cols.filter((c) => !conflict.includes(c));
    if (ignoreDuplicates || updates.length === 0) return ` on conflict ${target} do nothing`;
    return ` on conflict ${target} do update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
  };
  return insertChunks(db, table, rows, { onConflictSql, returning });
}

/**
 * Builds a WHERE clause from a plain object:
 *   { col: value }                equality (null -> IS NULL)
 *   { col: { eq: v } }            equality
 *   { col: { in: [..] } }         = any($n)
 *   { col: { neq: v } }           <> (IS DISTINCT FROM for null-safe)
 *   { col: { lt|lte|gt|gte: v } } comparisons
 */
function buildWhere(where, startIndex = 1) {
  const clauses = [];
  const params = [];
  const next = (v) => {
    params.push(v);
    return `$${startIndex + params.length - 1}`;
  };
  for (const [col, cond] of Object.entries(where)) {
    const c = ident(col);
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const [op, v] of Object.entries(cond)) {
        if (op === "eq") clauses.push(`${c} = ${next(v)}`);
        else if (op === "in") clauses.push(`${c} = any(${next(v)})`);
        else if (op === "neq") clauses.push(`${c} is distinct from ${next(v)}`);
        else if (op === "lt") clauses.push(`${c} < ${next(v)}`);
        else if (op === "lte") clauses.push(`${c} <= ${next(v)}`);
        else if (op === "gt") clauses.push(`${c} > ${next(v)}`);
        else if (op === "gte") clauses.push(`${c} >= ${next(v)}`);
        else throw new Error(`Unsupported condition operator: ${op}`);
      }
    } else if (cond === null) {
      clauses.push(`${c} is null`);
    } else {
      clauses.push(`${c} = ${next(cond)}`);
    }
  }
  if (clauses.length === 0) throw new Error("Refusing to run a write with an empty WHERE clause");
  return { sql: clauses.join(" and "), params };
}

/** UPDATE table SET ... WHERE ... ; returns the requested `returning` columns. */
export async function updateWhere(db, table, set, where, { returning = null } = {}) {
  const types = await columnTypes(db, table);
  const cols = Object.keys(set).filter((k) => set[k] !== undefined);
  if (cols.length === 0) return [];
  const params = [];
  const assignments = cols.map((c) => {
    if (!types.has(c)) throw new Error(`Unknown column ${table}.${c}`);
    params.push(bindValue(set[c], types.get(c)));
    return `${ident(c)} = $${params.length}`;
  });
  const w = buildWhere(where, params.length + 1);
  const ret = returningSql(returning);
  return db.query(`update ${ident(table)} set ${assignments.join(", ")} where ${w.sql}${ret}`, [...params, ...w.params]);
}

/** DELETE FROM table WHERE ... (an empty WHERE is refused). Returns the deleted row count. */
export async function deleteWhere(db, table, where) {
  ident(table);
  const w = buildWhere(where);
  const rows = await db.query(`delete from ${ident(table)} where ${w.sql} returning 1 as n`, w.params);
  return rows.length;
}
