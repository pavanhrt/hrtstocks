-- Enables scheduling infrastructure for the EOD run-screening trigger.
-- The actual `cron.schedule(...)` call is added after the Edge Function is
-- deployed (its invoke URL and the service-role key it needs are not known
-- until then) -- see stock-platform/README.md "Scheduling the EOD run".
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
