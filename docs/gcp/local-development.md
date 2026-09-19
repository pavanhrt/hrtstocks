# Local development

Everything runs locally and costs nothing. No Google Cloud credentials or resources are needed.

## Prerequisites

Node.js 22+ (24 recommended: the tests use built-in TypeScript type stripping), Docker (for PostgreSQL and the Storage emulator), and optionally
`npx firebase-tools` for the Auth emulator.

## Run the stack

```bash
npm ci && npm --prefix app ci && npm --prefix services/pipeline ci

docker compose up -d                      # PostgreSQL 17 + Cloud Storage emulator (loopback only)
cp app/.env.example app/.env.local        # then edit if needed
cp services/pipeline/.env.example services/pipeline/.env.local

export DATABASE_URL=postgres://hrt:hrt_local_only@127.0.0.1:5432/hrtstocks
npm run db:migrate                        # applies db/migrations
npm run seed:system                       # the documented system seed (docs/gcp/seed-data.md): strategies, rules, parameters

npx firebase-tools emulators:start --only auth     # in another terminal (uses firebase.json)
npm --prefix app run dev                           # http://localhost:3000
```

Create yourself a first user (invite-only) against the emulator, then sign in:

```bash
cd app && node --env-file=.env.local scripts/invite-user.ts --email you@example.com --role system_admin
```

Then create the account in the emulator UI (`http://127.0.0.1:4000`) or by using **Forgot password**, and sign in.

## Running pipeline jobs locally

With `JOB_RUNNER=local` the **Run screening** button spawns the job as a child process. Or run one directly:

```bash
cd services/pipeline
node --env-file=.env.local src/jobs/screening.mjs        # needs FYERS_APP_ID and a fresh FYERS_ACCESS_TOKEN
```

## Tests (all offline)

```bash
npm test                       # db migrations + SQL tests, clean-DB smoke, pipeline (incl. first-run and end-to-end screening), scripts
npm --prefix app run lint && npm --prefix app run typecheck && npm --prefix app test && npm --prefix app run build
```

The database tests use an **embedded real PostgreSQL 17** (npm `embedded-postgres`), so they need neither Docker nor a network beyond the first
binary download. The end-to-end screening test fakes only the two external APIs (NSE archive CSVs and FYERS history).

## What is verified only in CI / at deploy time

Docker image builds (`app/Dockerfile`, `services/pipeline/Dockerfile`; CI builds them on every push) and everything that needs Google Cloud or Firebase Hosting.
The clean-database smoke test starts the **built** app (`npm --prefix app run build` first) against a freshly migrated database; it is skipped, and says so, when the app is not built.
