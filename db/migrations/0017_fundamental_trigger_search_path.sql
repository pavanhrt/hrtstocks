-- Originally authored for Supabase; made self-contained for plain PostgreSQL / Cloud SQL (see docs/gcp/schema-provenance.md).
-- Supabase-only statements (RLS, policies, role grants, auth/storage/cron) were removed or replaced.

-- Follow-up hardening (found via Supabase's own security advisor immediately
-- after 0014 was applied live, 2026-09-16): the four fundamental_* trigger
-- functions added by 0014 were the only new functions in that migration
-- missing an explicit `set search_path` -- every other new function
-- (bind_fundamental_scores_for_refresh/_for_run, publish_fundamental_refresh,
-- try_acquire_token_bucket_slot) already had one. A mutable search_path lets
-- a caller who can influence the session's search_path (e.g. via a
-- same-transaction `SET search_path`) redirect an unqualified identifier
-- inside the function to a different, attacker-controlled object -- these
-- functions reference no unqualified table outside their own trigger
-- context, so the practical risk here is low, but there is no reason to
-- leave it mutable when every sibling function in this file already isn't.
--
-- Purely additive: `create or replace function` with an identical body, only
-- adding `set search_path to 'public', 'pg_temp'`. No behavior change.

create or replace function enforce_fundamental_snapshot_immutability()
returns trigger language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'fundamental_source_snapshots rows are immutable and cannot be deleted (id=%). Corrections must insert a new row with supersedes_id pointing at this one.', OLD.id;
  end if;
  if OLD.validation_status <> 'PENDING' then
    raise exception 'fundamental_source_snapshots row % is already validated (%) and is immutable.', OLD.id, OLD.validation_status;
  end if;
  if NEW.instrument_id is distinct from OLD.instrument_id
     or NEW.exchange_symbol is distinct from OLD.exchange_symbol
     or NEW.source is distinct from OLD.source
     or NEW.source_locator is distinct from OLD.source_locator
     or NEW.period_end is distinct from OLD.period_end
     or NEW.period_type is distinct from OLD.period_type
     or NEW.consolidation is distinct from OLD.consolidation
     or NEW.audit_status is distinct from OLD.audit_status
     or NEW.publication_timestamp is distinct from OLD.publication_timestamp
     or NEW.available_from is distinct from OLD.available_from
     or NEW.timestamp_basis is distinct from OLD.timestamp_basis
     or NEW.retrieved_at is distinct from OLD.retrieved_at
     or NEW.currency is distinct from OLD.currency
     or NEW.sector_model is distinct from OLD.sector_model
     or NEW.ownership_structure is distinct from OLD.ownership_structure
     or NEW.raw_values is distinct from OLD.raw_values
     or NEW.derived_values is distinct from OLD.derived_values
     or NEW.is_exceptional_item is distinct from OLD.is_exceptional_item
     or NEW.exceptional_item_amount is distinct from OLD.exceptional_item_amount
     or NEW.supersedes_id is distinct from OLD.supersedes_id
     or NEW.checksum is distinct from OLD.checksum
  then
    raise exception 'fundamental_source_snapshots row % may only have validation_status/validation_errors updated, and only while still PENDING.', OLD.id;
  end if;
  return NEW;
end;
$$;

create or replace function enforce_fundamental_score_result_immutability()
returns trigger language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_state text;
begin
  select refresh_state into v_state from fundamental_refresh_manifests where id = OLD.refresh_manifest_id;
  if OLD.refresh_manifest_id is null or v_state = 'published' then
    raise exception 'fundamental_score_results row % is published (or unmanifested) and immutable.', OLD.id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

create or replace function enforce_fundamental_score_component_immutability()
returns trigger language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_state text;
  v_manifest_id bigint;
begin
  select refresh_manifest_id into v_manifest_id from fundamental_score_results where id = OLD.score_result_id;
  if v_manifest_id is null then
    raise exception 'fundamental_score_components row % belongs to an unmanifested result and is immutable.', OLD.id;
  end if;
  select refresh_state into v_state from fundamental_refresh_manifests where id = v_manifest_id;
  if v_state = 'published' then
    raise exception 'fundamental_score_components row % belongs to a published result and is immutable.', OLD.id;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

create or replace function enforce_fundamental_score_binding_immutability()
returns trigger language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  raise exception 'buy_setup_fundamental_score_bindings rows are permanently immutable once created (run_id=%, instrument_id=%).', OLD.run_id, OLD.instrument_id;
end;
$$;