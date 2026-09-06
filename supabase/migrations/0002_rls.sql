-- Row-level security for the stock research platform.
--
-- All writes to computed/reporting tables (market data, rule traces, rankings,
-- runs, audit log) are performed exclusively by the run-screening Edge Function
-- using the service role key, which bypasses RLS entirely. So every policy
-- below is SELECT-only: it governs what each authenticated role can read.
-- Profile creation is handled by the security-definer trigger in 0001, not by
-- a client-facing insert policy.

create or replace function public.current_role_name()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;

create policy profiles_self_or_admin_select on profiles
  for select using (id = auth.uid() or public.current_role_name() = 'system_admin');

create policy profiles_admin_update on profiles
  for update using (public.current_role_name() = 'system_admin');

-- ---------------------------------------------------------------------------
-- Strategy / rule / parameter registry: any signed-in role may read (needed
-- for the stock rule-trace page and the read-only strategy view).
-- ---------------------------------------------------------------------------

alter table strategy_versions enable row level security;
create policy strategy_versions_read on strategy_versions
  for select using (auth.role() = 'authenticated');

alter table rule_definitions enable row level security;
create policy rule_definitions_read on rule_definitions
  for select using (auth.role() = 'authenticated');

alter table parameter_versions enable row level security;
create policy parameter_versions_read on parameter_versions
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Universe
-- ---------------------------------------------------------------------------

alter table instruments enable row level security;
create policy instruments_read on instruments
  for select using (auth.role() = 'authenticated');

alter table index_memberships enable row level security;
create policy index_memberships_read on index_memberships
  for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Raw market data / data quality / audit log: researcher and above only.
-- A plain Viewer sees results and reports, not raw provider payloads.
-- ---------------------------------------------------------------------------

alter table market_bars_raw enable row level security;
create policy market_bars_raw_read on market_bars_raw
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table market_bars_adjusted enable row level security;
create policy market_bars_adjusted_read on market_bars_adjusted
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table corporate_actions enable row level security;
create policy corporate_actions_read on corporate_actions
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table data_quality_results enable row level security;
create policy data_quality_results_read on data_quality_results
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table derivative_contracts enable row level security;
create policy derivative_contracts_read on derivative_contracts
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table derivative_snapshots enable row level security;
create policy derivative_snapshots_read on derivative_snapshots
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

alter table pipeline_audit_log enable row level security;
create policy pipeline_audit_log_read on pipeline_audit_log
  for select using (public.current_role_name() in ('researcher','strategy_admin','system_admin'));

-- ---------------------------------------------------------------------------
-- Runs and results: a Viewer only ever sees completed runs (never partial or
-- in-flight state); Researcher and above see every run, including in-progress
-- ones, which is what the daily dashboard's "run status" needs.
-- ---------------------------------------------------------------------------

alter table screening_runs enable row level security;
create policy screening_runs_read on screening_runs
  for select using (
    status = 'completed' or public.current_role_name() in ('researcher','strategy_admin','system_admin')
  );

alter table instrument_run_results enable row level security;
create policy instrument_run_results_read on instrument_run_results
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = instrument_run_results.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher','strategy_admin','system_admin'))
    )
  );

alter table rule_traces enable row level security;
create policy rule_traces_read on rule_traces
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = rule_traces.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher','strategy_admin','system_admin'))
    )
  );

alter table rankings enable row level security;
create policy rankings_read on rankings
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = rankings.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher','strategy_admin','system_admin'))
    )
  );

alter table coverage_reconciliation enable row level security;
create policy coverage_reconciliation_read on coverage_reconciliation
  for select using (
    exists (
      select 1 from screening_runs r
      where r.id = coverage_reconciliation.run_id
        and (r.status = 'completed' or public.current_role_name() in ('researcher','strategy_admin','system_admin'))
    )
  );
