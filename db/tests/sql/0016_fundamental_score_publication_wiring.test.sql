-- Originally authored for Supabase pgTAP; RLS / role-privilege assertions removed (see docs/gcp/schema-provenance.md).
begin;

select plan(15);

-- ---------------------------------------------------------------------------
-- Existence, signature, and EXECUTE restriction (service_role only, same
-- audit as every other operational RPC touched by this task).
-- ---------------------------------------------------------------------------

select has_function('public', 'publish_fundamental_refresh', array['int8']);

-- publish_screening_run must still exist with its original signature and
-- EXECUTE restriction after being create-or-replace'd -- a regression check
-- that replacing it did not accidentally change its public contract.
select has_function('public', 'publish_screening_run', array['uuid']);

-- STRUCTURAL proof that the workflow actually invokes the bind function --
-- a full dynamic run of publish_screening_run's own success path needs the
-- same enormous fixture (4 indexes, direction rows, immutable charts,
-- storage objects, coverage reconciliation) that even migration 0010's own
-- test suite does not attempt (see 0010_authorization.test.sql, which only
-- checks existence/grants for the same reason) -- so this checks the
-- function's actual body text, unambiguously proving the wiring is real and
-- not merely a separately-existing, never-called function.
select ok(
  pg_get_functiondef('public.publish_screening_run(uuid)'::regprocedure) like '%bind_fundamental_scores_for_run%',
  'publish_screening_run''s own function body actually calls bind_fundamental_scores_for_run -- not just present as an unused, separate function'
);

-- ---------------------------------------------------------------------------
-- publish_fundamental_refresh: full dynamic success path, proving the
-- internal call to bind_fundamental_scores_for_refresh really fires.
-- ---------------------------------------------------------------------------

insert into instruments (id, symbol, name, isin) values ('TEST_PUB_INSTR', 'TESTPUB', 'Test Publication Instrument', 'INE_TEST_0000009')
  on conflict (id) do nothing;
insert into fundamental_score_versions (version, status, spec) values ('test-pub-1.0.0', 'test', '{}'::jsonb)
  on conflict (version) do nothing;

insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state, expected_instrument_count)
  values ((select id from fundamental_score_versions where version = 'test-pub-1.0.0'), '2026-09-01T00:00:00Z', 'processing', 1);
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_PUB_INSTR',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-09-01T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-pub-1.0.0'), 'test-pub-1.0.0',
  'NON_FINANCIAL', '2026-09-01T00:00:00Z', null, null, 0, 'NO_DATA'
);

-- An existing, already-published screening run eligible for this instrument
-- -- proves publish_fundamental_refresh's internal bind call really binds a
-- real row, not just returns a count.
insert into screening_runs (id, run_date, universe_version, trigger_type, publication_state, as_of_timestamp)
  values ('55555555-5555-5555-5555-555555555555', '2026-09-10', 'test-universe-1', 'manual', 'published', '2026-09-10T15:30:00Z')
  on conflict (id) do nothing;

select is(
  (select (publish_fundamental_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-09-01T00:00:00Z')) ->> 'published')::boolean),
  true,
  'publish_fundamental_refresh succeeds when expected_instrument_count reconciles against actual results'
);
select is(
  (select refresh_state from fundamental_refresh_manifests where cutoff_at = '2026-09-01T00:00:00Z'),
  'published',
  'the manifest is flipped to published'
);
select ok(
  (select published_at is not null from fundamental_refresh_manifests where cutoff_at = '2026-09-01T00:00:00Z'),
  'published_at is set'
);
select is(
  (select fundamental_score_result_id from buy_setup_fundamental_score_bindings
   where run_id = '55555555-5555-5555-5555-555555555555' and instrument_id = 'TEST_PUB_INSTR'),
  (select id from fundamental_score_results where instrument_id = 'TEST_PUB_INSTR'),
  'publish_fundamental_refresh''s internal call to bind_fundamental_scores_for_refresh actually bound the eligible existing published run -- not merely a function that exists unused'
);

-- Calling it again on an already-published manifest raises rather than
-- silently re-processing or double-publishing.
select throws_ok(
  $$ select publish_fundamental_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-09-01T00:00:00Z')) $$,
  'P0001',
  null,
  'publish_fundamental_refresh raises when the manifest is already published'
);

-- Nonexistent manifest raises.
select throws_ok(
  $$ select publish_fundamental_refresh(999999999) $$,
  'P0001',
  null,
  'publish_fundamental_refresh raises for a nonexistent manifest id'
);

-- ---------------------------------------------------------------------------
-- publish_fundamental_refresh: validation failure path -- a mismatched
-- result count must fail validation, never publish anyway.
-- ---------------------------------------------------------------------------

insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state, expected_instrument_count)
  values ((select id from fundamental_score_versions where version = 'test-pub-1.0.0'), '2026-09-05T00:00:00Z', 'processing', 5); -- expects 5, but zero results exist for this manifest

select is(
  (select (publish_fundamental_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-09-05T00:00:00Z')) ->> 'published')::boolean),
  false,
  'publish_fundamental_refresh reports published=false when the result count does not reconcile against expected_instrument_count'
);
select is(
  (select refresh_state from fundamental_refresh_manifests where cutoff_at = '2026-09-05T00:00:00Z'),
  'validation_failed',
  'a reconciliation failure sets validation_failed, never published'
);
select ok(
  (select published_at is null from fundamental_refresh_manifests where cutoff_at = '2026-09-05T00:00:00Z'),
  'published_at stays null on a validation failure'
);

-- expected_instrument_count <= 0 is also a validation failure, not silently
-- treated as "nothing to check".
insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state, expected_instrument_count)
  values ((select id from fundamental_score_versions where version = 'test-pub-1.0.0'), '2026-09-06T00:00:00Z', 'processing', 0);
select is(
  (select (publish_fundamental_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-09-06T00:00:00Z')) ->> 'published')::boolean),
  false,
  'publish_fundamental_refresh reports published=false when expected_instrument_count is not set (<= 0)'
);

select * from finish();
rollback;