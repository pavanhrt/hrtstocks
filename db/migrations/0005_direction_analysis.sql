-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Direction feature: per-instrument, per-timeframe Dow-theory structure and
-- best-effort wave label, plus the rendered chart that goes with it.
--
-- Unlike every other computed table in this schema, this one is
-- latest-state, upserted in place per (instrument_id, timeframe) rather than
-- versioned per run -- the feature's own requirement is "replace the old
-- chart with the new one; if nothing changed, leave it alone", not an
-- append-only audit trail. run_id is kept only for provenance (which run
-- last touched this row), not as a foreign key other tables join through.

create table instrument_direction (
  instrument_id text not null references instruments(id),
  timeframe text not null check (timeframe in ('daily', 'weekly', 'monthly')),
  run_id uuid references screening_runs(id),
  dow_state text,
  pivots jsonb not null default '[]',
  last_swing_high numeric,
  last_swing_low numeric,
  wave_label text,
  wave_confidence text,
  chart_object_path text,
  input_hash text,
  data_quality data_quality_state,
  updated_at timestamptz not null default now(),
  primary key (instrument_id, timeframe)
);
-- Registry of objects written to Cloud Storage. Replaces reads of Supabase's
-- storage.objects inside publish_*() so publication can still prove every
-- referenced chart exists. Rows are inserted by the pipeline immediately after
-- each successful upload (services/pipeline/src/storage).
create table stored_objects (
  bucket text not null,
  name text not null,
  size_bytes bigint,
  content_type text,
  created_at timestamptz not null default now(),
  primary key (bucket, name)
);
