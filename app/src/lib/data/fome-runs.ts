import type { Db } from "../db/pool.ts";

// Writes the web app is allowed to make for the FOME feature (matched by the
// column-level grants in db/migrations/0019_app_roles.sql): creating a queued
// run for the job to pick up, and the news hand-off after the technical stage.

/** A queued/running run for the same instrument this recent is reused instead of starting a duplicate job (cost control + idempotency). */
const REUSE_WINDOW_MINUTES = 10;

export type CreatedFomeRun = { runId: string; reused: boolean };

/** Returns null when the instrument does not exist. */
export async function createFomeRun(db: Db, { instrumentId, triggeredBy }: { instrumentId: string; triggeredBy: string }): Promise<CreatedFomeRun | null> {
  const instrument = await db.one(`select 1 as ok from instruments where id = $1`, [instrumentId]);
  if (!instrument) return null;

  const active = await db.one<{ id: string }>(
    `select id from fome_analysis_runs
      where instrument_id = $1 and status in ('queued', 'running')
        and created_at > now() - make_interval(mins => $2)
      order by created_at desc limit 1`,
    [instrumentId, REUSE_WINDOW_MINUTES],
  );
  if (active) return { runId: active.id, reused: true };

  const created = await db.one<{ id: string }>(
    `insert into fome_analysis_runs (instrument_id, status, as_of_timestamp, current_stage, stage_history, triggered_by)
     values ($1, 'queued', now(), 'resolving_instrument', jsonb_build_array(jsonb_build_object('stage', 'resolving_instrument', 'at', now())), $2)
     returning id`,
    [instrumentId, triggeredBy],
  );
  return { runId: created!.id, reused: false };
}

/** Marks a run failed when its job could not even be launched, so the UI stops polling. */
export async function failFomeRun(db: Db, runId: string, message: string) {
  await db.query(
    `update fome_analysis_runs set status = 'failed', error_message = $2, completed_at = now() where id = $1 and status in ('queued', 'running')`,
    [runId, message.slice(0, 500)],
  );
}

/**
 * Atomic claim so two near-simultaneous polls never both fetch/insert news for
 * the same run: succeeds only for the call that actually flips current_stage
 * to "retrieving_news" while news_relevance is still unset.
 */
export async function claimNewsStage(db: Db, runId: string): Promise<boolean> {
  const rows = await db.query(
    `update fome_analysis_runs set current_stage = 'retrieving_news'
      where id = $1 and current_stage is distinct from 'retrieving_news' and news_relevance is null
      returning id`,
    [runId],
  );
  return rows.length > 0;
}

export type NewsItemInput = {
  headline: string;
  source: string | null;
  publishedAt: string | null;
  url: string | null;
  eventCategory: string | null;
  relevance: string | null;
  confidence: string | null;
  explanation: string | null;
};

export async function insertNewsItems(db: Db, runId: string, items: readonly NewsItemInput[]) {
  for (const n of items) {
    await db.query(
      `insert into fome_news_items (analysis_run_id, headline, source, published_at, url, event_category, relevance, confidence, explanation)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [runId, n.headline, n.source, n.publishedAt, n.url, n.eventCategory, n.relevance, n.confidence, n.explanation],
    );
  }
}

export async function finishNewsStage(db: Db, runId: string, relevance: string) {
  await db.query(
    `update fome_analysis_runs set news_relevance = $2, current_stage = 'saving_and_presenting_result' where id = $1`,
    [runId, relevance],
  );
}

export async function getInstrumentForNews(db: Db, instrumentId: string) {
  return db.one<{ id: string; symbol: string; name: string | null }>(`select id, symbol, name from instruments where id = $1`, [instrumentId]);
}
