import { z } from "zod";

/**
 * Server-side configuration, validated once on first use (not at import time,
 * so `next build` works without runtime secrets). No project ids, regions or
 * hostnames are hard-coded: everything environment-specific comes from here.
 * See docs/gcp/environment-variables.md.
 */
const serverSchema = z.object({
    // Local development / tests: a plain connection string.
    DATABASE_URL: z.string().min(1).optional(),
    // Cloud Run: Cloud SQL connector + IAM database authentication.
    CLOUD_SQL_INSTANCE: z.string().min(1).optional(), // <project>:<region>:<instance>
    DB_NAME: z.string().min(1).default("hrtstocks"),
    DB_USER: z.string().min(1).optional(), // IAM user, e.g. app-runtime@<project>.iam
    // Cloud Run gives each instance up to `concurrency` parallel requests but
    // Cloud SQL has a small connection budget, so keep the pool small.
    DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),

    CHART_BUCKET: z.string().min(1).optional(),
    // Set to point the Cloud Storage client at a local emulator (fake-gcs-server).
    STORAGE_EMULATOR_HOST: z.string().optional(),

    // cloud_run: start Cloud Run Job executions. local: spawn the job entrypoint
    // as a child process (development only).
    JOB_RUNNER: z.enum(["cloud_run", "local"]).default("cloud_run"),
    // Cloud Run Jobs started from the UI (the scheduled run is started by Cloud Scheduler).
    GCP_PROJECT: z.string().min(1).optional(),
    GCP_REGION: z.string().min(1).optional(),
    SCREENING_JOB_NAME: z.string().min(1).optional(),
    BUY_SETUP_JOB_NAME: z.string().min(1).optional(),
    FOME_JOB_NAME: z.string().min(1).optional(),

    // Invite-only until email verification, abuse controls, authorization tests
    // and cost controls are ready (see docs/gcp/authentication.md).
    // Canonical public origin (QA: the custom domain, e.g. https://qa.example.com) and any extra EXACT origins
    // allowed to make state-changing requests. Never wildcards. Empty in production = state-changing requests refused.
    APP_BASE_URL: z.string().url().optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    SIGNUP_MODE: z.enum(["invite_only", "open"]).default("invite_only"),
    SESSION_COOKIE_NAME: z.string().min(1).default("__session"),
    SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(14).default(5),
    // Explicit opt-in for the local Firebase Auth emulator; never set in Cloud Run.
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
    // Public Firebase web config (not secret). Read here for server verification.
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1).optional(),
});

export type ServerConfig = z.infer<typeof serverSchema>;

let cached: ServerConfig | undefined;

export function serverConfig(): ServerConfig {
  if (!cached) {
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) {
      // Field names only: never echo values, they may be secrets.
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      throw new Error(`Invalid server configuration -- ${problems.join("; ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Checked only when the database is actually used, so pages that need no data (e.g. /login) work without it. */
export function databaseConfig(): ServerConfig & ({ DATABASE_URL: string } | { CLOUD_SQL_INSTANCE: string }) {
  const cfg = serverConfig();
  if (!cfg.DATABASE_URL && !cfg.CLOUD_SQL_INSTANCE) {
    throw new Error("Invalid server configuration -- DATABASE_URL: Set DATABASE_URL (local) or CLOUD_SQL_INSTANCE (Cloud Run).");
  }
  return cfg as ServerConfig & { DATABASE_URL: string };
}

/** Test hook: forget the memoized config after mutating process.env. */
export function resetServerConfigForTests() {
  cached = undefined;
}
