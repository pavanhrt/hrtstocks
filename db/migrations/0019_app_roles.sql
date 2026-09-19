-- Least-privilege database roles for Cloud SQL.
--
-- Supabase enforced read access with RLS + anon/authenticated/service_role
-- grants. On Cloud SQL, authorization lives in the application (explicit role
-- checks in app/src/lib/auth.ts) and the database only restricts *which
-- service* may do what:
--
--   app_web       Cloud Run web app: read everything, manage profiles only.
--   app_pipeline  Cloud Run Jobs: read/write everything, execute the pipeline
--                 functions.
--
-- The roles are NOLOGIN groups. Cloud SQL IAM service-account users (created by
-- Terraform) are granted membership, e.g.
--   GRANT app_web TO "app-runtime@<project>.iam";
-- Locally, docker-compose grants them to the dev login user.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_web') then
    create role app_web nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_pipeline') then
    create role app_pipeline nologin;
  end if;
end
$$;

grant usage on schema public to app_web, app_pipeline;

grant select on all tables in schema public to app_web;
grant insert, update on profiles to app_web;

-- FOME single-instrument analysis: the web app creates the queued run row (so the
-- page can poll it immediately), marks it failed if its job cannot be launched,
-- and performs the news hand-off. Nothing else in those tables is writable.
grant insert on fome_analysis_runs to app_web;
grant update (status, error_message, completed_at, current_stage, news_relevance) on fome_analysis_runs to app_web;
grant insert on fome_news_items to app_web;

grant select, insert, update, delete on all tables in schema public to app_pipeline;
grant usage, select on all sequences in schema public to app_pipeline;
grant usage, select on all sequences in schema public to app_web;
grant execute on all functions in schema public to app_pipeline;

-- Internal pipeline functions must never be callable by the web role.
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to app_pipeline;

-- Future objects created by the migration owner get the same defaults.
alter default privileges in schema public grant select on tables to app_web;
alter default privileges in schema public grant select, insert, update, delete on tables to app_pipeline;
alter default privileges in schema public grant usage, select on sequences to app_pipeline;
alter default privileges in schema public grant execute on functions to app_pipeline;
