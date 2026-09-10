-- Cross-invocation provider rate limiting (closes problem #10: the Fyers
-- pacer in providers/fyers.js is an in-memory module-level variable, reset
-- every cold isolate and invisible to any other concurrent invocation --
-- e.g. two batch-workers processing different pipeline_batches of the same
-- run, which the durable pipeline in migration 0006 is designed to allow).
--
-- One row per (provider, minute_bucket); a caller atomically claims a slot
-- with a single UPSERT and a conditional WHERE, so "claim a slot or find out
-- I'm over budget this minute" is one round trip with no read-then-write
-- race:
--
--   insert into provider_rate_limit_buckets (provider, minute_bucket, request_count)
--   values ($1, date_trunc('minute', now()), 1)
--   on conflict (provider, minute_bucket) do update
--     set request_count = provider_rate_limit_buckets.request_count + 1
--     where provider_rate_limit_buckets.request_count < $2
--   returning request_count;
--
-- Zero rows returned means the bucket is full for this provider this
-- minute -- the caller must wait for the next minute boundary (or retry
-- with backoff) rather than call the provider.
--
-- NOT APPLIED to any remote project as part of authoring this file, per this
-- initiative's instruction to draft migrations locally only.

create table provider_rate_limit_buckets (
  provider text not null,
  minute_bucket timestamptz not null,
  request_count integer not null default 0,
  primary key (provider, minute_bucket)
);

comment on table provider_rate_limit_buckets is
  'Cross-invocation request pacing. Rows older than a few minutes are safe to '
  'delete periodically (or leave -- the table is small and self-bounding at '
  'one row per provider per minute of actual traffic).';

-- The atomic acquire primitive itself: a plain SQL function (no
-- SECURITY DEFINER) so it runs under the caller's own RLS context -- the
-- production caller is always the Edge Function's service/secret-role
-- client, which bypasses RLS entirely, same as every other write in this
-- pipeline. A non-privileged caller invoking this RPC would simply have
-- its insert/update blocked by RLS (no write policy is granted below),
-- which is a safe default, not a workaround needed here.
create or replace function try_acquire_rate_limit_slot(p_provider text, p_minute_bucket timestamptz, p_limit integer)
returns table (request_count integer)
language sql
as $$
  insert into provider_rate_limit_buckets (provider, minute_bucket, request_count)
  values (p_provider, p_minute_bucket, 1)
  on conflict (provider, minute_bucket) do update
    set request_count = provider_rate_limit_buckets.request_count + 1
    where provider_rate_limit_buckets.request_count < p_limit
  returning provider_rate_limit_buckets.request_count;
$$;

alter table provider_rate_limit_buckets enable row level security;
create policy provider_rate_limit_buckets_read on provider_rate_limit_buckets
  for select using (public.current_role_name() in ('researcher', 'strategy_admin', 'system_admin'));
