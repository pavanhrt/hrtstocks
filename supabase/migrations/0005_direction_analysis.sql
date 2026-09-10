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

-- Writes only ever come from the run-screening Edge Function's service role
-- key (which bypasses RLS), same as every other computed table -- see
-- 0002_rls.sql's header comment. This is presentation data at the same
-- sensitivity level as instruments/instrument_run_results' latest state, so
-- any signed-in role may read it (there's no per-run history here to gate
-- read access on, unlike the run-scoped tables in 0002_rls.sql).
alter table instrument_direction enable row level security;
create policy instrument_direction_read on instrument_direction
  for select using (auth.role() = 'authenticated');

-- Private bucket: the whole app is already login-gated, so charts are served
-- via short-lived signed URLs generated server-side rather than a public
-- endpoint. Object path convention: {instrument_id}/{timeframe}.svg.
insert into storage.buckets (id, name, public)
values ('direction-charts', 'direction-charts', false)
on conflict (id) do nothing;

create policy direction_charts_read on storage.objects
  for select using (bucket_id = 'direction-charts' and auth.role() = 'authenticated');
