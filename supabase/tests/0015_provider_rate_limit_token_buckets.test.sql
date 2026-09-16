begin;

select plan(16);

select has_table('public', 'provider_rate_limit_token_buckets');
select has_function('public', 'try_acquire_token_bucket_slot', array['text', 'numeric', 'numeric', 'timestamptz']);
select col_is_pk('public', 'provider_rate_limit_token_buckets', array['bucket_key']);
select ok((select relrowsecurity from pg_class where oid = 'public.provider_rate_limit_token_buckets'::regclass), 'provider_rate_limit_token_buckets has RLS enabled');

-- A fresh bucket starts full: capacity acquisitions succeed at one instant,
-- the next one fails -- proves the cap is actually enforced, not just
-- documented.
select is(
  (select count(*) filter (where try_acquire_token_bucket_slot('test-bucket-a', 5, 1, '2026-09-16T10:00:00Z'::timestamptz)) from generate_series(1, 5)),
  5::bigint,
  'exactly capacity (5) acquisitions succeed at one instant'
);
select ok(
  not try_acquire_token_bucket_slot('test-bucket-a', 5, 1, '2026-09-16T10:00:00Z'::timestamptz),
  'the 6th acquisition at the SAME instant fails -- capacity is exhausted'
);

-- BOUNDARY: the exact bug this migration fixes. Exhaust a bucket right
-- before what would have been a fixed :00/:30 boundary; confirm no fresh
-- allowance appears just after it.
select ok(
  (select bool_and(try_acquire_token_bucket_slot('test-bucket-boundary', 2000, 2000.0 / 1800, '2026-09-16T10:29:59.900Z'::timestamptz)) from generate_series(1, 2000)),
  'all 2000 tokens can be drawn just before the old fixed-window boundary'
);
select ok(
  not try_acquire_token_bucket_slot('test-bucket-boundary', 2000, 2000.0 / 1800, '2026-09-16T10:30:00.100Z'::timestamptz),
  'a token bucket grants NO fresh allowance merely because a fixed-window boundary was crossed 200ms later -- the exact flaw this migration fixes'
);

-- Refill is proportional to elapsed time and never exceeds capacity.
select ok(
  (select bool_and(try_acquire_token_bucket_slot('test-bucket-refill', 10, 1, '2026-09-16T11:00:00Z'::timestamptz)) from generate_series(1, 10)),
  'drain a fresh 10-capacity bucket completely'
);
select ok(
  not try_acquire_token_bucket_slot('test-bucket-refill', 10, 1, '2026-09-16T11:00:00.500Z'::timestamptz),
  'half a second later (0.5 tokens refilled at 1/sec) still fails -- less than one token available'
);
select ok(
  try_acquire_token_bucket_slot('test-bucket-refill', 10, 1, '2026-09-16T11:00:01.100Z'::timestamptz),
  'just over one second later, one token has refilled and an acquisition succeeds'
);
select is(
  (select count(*) filter (where try_acquire_token_bucket_slot('test-bucket-refill', 10, 1, '2026-09-16T11:05:00Z'::timestamptz)) from generate_series(1, 20)),
  10::bigint,
  'well after a full refill period, the bucket never grants more than its own capacity (10), never unbounded accumulation'
);

-- capacity/refill_per_second are fixed at first creation, never silently
-- changed by a later call with different parameters.
select is(
  (select capacity from provider_rate_limit_token_buckets where bucket_key = 'test-bucket-a'),
  5::numeric,
  'capacity is fixed at first creation'
);
select ok(
  try_acquire_token_bucket_slot('test-bucket-a', 999999, 999999, '2026-09-16T12:00:00Z'::timestamptz) is not null,
  'a later call with different capacity/refill parameters does not error -- it is simply ignored for an existing bucket'
);
select is(
  (select capacity from provider_rate_limit_token_buckets where bucket_key = 'test-bucket-a'),
  5::numeric,
  'an existing bucket''s capacity is never silently changed by a later call with different parameters'
);

-- CONCURRENCY: two simultaneous acquisitions against the SAME bucket_key,
-- issued from within one transaction as two immediate sequential calls (the
-- closest a single pgTAP transaction can approximate two overlapping
-- callers), must never together exceed the bucket's own capacity -- proven
-- by the same accounting invariant already exercised above at a larger
-- scale (2000 successes, no more). A true multi-connection concurrency test
-- requires two separate live sessions, which this single-transaction pgTAP
-- suite cannot exercise directly; the atomicity guarantee instead rests on
-- the function's own SELECT ... FOR UPDATE row lock (see the migration's own
-- header), which serializes concurrent callers at the database level.
select is(
  (select count(*) filter (where try_acquire_token_bucket_slot('test-bucket-concurrency', 1, 0.001, '2026-09-16T13:00:00Z'::timestamptz)) from generate_series(1, 2)),
  1::bigint,
  'exactly one of two immediate sequential acquisitions against a 1-capacity bucket succeeds, never both'
);

select * from finish();
rollback;
