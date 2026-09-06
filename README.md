# Stock Research Workspace

Evidence-based NSE index/stock research: SMM, PAPA, GUE, and FOME rules converted into an
auditable, versioned screening pipeline. See [docs/project-overview.md](docs/project-overview.md)
for the product goals and [AGENTS.md](AGENTS.md) for the governing rules. This file covers what's
built, how to run it locally, and how to deploy Phase 1.

## What's here

```
stock-platform/
  app/                  Next.js 15 web app (deploy this to Netlify)
  supabase/
    migrations/         Applied to the hrtstocks Supabase project (see below)
    functions/
      run-screening/    Edge Function: ingestion -> rules -> ranking -> persist
    seed/               Loads strategies/*.yaml into the database
  strategies/, references/, skills/, templates/, config/   Project specs (unchanged)
  source-documents/     Canonical SMM/PAPA/GUE/FOME source files, deduplicated
  archive/              Superseded drafts and one-off extraction scratch work
```

Backend: Supabase project **hrtstocks** (`yqxpucjtzrmwjniruebt`, ap-south-1). Frontend: Next.js on
Netlify. Phase 1 scope only -- see [the project overview](docs/project-overview.md) and
`AGENTS.md`'s "Suggested delivery phases" for what's deferred to Phase 2/3.

## Current status

- Database schema + RLS: **deployed** (4 migrations applied, `npm run` from repo root not needed --
  already live).
- Strategy registry: **seeded** -- 28 decision rules across SMM (14), PAPA (7), GUE (3), FOME (4),
  plus the shared cross-strategy gates, loaded from `strategies/*.yaml`.
- Rule engine, feature engine, ranking, and coverage reconciliation: built and unit-tested
  (`npm test` from `stock-platform/` -- 55 passing tests).
- NSE ingestion adapter: built against NSE's public website endpoints (unofficial, free, MVP-only
  -- see [references/market-data-policy.md](references/market-data-policy.md)). **Not yet
  exercised against a live deploy** -- these endpoints require browser-like session cookies and
  can change or block a given host without notice; smoke-test this first (see below).
- Web app: built, type-checks, and builds cleanly. Auth (Supabase email/password + recovery),
  role-based nav, dashboard, index analysis, stock ledger with CSV export, per-stock rule trace,
  read-only strategy viewer, and data-health page are all wired to live Supabase queries.
- **Not yet run end-to-end**: no `screening_runs` row exists yet, because that requires deploying
  the Edge Function (Supabase CLI isn't installed in this environment). Every page already handles
  the empty state, but you won't see real tiers/candidates/rule traces until you deploy and trigger
  a run.

## Local development

```bash
# from stock-platform/app
npm install
npm run dev
```

Needs `stock-platform/app/.env.local` (already created locally with the project's anon key):

```
NEXT_PUBLIC_SUPABASE_URL=https://yqxpucjtzrmwjniruebt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key -- safe to expose, it's the public client key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

The anon key is not a secret (it's the same key `createBrowserClient` sends from the browser); the
service-role key below is a secret and must never be committed or exposed client-side.

## Deploying

### 1. The Next.js app (Netlify)

1. Push this repo to a Git remote Netlify can see, or `netlify deploy` from `stock-platform/app`.
2. Site settings -> Environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from the values above)
   - `NEXT_PUBLIC_SITE_URL` = your Netlify site URL (used for the password-reset redirect)
   - `SUPABASE_SERVICE_ROLE_KEY` (Supabase dashboard -> Project Settings -> API -- **secret**)
   - `RUN_SCREENING_FUNCTION_URL` = `https://yqxpucjtzrmwjniruebt.supabase.co/functions/v1/run-screening`
     (only valid after step 2)
3. `netlify.toml` already points at `@netlify/plugin-nextjs`; Netlify will install it automatically.

### 2. The run-screening Edge Function

The Supabase CLI isn't available in this environment, so this function has been written and
unit-tested at the module level (see `supabase/functions/run-screening/*.test.js`, run via
`npm test`) but not yet deployed or smoke-tested end-to-end. From a machine with the
[Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref yqxpucjtzrmwjniruebt
supabase functions deploy run-screening --no-verify-jwt
```

`--no-verify-jwt` is required because this function checks its own `Authorization: Bearer
<service-role-key>` header (see `index.js`) rather than a user JWT -- it's only ever called
server-to-server, from the Next.js API route or from `pg_cron`, never from the browser.

**Smoke-test it once manually before scheduling it:**

```bash
curl -X POST https://yqxpucjtzrmwjniruebt.supabase.co/functions/v1/run-screening \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{"trigger_type":"manual"}'
```

Then check `screening_runs`, `pipeline_audit_log`, and `data_quality_results` in the Supabase
dashboard (or ask Claude to check via the Supabase MCP tools) to see how the NSE public endpoints
behaved. Expect most rule traces to land in `NO_DATA`/`MANUAL_REVIEW` at first -- see "Why so many
NO_DATA results?" below, that's by design, not a bug.

### 3. Scheduling the EOD run

Once deployed and smoke-tested, schedule it from the SQL editor (weekdays, 15:45 IST = 10:15 UTC,
after NSE close):

```sql
select cron.schedule(
  'run-screening-eod',
  '15 10 * * 1-5',
  $$
  select net.http_post(
    url := 'https://yqxpucjtzrmwjniruebt.supabase.co/functions/v1/run-screening',
    headers := jsonb_build_object('Authorization', 'Bearer ' || '<service-role-key>', 'Content-Type', 'application/json'),
    body := jsonb_build_object('trigger_type', 'scheduled')
  );
  $$
);
```

Store the service-role key via [Supabase Vault](https://supabase.com/docs/guides/database/vault)
rather than inlining it in the cron job body if you'd rather not have it sitting in `pg_cron.job`.

### 4. Bootstrap your admin account

1. Sign up normally at `/login` on the deployed site (or `localhost:3000` locally) with your own
   email -- new accounts default to the `viewer` role.
2. Add your email to `bootstrap_admin_emails` **before** you sign up (or promote yourself after, if
   you already have a `profiles` row):
   ```sql
   insert into bootstrap_admin_emails (email) values ('you@example.com');
   -- if you already signed up before adding it:
   update profiles set role = 'system_admin' where email = 'you@example.com';
   ```

## Why so many NO_DATA results at first?

`config/parameters.yaml` marks RSI period, ADX/DMI period, Bollinger lookback/deviation, volume
lookback/multiplier, and pivot left/right windows as `project_defaults_requiring_backtest` --
currently `null`. The project's own `null_policy` forbids assuming a value for them. Because of
that, `features/context.js` only computes what's fully documented (the EMA periods) and leaves
everything else uncomputed; the rule engine then correctly routes every rule that needs one of
those missing values to `NO_DATA` or `MANUAL_REVIEW` (as each rule documents) instead of guessing.
GUE's Elliott-wave rules and FOME's derivative rules land in `MANUAL_REVIEW`/`NO_DATA` for the same
reason -- wave counting and derivative-contract ingestion are explicitly optional/Phase 3 per
`AGENTS.md`. A screen full of `NO_DATA` on day one means the pipeline is being honest about what
the source strategies haven't yet pinned down, not that anything is broken. Resolving those
parameters (via backtesting, per the project's own `Workflow Priority`) is what unlocks more
decisive results, and is Phase 2 work.

## Testing

```bash
# from stock-platform/ (rule engine, feature engine, ranking, reconciliation)
npm test

# from stock-platform/app (type-check + build)
npm run build
```
