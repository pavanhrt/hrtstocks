-- Minimal pgTAP-compatible assertion functions, enough for the ported SQL tests
-- in db/tests/sql. Real pgTAP is not available in every Postgres we test on
-- (embedded test engine, Cloud SQL), so this shim keeps the test files
-- unchanged in style. Any failed assertion raises at finish().
create schema if not exists tap;

create table if not exists tap.results (n serial, ok boolean not null, descr text);

create or replace function tap.record(p_ok boolean, p_descr text) returns text language plpgsql as $$
begin
  insert into tap.results (ok, descr) values (coalesce(p_ok, false), p_descr);
  return (case when coalesce(p_ok, false) then 'ok' else 'not ok' end) || ' - ' || coalesce(p_descr, '');
end $$;

create or replace function tap.plan(p_n int) returns text language sql as $$ delete from tap.results; select '1..' || p_n $$;
create or replace function tap.ok(p_ok boolean, p_descr text default '') returns text language sql as $$ select tap.record(p_ok, p_descr) $$;
create or replace function tap.is(a anyelement, b anyelement, p_descr text default '') returns text language sql as $$
  select tap.record(a is not distinct from b, p_descr || case when a is not distinct from b then '' else format(' (got %s, want %s)', a, b) end) $$;
create or replace function tap.isnt(a anyelement, b anyelement, p_descr text default '') returns text language sql as $$ select tap.record(a is distinct from b, p_descr) $$;

create or replace function tap.has_table(p_schema name, p_table name, p_descr text default '') returns text language sql as $$
  select tap.record(exists (select 1 from pg_tables where schemaname = p_schema and tablename = p_table), coalesce(nullif(p_descr, ''), 'has table ' || p_table)) $$;
create or replace function tap.has_view(p_schema name, p_view name, p_descr text default '') returns text language sql as $$
  select tap.record(exists (select 1 from pg_views where schemaname = p_schema and viewname = p_view), coalesce(nullif(p_descr, ''), 'has view ' || p_view)) $$;
create or replace function tap.has_column(p_schema name, p_table name, p_column name, p_descr text default '') returns text language sql as $$
  select tap.record(exists (select 1 from information_schema.columns where table_schema = p_schema and table_name = p_table and column_name = p_column),
    coalesce(nullif(p_descr, ''), format('has column %s.%s', p_table, p_column))) $$;
create or replace function tap.has_function(p_schema name, p_fn name, p_args name[], p_descr text default '') returns text language sql as $$
  select tap.record(exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = p_schema and p.proname = p_fn
      and (select coalesce(array_agg(format_type(t, null) order by o), '{}') from unnest(p.proargtypes::oid[]) with ordinality as u(t, o))
        = (select coalesce(array_agg(format_type(to_regtype(a::text), null) order by o), '{}') from unnest(p_args) with ordinality as x(a, o))
  ), coalesce(nullif(p_descr, ''), 'has function ' || p_fn)) $$;

create or replace function tap._cols_of(p_schema name, p_table name, p_type text) returns setof name[] language sql as $$
  select array_agg(a.attname order by a.attname)
  from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
  cross join lateral unnest(c.conkey) k(attnum) join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
  where n.nspname = p_schema and t.relname = p_table and c.contype = p_type::"char"
  group by c.oid $$;
create or replace function tap.col_is_pk(p_schema name, p_table name, p_cols name[], p_descr text default '') returns text language sql as $$
  select tap.record(exists (select 1 from tap._cols_of(p_schema, p_table, 'p') x where x = (select array_agg(c order by c) from unnest(p_cols) c)), coalesce(nullif(p_descr, ''), 'pk ' || p_table)) $$;
create or replace function tap.col_is_unique(p_schema name, p_table name, p_cols name[], p_descr text default '') returns text language sql as $$
  select tap.record(exists (select 1 from tap._cols_of(p_schema, p_table, 'u') x where x = (select array_agg(c order by c) from unnest(p_cols) c)), coalesce(nullif(p_descr, ''), 'unique ' || p_table)) $$;

create or replace function tap.throws_ok(p_sql text, p_state text, p_msg text default null, p_descr text default '') returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return tap.record(sqlstate = p_state and (p_msg is null or sqlerrm = p_msg), p_descr || case when sqlstate = p_state then '' else format(' (got %s: %s)', sqlstate, sqlerrm) end);
  end;
  return tap.record(false, p_descr || ' (no error raised)');
end $$;
create or replace function tap.lives_ok(p_sql text, p_descr text default '') returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return tap.record(false, p_descr || format(' (%s: %s)', sqlstate, sqlerrm));
  end;
  return tap.record(true, p_descr);
end $$;

create or replace function tap.finish() returns setof text language plpgsql as $$
declare v_failed text;
begin
  select string_agg(coalesce(descr, '#' || n), '; ') into v_failed from tap.results where not ok;
  if v_failed is not null then raise exception 'tap: failed assertion(s): %', v_failed; end if;
  return next 'ok - ' || (select count(*) from tap.results) || ' assertion(s) passed';
end $$;
