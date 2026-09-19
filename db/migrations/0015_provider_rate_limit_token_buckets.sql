-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Correction (fundamental-score correction pass 3, 2026-09-16, item 8):
-- fixes a real flaw in rate-limiter.js's original design, which modeled
-- Upstox's 2,000-per-rolling-30-minute limit as a FIXED window aligned to
-- :00/:30 past the hour (via migration 0007's existing minute_bucket
-- primitive, reused with a 30-minute-aligned key). A fixed window is NOT
-- equivalent to a rolling window and is NOT conservative at a boundary: a
-- caller could exhaust 2,000 slots in the last second of window
-- [10:00,10:30) and ANOTHER 2,000 in the first second of [10:30,11:00) --
-- 4,000 requests in about two real seconds, double the documented limit,
-- with no rolling-window check ever catching it. (The earlier version of
-- rate-limiter.js incorrectly claimed this fixed-window approach was "always
-- at least as conservative as a true rolling window, never less" -- that
-- claim was wrong and is retracted here.)
--
-- Fix: a real, atomic, persistent TOKEN BUCKET. A token bucket started full
-- and refilled continuously at `capacity / window_seconds` tokens/second has
-- a mathematically guaranteed property a fixed window does not: it can NEVER
-- allow more than `capacity` requests in ANY rolling window of
-- `window_seconds` seconds, including one that straddles a boundary --
-- because there is no boundary. This migration adds a small, generic,
-- provider-agnostic primitive (not reusing migration 0007's fixed-window
-- table, which remains unmodified and in place for Fyers' own per-minute
-- pacing, unaffected by this fix) usable by any provider needing a real
-- rolling-window guarantee, keyed by an arbitrary bucket_key so the same
-- table serves Upstox's three tiers (per-second/per-minute/per-30-minute)
-- via three distinct keys, exactly as the old fixed-window design did.
--
-- Atomicity: `try_acquire_token_bucket_slot` performs an INSERT ... ON
-- CONFLICT DO NOTHING (so a first-ever call for a bucket_key creates the row
-- without a race), then a SELECT ... FOR UPDATE (row lock -- a second,
-- concurrent caller for the SAME bucket_key blocks until the first commits,
-- then sees its updated tokens/updated_at), then computes the refill and
-- writes back the new balance in the same transaction. This is a real,
-- serialized, single-round-trip atomic primitive, not a read-then-write race
-- the caller could lose.
--
-- NOT YET APPLIED to any database -- written, reviewed, and syntax-checked,
-- consistent with this task's own "no live migration" constraint.

create table provider_rate_limit_token_buckets (
  bucket_key text primary key,
  capacity numeric not null check (capacity > 0),
  refill_per_second numeric not null check (refill_per_second > 0),
  tokens numeric not null,
  updated_at timestamptz not null default now()
);

comment on table provider_rate_limit_token_buckets is
  'A real, atomic, continuously-refilling token bucket per bucket_key -- unlike '
  'a fixed-window counter, this gives a mathematically guaranteed cap on '
  'requests within ANY rolling window of (capacity / refill_per_second) '
  'seconds, including one that straddles a bucket_key''s own "creation instant". '
  'capacity/refill_per_second are fixed at first creation for a given '
  'bucket_key (a later call with different values is ignored, never silently '
  'weakening or tightening an in-flight bucket) -- delete the row to reset.';

-- Plain plpgsql function (no SECURITY DEFINER) so it runs under the caller's
-- own privileges, mirroring migration 0007's try_acquire_rate_limit_slot
-- exactly: the production caller is always the Edge Function's
-- service-role client (which has full table access via Supabase's own
-- platform-level default grants, not repeated here), and a non-privileged
-- caller is blocked by the ordinary absence of an INSERT/UPDATE grant below
-- -- a safe default, not a workaround needed here.
create or replace function try_acquire_token_bucket_slot(
  p_bucket_key text,
  p_capacity numeric,
  p_refill_per_second numeric,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row provider_rate_limit_token_buckets%rowtype;
  v_elapsed_seconds numeric;
  v_refilled numeric;
begin
  insert into provider_rate_limit_token_buckets (bucket_key, capacity, refill_per_second, tokens, updated_at)
  values (p_bucket_key, p_capacity, p_refill_per_second, p_capacity, p_now)
  on conflict (bucket_key) do nothing;

  select * into v_row from provider_rate_limit_token_buckets where bucket_key = p_bucket_key for update;

  v_elapsed_seconds := greatest(0, extract(epoch from (p_now - v_row.updated_at)));
  v_refilled := least(v_row.capacity, v_row.tokens + v_elapsed_seconds * v_row.refill_per_second);

  if v_refilled < 1 then
    update provider_rate_limit_token_buckets set tokens = v_refilled, updated_at = p_now where bucket_key = p_bucket_key;
    return false;
  end if;

  update provider_rate_limit_token_buckets set tokens = v_refilled - 1, updated_at = p_now where bucket_key = p_bucket_key;
  return true;
end;
$function$;