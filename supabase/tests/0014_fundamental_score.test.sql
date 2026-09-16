begin;

select plan(76);

-- Tables exist.
select has_table('public', 'fundamental_source_snapshots');
select has_table('public', 'fundamental_score_versions');
select has_table('public', 'fundamental_refresh_manifests');
select has_table('public', 'fundamental_score_results');
select has_table('public', 'fundamental_score_components');
select has_table('public', 'buy_setup_fundamental_score_bindings');

-- Immutability / point-in-time columns.
select has_column('public', 'fundamental_score_results', 'cutoff_at');
select has_column('public', 'fundamental_score_results', 'terminal_status');
select has_column('public', 'fundamental_score_results', 'total_score');
select has_column('public', 'fundamental_score_results', 'grade');
select has_column('public', 'fundamental_score_results', 'coverage_percentage');
select has_column('public', 'fundamental_source_snapshots', 'publication_timestamp');
select has_column('public', 'fundamental_source_snapshots', 'supersedes_id');

-- Correction 3: denormalized score_version string for Viewer access without
-- a second, permission-denied query against fundamental_score_versions.
select has_column('public', 'fundamental_score_results', 'score_version');

-- REVISED 2026-09-16 (correction 3) -- timestamp-basis columns exist and
-- audit_status / publication_timestamp are honestly nullable (undisclosed
-- is never coerced into a disclosed value).
select has_column('public', 'fundamental_source_snapshots', 'available_from');
select has_column('public', 'fundamental_source_snapshots', 'timestamp_basis');
select ok(
  (select is_nullable = 'YES' from information_schema.columns
   where table_schema = 'public' and table_name = 'fundamental_source_snapshots' and column_name = 'audit_status'),
  'audit_status is nullable -- an undisclosed audit status is never stored as unaudited/audited/limited_review'
);
select ok(
  (select is_nullable = 'YES' from information_schema.columns
   where table_schema = 'public' and table_name = 'fundamental_source_snapshots' and column_name = 'publication_timestamp'),
  'publication_timestamp is nullable -- a provider that never discloses a real filing/publication timestamp (e.g. Upstox) is never assigned a fabricated one'
);
select ok(
  (select is_nullable = 'NO' from information_schema.columns
   where table_schema = 'public' and table_name = 'fundamental_source_snapshots' and column_name = 'available_from'),
  'available_from is never null -- every snapshot has a defensible availability floor, disclosed or retrieval-based'
);
select ok(
  (select is_nullable = 'NO' from information_schema.columns
   where table_schema = 'public' and table_name = 'fundamental_source_snapshots' and column_name = 'timestamp_basis'),
  'timestamp_basis is never null -- every snapshot honestly records which kind of timestamp available_from actually is'
);
select ok(
  (select true from information_schema.check_constraints where constraint_name = 'fundamental_source_snapshots_basis_consistency'),
  'fundamental_source_snapshots enforces basis/publication_timestamp/available_from consistency at the DB layer'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fundamental_source_snapshots' and column_name = 'publication_timestamp_is_estimated'
  ),
  'publication_timestamp_is_estimated is removed -- replaced entirely by the honest timestamp-basis model'
);

-- REVISED 2026-09-16 (correction 7) -- 'auth_required' is a valid
-- refresh_state, distinct from 'validation_failed'/'processing'.
select ok(
  exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'fundamental_refresh_manifests' and pg_get_constraintdef(c.oid) like '%auth_required%'
  ),
  'fundamental_refresh_manifests.refresh_state allows auth_required (token-expiry-mid-refresh is a distinct, actionable state)'
);

-- Uniqueness that enforces immutability per (instrument, version, cutoff).
select col_is_unique('public', 'fundamental_score_results', array['instrument_id', 'score_version_id', 'cutoff_at'],
  'a score result is insert-only per instrument/version/cutoff -- a later filing can only produce a new row, never update this one');

-- Terminal-state consistency constraint (never a numeric score without a
-- terminal_status of SCORED, and vice versa).
select ok(
  (select true from information_schema.check_constraints where constraint_name = 'fundamental_score_results_terminal_consistency'),
  'fundamental_score_results enforces total_score/grade non-null iff terminal_status=SCORED'
);

-- Correction 1: historical score pinning -- the binding table and its PK.
select col_is_pk('public', 'buy_setup_fundamental_score_bindings', array['run_id', 'instrument_id'],
  'a screening run binds to at most one fundamental result per instrument, permanently');
select has_function('public', 'bind_fundamental_scores_for_refresh', array['int8']);

-- Correction 6: the mirror-image, run-keyed bind entry point exists.
select has_function('public', 'bind_fundamental_scores_for_run', array['uuid']);

-- Correction 5: both bind RPCs are service_role-only -- never callable from
-- a browser session (anon or authenticated).
select ok(
  not has_function_privilege('anon', 'public.bind_fundamental_scores_for_refresh(bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.bind_fundamental_scores_for_refresh(bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.bind_fundamental_scores_for_refresh(bigint)', 'EXECUTE'),
  'bind_fundamental_scores_for_refresh EXECUTE is restricted to service_role only'
);
select ok(
  not has_function_privilege('anon', 'public.bind_fundamental_scores_for_run(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.bind_fundamental_scores_for_run(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.bind_fundamental_scores_for_run(uuid)', 'EXECUTE'),
  'bind_fundamental_scores_for_run EXECUTE is restricted to service_role only'
);

-- Correction 2: real append-only enforcement -- triggers exist on every
-- table that must be immutable.
select ok(
  (select true from pg_trigger where tgname = 'fundamental_source_snapshots_immutable' and not tgisinternal),
  'fundamental_source_snapshots has an immutability trigger'
);
select ok(
  (select true from pg_trigger where tgname = 'fundamental_score_results_immutable' and not tgisinternal),
  'fundamental_score_results has an immutability trigger'
);
select ok(
  (select true from pg_trigger where tgname = 'fundamental_score_components_immutable' and not tgisinternal),
  'fundamental_score_components has an immutability trigger'
);
select ok(
  (select true from pg_trigger where tgname = 'fundamental_score_bindings_immutable' and not tgisinternal),
  'buy_setup_fundamental_score_bindings has an immutability trigger'
);

-- Attempted UPDATE/DELETE on a validated (non-PENDING) snapshot must fail.
-- (Uses synthetic instrument rows scoped to this transaction; rolled back
-- at the end regardless of outcome.)
insert into instruments (id, symbol, name, isin) values ('TEST_FUND_INSTR', 'TESTFUND', 'Test Fundamentals Instrument', 'INE_TEST_0000001')
  on conflict (id) do nothing;

insert into fundamental_source_snapshots (
  instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
  audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
) values (
  'TEST_FUND_INSTR', 'TESTFUND', 'test-provider', 'test-locator-1', '2026-03-31', 'annual', 'consolidated',
  'audited', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', 'EXCHANGE_FILING', '2026-05-02T00:00:00Z', 'INR', '{"revenue": 100}'::jsonb, 'sha256:test', 'VALID'
);

select throws_ok(
  $$ update fundamental_source_snapshots set raw_values = '{"revenue": 999}'::jsonb where instrument_id = 'TEST_FUND_INSTR' $$,
  'P0001',
  null,
  'UPDATE on a VALID (already-validated) snapshot is rejected'
);
select throws_ok(
  $$ delete from fundamental_source_snapshots where instrument_id = 'TEST_FUND_INSTR' $$,
  'P0001',
  null,
  'DELETE on a snapshot is always rejected, regardless of validation_status'
);

-- A PENDING snapshot may have ONLY validation_status/validation_errors
-- updated -- attempting to change raw_values on a PENDING row is still
-- rejected.
insert into fundamental_source_snapshots (
  instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
  audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
) values (
  'TEST_FUND_INSTR', 'TESTFUND', 'test-provider', 'test-locator-2', '2026-06-30', 'quarterly', 'consolidated',
  'audited', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 'EXCHANGE_FILING', '2026-08-02T00:00:00Z', 'INR', '{"revenue": 50}'::jsonb, 'sha256:test2', 'PENDING'
);
select lives_ok(
  $$ update fundamental_source_snapshots set validation_status = 'VALID' where source_locator = 'test-locator-2' $$,
  'a PENDING snapshot may transition validation_status forward'
);
select throws_ok(
  $$ update fundamental_source_snapshots set raw_values = '{"revenue": 1}'::jsonb where source_locator = 'test-locator-2' $$,
  'P0001',
  null,
  'a snapshot that has since become VALID can no longer have raw_values changed'
);

-- REVISED 2026-09-16 (correction 2/3) -- an Upstox-shaped snapshot: no
-- disclosed audit status, no disclosed publication timestamp, honestly
-- marked RETRIEVAL_ONLY. Must be accepted and must never be coerced into a
-- disclosed value.
insert into fundamental_source_snapshots (
  instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
  audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
) values (
  'TEST_FUND_INSTR', 'TESTFUND', 'upstox', 'test-locator-3', '2026-06-30', 'quarterly', 'consolidated',
  null, null, '2026-08-05T00:00:00Z', 'RETRIEVAL_ONLY', '2026-08-05T00:00:00Z', 'INR', '{"revenue": 55}'::jsonb, 'sha256:test3', 'PENDING'
);
select is(
  (select audit_status from fundamental_source_snapshots where source_locator = 'test-locator-3'),
  null,
  'an undisclosed audit status is stored as null, never coerced into audited/limited_review/unaudited'
);
select is(
  (select publication_timestamp from fundamental_source_snapshots where source_locator = 'test-locator-3'),
  null,
  'a provider that discloses no real publication timestamp is stored as publication_timestamp = null, never backfilled with retrieved_at'
);

-- The basis-consistency constraint rejects every internally-contradictory
-- combination -- mirrors normalize.js's own RETRIEVAL_ONLY/disclosed-basis
-- validation at the DB layer.
select throws_ok(
  $$ insert into fundamental_source_snapshots (
       instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
       audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
     ) values (
       'TEST_FUND_INSTR', 'TESTFUND', 'upstox', 'test-locator-bad-1', '2026-06-30', 'quarterly', 'consolidated',
       null, '2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z', 'RETRIEVAL_ONLY', '2026-08-05T00:00:00Z', 'INR', '{}'::jsonb, 'sha256:bad1', 'PENDING'
     ) $$,
  '23514',
  null,
  'RETRIEVAL_ONLY with a non-null publication_timestamp is rejected'
);
select throws_ok(
  $$ insert into fundamental_source_snapshots (
       instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
       audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
     ) values (
       'TEST_FUND_INSTR', 'TESTFUND', 'test-provider', 'test-locator-bad-2', '2026-06-30', 'quarterly', 'consolidated',
       'audited', null, '2026-08-05T00:00:00Z', 'EXCHANGE_FILING', '2026-08-05T00:00:00Z', 'INR', '{}'::jsonb, 'sha256:bad2', 'PENDING'
     ) $$,
  '23514',
  null,
  'a disclosed basis (EXCHANGE_FILING/PROVIDER_PUBLICATION) with a null publication_timestamp is rejected'
);
select throws_ok(
  $$ insert into fundamental_source_snapshots (
       instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
       audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
     ) values (
       'TEST_FUND_INSTR', 'TESTFUND', 'upstox', 'test-locator-bad-3', '2026-06-30', 'quarterly', 'consolidated',
       null, null, '2026-08-06T00:00:00Z', 'RETRIEVAL_ONLY', '2026-08-05T00:00:00Z', 'INR', '{}'::jsonb, 'sha256:bad3', 'PENDING'
     ) $$,
  '23514',
  null,
  'RETRIEVAL_ONLY requires available_from = retrieved_at exactly -- a mismatch is rejected'
);
select throws_ok(
  $$ insert into fundamental_source_snapshots (
       instrument_id, exchange_symbol, source, source_locator, period_end, period_type, consolidation,
       audit_status, publication_timestamp, available_from, timestamp_basis, retrieved_at, currency, raw_values, checksum, validation_status
     ) values (
       'TEST_FUND_INSTR', 'TESTFUND', 'test-provider', 'test-locator-bad-4', '2026-06-30', 'quarterly', 'consolidated',
       'audited', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 'EXCHANGE_FILING', '2026-08-05T00:00:00Z', 'INR', '{}'::jsonb, 'sha256:bad4', 'PENDING'
     ) $$,
  '23514',
  null,
  'a disclosed basis requires available_from = publication_timestamp exactly -- a mismatch is rejected'
);

-- Attempted UPDATE/DELETE on a published score result must fail; an
-- unmanifested (refresh_manifest_id is null) result is immutable too.
insert into fundamental_score_versions (version, status, spec) values ('test-1.0.0', 'test', '{}'::jsonb)
  on conflict (version) do nothing;
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR', null, (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-06-30T00:00:00Z', null, null, 0, 'NO_DATA'
);
select throws_ok(
  $$ update fundamental_score_results set terminal_status = 'MANUAL_REVIEW' where instrument_id = 'TEST_FUND_INSTR' and refresh_manifest_id is null $$,
  'P0001',
  null,
  'an unmanifested fundamental_score_results row is immutable'
);
select throws_ok(
  $$ delete from fundamental_score_results where instrument_id = 'TEST_FUND_INSTR' and refresh_manifest_id is null $$,
  'P0001',
  null,
  'an unmanifested fundamental_score_results row cannot be deleted'
);

-- A binding row is unconditionally immutable from the moment of insert.
insert into screening_runs (id, run_date, universe_version, trigger_type, publication_state, as_of_timestamp)
  values ('11111111-1111-1111-1111-111111111111', '2026-06-30', 'test-universe-1', 'manual', 'published', '2026-06-30T15:30:00Z')
  on conflict (id) do nothing;
insert into buy_setup_fundamental_score_bindings (run_id, instrument_id, fundamental_score_result_id)
  values ('11111111-1111-1111-1111-111111111111', 'TEST_FUND_INSTR', (select id from fundamental_score_results where instrument_id = 'TEST_FUND_INSTR' and refresh_manifest_id is null));
select throws_ok(
  $$ update buy_setup_fundamental_score_bindings set fundamental_score_result_id = fundamental_score_result_id where instrument_id = 'TEST_FUND_INSTR' $$,
  'P0001',
  null,
  'a binding row can never be updated once created'
);
select throws_ok(
  $$ delete from buy_setup_fundamental_score_bindings where instrument_id = 'TEST_FUND_INSTR' $$,
  'P0001',
  null,
  'a binding row can never be deleted once created'
);

-- ---------------------------------------------------------------------------
-- Correction 5/6: binding hardening and both directions.
--
-- Instrument TEST_FUND_INSTR2 has FOUR fundamental_score_results at
-- increasing cutoff_at, only the EARLIEST of which belongs to a published
-- manifest: published (T1) < processing (T2) < validation_failed (T3) <
-- orphaned/unmanifested (T4). All four cutoffs are <= run RUN_B's
-- as_of_timestamp, so only the manifest-published join (not the cutoff
-- ordering alone) can correctly make T1 win.
-- ---------------------------------------------------------------------------
insert into instruments (id, symbol, name, isin) values ('TEST_FUND_INSTR2', 'TESTFUND2', 'Test Fundamentals Instrument 2', 'INE_TEST_0000002')
  on conflict (id) do nothing;
insert into screening_runs (id, run_date, universe_version, trigger_type, publication_state, as_of_timestamp)
  values ('22222222-2222-2222-2222-222222222222', '2026-07-31', 'test-universe-1', 'manual', 'published', '2026-07-31T15:30:00Z')
  on conflict (id) do nothing;

insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state)
  values ((select id from fundamental_score_versions where version = 'test-1.0.0'), '2026-07-01T00:00:00Z', 'published')
  on conflict (score_version_id, cutoff_at) do nothing;
insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state)
  values ((select id from fundamental_score_versions where version = 'test-1.0.0'), '2026-07-15T00:00:00Z', 'processing')
  on conflict (score_version_id, cutoff_at) do nothing;
insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state)
  values ((select id from fundamental_score_versions where version = 'test-1.0.0'), '2026-07-20T00:00:00Z', 'validation_failed')
  on conflict (score_version_id, cutoff_at) do nothing;

insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR2',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-07-01T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-07-01T00:00:00Z', null, null, 0, 'NO_DATA'
);
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR2',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-07-15T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-07-15T00:00:00Z', null, null, 0, 'NO_DATA'
);
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR2',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-07-20T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-07-20T00:00:00Z', null, null, 0, 'NO_DATA'
);
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR2', null,
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-07-25T00:00:00Z', null, null, 0, 'NO_DATA'
);

-- Correction 5, direction 1: a just-published fundamental refresh binds
-- eligible EXISTING screening runs -- and must bind to the published (T1)
-- result, never the later processing/validation_failed/orphaned ones.
select is(
  (select bind_fundamental_scores_for_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-07-01T00:00:00Z'))),
  1,
  'bind_fundamental_scores_for_refresh binds exactly one (run, instrument) pair for the newly published manifest'
);
select is(
  (select fundamental_score_result_id from buy_setup_fundamental_score_bindings
   where run_id = '22222222-2222-2222-2222-222222222222' and instrument_id = 'TEST_FUND_INSTR2'),
  (select id from fundamental_score_results where instrument_id = 'TEST_FUND_INSTR2' and cutoff_at = '2026-07-01T00:00:00Z'),
  'the binding points at the PUBLISHED result (T1), never the later processing/validation_failed/orphaned candidates with more recent cutoffs'
);

-- Correction 5: nonexistent / not-yet-published manifests raise, rather
-- than silently binding nothing.
select throws_ok(
  $$ select bind_fundamental_scores_for_refresh(999999999) $$,
  'P0001',
  null,
  'bind_fundamental_scores_for_refresh raises for a nonexistent manifest id'
);
select throws_ok(
  $$ select bind_fundamental_scores_for_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-07-15T00:00:00Z')) $$,
  'P0001',
  null,
  'bind_fundamental_scores_for_refresh raises when the manifest itself is not published (processing)'
);
select throws_ok(
  $$ select bind_fundamental_scores_for_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-07-20T00:00:00Z')) $$,
  'P0001',
  null,
  'bind_fundamental_scores_for_refresh raises when the manifest itself is not published (validation_failed)'
);

-- ---------------------------------------------------------------------------
-- Correction 6, direction 2: a newly published SCREENING RUN binds eligible
-- EXISTING fundamental results. Instrument TEST_FUND_INSTR3 already has a
-- published result (T1) and a not-yet-published, later-cutoff result (T2)
-- before run RUN_C ever publishes.
-- ---------------------------------------------------------------------------
insert into instruments (id, symbol, name, isin) values ('TEST_FUND_INSTR3', 'TESTFUND3', 'Test Fundamentals Instrument 3', 'INE_TEST_0000003')
  on conflict (id) do nothing;

insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state)
  values ((select id from fundamental_score_versions where version = 'test-1.0.0'), '2026-08-01T00:00:00Z', 'published')
  on conflict (score_version_id, cutoff_at) do nothing;
insert into fundamental_refresh_manifests (score_version_id, cutoff_at, refresh_state)
  values ((select id from fundamental_score_versions where version = 'test-1.0.0'), '2026-08-10T00:00:00Z', 'processing')
  on conflict (score_version_id, cutoff_at) do nothing;

insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR3',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-08-01T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-08-01T00:00:00Z', null, null, 0, 'NO_DATA'
);
insert into fundamental_score_results (
  instrument_id, refresh_manifest_id, score_version_id, score_version, sector_model, cutoff_at,
  total_score, grade, coverage_percentage, terminal_status
) values (
  'TEST_FUND_INSTR3',
  (select id from fundamental_refresh_manifests where cutoff_at = '2026-08-10T00:00:00Z'),
  (select id from fundamental_score_versions where version = 'test-1.0.0'), 'test-1.0.0',
  'NON_FINANCIAL', '2026-08-10T00:00:00Z', null, null, 0, 'NO_DATA'
);

insert into screening_runs (id, run_date, universe_version, trigger_type, publication_state, as_of_timestamp)
  values ('33333333-3333-3333-3333-333333333333', '2026-08-31', 'test-universe-1', 'manual', 'published', '2026-08-31T15:30:00Z')
  on conflict (id) do nothing;
insert into run_universe_instruments (run_id, instrument_id, is_index)
  values ('33333333-3333-3333-3333-333333333333', 'TEST_FUND_INSTR3', false)
  on conflict (run_id, instrument_id) do nothing;

select is(
  (select bind_fundamental_scores_for_run('33333333-3333-3333-3333-333333333333')),
  1,
  'bind_fundamental_scores_for_run binds exactly one (run, instrument) pair for the newly published run'
);
select is(
  (select fundamental_score_result_id from buy_setup_fundamental_score_bindings
   where run_id = '33333333-3333-3333-3333-333333333333' and instrument_id = 'TEST_FUND_INSTR3'),
  (select id from fundamental_score_results where instrument_id = 'TEST_FUND_INSTR3' and cutoff_at = '2026-08-01T00:00:00Z'),
  'the run-side binding also points at the PUBLISHED result (T1), never the later not-yet-published (processing) candidate'
);

-- Correction 6: nonexistent / not-yet-published runs raise.
select throws_ok(
  $$ select bind_fundamental_scores_for_run('99999999-9999-9999-9999-999999999999') $$,
  'P0001',
  null,
  'bind_fundamental_scores_for_run raises for a nonexistent run id'
);
insert into screening_runs (id, run_date, universe_version, trigger_type, publication_state, as_of_timestamp)
  values ('44444444-4444-4444-4444-444444444444', '2026-08-31', 'test-universe-1', 'manual', 'processing', '2026-08-31T15:30:00Z')
  on conflict (id) do nothing;
select throws_ok(
  $$ select bind_fundamental_scores_for_run('44444444-4444-4444-4444-444444444444') $$,
  'P0001',
  null,
  'bind_fundamental_scores_for_run raises when the run itself is not published'
);

-- Idempotency: calling either function again is a safe no-op (already-bound
-- pairs are never revisited -- enforced twice over, by the `on conflict do
-- nothing` clause and by the binding table's own immutability trigger).
select is(
  (select bind_fundamental_scores_for_refresh((select id from fundamental_refresh_manifests where cutoff_at = '2026-07-01T00:00:00Z'))),
  0,
  'calling bind_fundamental_scores_for_refresh again binds zero NEW rows -- the existing binding is left untouched'
);
select is(
  (select bind_fundamental_scores_for_run('33333333-3333-3333-3333-333333333333')),
  0,
  'calling bind_fundamental_scores_for_run again binds zero NEW rows -- the existing binding is left untouched'
);

-- View extension exists and is additive.
select has_view('public', 'buy_setup_analysis_ledger');
select has_column('public', 'buy_setup_analysis_ledger', 'fundamental_score');
select has_column('public', 'buy_setup_analysis_ledger', 'fundamental_grade');
select has_column('public', 'buy_setup_analysis_ledger', 'fundamental_coverage_percentage');
select has_column('public', 'buy_setup_analysis_ledger', 'fundamental_data_status');
select has_column('public', 'buy_setup_analysis_ledger', 'fundamental_score_version');
-- Every pre-existing ledger column from migration 0011 must still be present
-- (additive-only change, never a removal/rename).
select has_column('public', 'buy_setup_analysis_ledger', 'gate_result');
select has_column('public', 'buy_setup_analysis_ledger', 'qualified');
select has_column('public', 'buy_setup_analysis_ledger', 'overall_status');

-- RLS enabled on every new table.
select ok((select relrowsecurity from pg_class where oid = 'public.fundamental_source_snapshots'::regclass), 'fundamental_source_snapshots has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.fundamental_score_results'::regclass), 'fundamental_score_results has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.fundamental_score_components'::regclass), 'fundamental_score_components has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.buy_setup_fundamental_score_bindings'::regclass), 'buy_setup_fundamental_score_bindings has RLS enabled');

-- Authenticated-select-only, no anon access, no authenticated writes.
select ok(
  not has_table_privilege('anon', 'public.fundamental_score_results', 'SELECT')
  and has_table_privilege('authenticated', 'public.fundamental_score_results', 'SELECT')
  and not has_table_privilege('authenticated', 'public.fundamental_score_results', 'INSERT,UPDATE,DELETE'),
  'fundamental_score_results is authenticated-read-only and inaccessible to anon -- browser clients can never write an authoritative score'
);
select ok(
  not has_table_privilege('anon', 'public.buy_setup_fundamental_score_bindings', 'SELECT')
  and has_table_privilege('authenticated', 'public.buy_setup_fundamental_score_bindings', 'SELECT')
  and not has_table_privilege('authenticated', 'public.buy_setup_fundamental_score_bindings', 'INSERT,UPDATE,DELETE'),
  'buy_setup_fundamental_score_bindings is authenticated-read-only and inaccessible to anon'
);

-- A partial/unpublished refresh must never be visible to a plain Viewer.
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'fundamental_score_results' and policyname = 'fundamental_score_results_read') like '%fundamental_refresh_manifests%',
  'fundamental_score_results_read gates on the refresh manifest, not unconditionally visible'
);
select ok(
  (select qual from pg_policies where schemaname = 'public' and tablename = 'fundamental_score_versions' and policyname = 'fundamental_score_versions_read') not like '%published%',
  'fundamental_score_versions_read is role-gated only (operational/spec data, not published research evidence)'
);

select * from finish();
rollback;
