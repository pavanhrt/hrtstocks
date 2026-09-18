import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth";
import { getFomeAnalysisResult } from "@/lib/data/fome";
import { SUPABASE_URL } from "@/lib/env";
import { fetchNewsArticles } from "@/lib/news/rss";
import { findAndClassifyInstrumentNews, classifyRunNewsRelevance, type TechnicalDirection } from "@/lib/news/fome-relevance";

// GET /api/fome-analysis/{runId} -- the /fome page's polling endpoint.
//
// News hand-off (stage 7 of the page's 10-step progress, "Retrieving news"):
// the fome-analysis Edge Function (Deno) does NOT fetch news itself -- this
// project's existing news infrastructure (lib/news/rss.ts) depends on the
// `rss-parser` npm package, which has no confirmed Deno-compatible
// equivalent in this project, so re-implementing RSS parsing a second time
// for one Edge Function was rejected in favor of reusing the existing
// Node-side infrastructure from here instead. The first poll that observes
// a terminal technical result (completed/partial) with `news_relevance`
// still null claims the news step (an atomic conditional UPDATE guards
// against two concurrent polls both fetching news), fetches + classifies +
// persists it using the project's own service-role secret (already
// server-only in this codebase, same key api/screening-runs/route.ts,
// api/buy-setup-analysis/route.ts, and api/fome-analysis/route.ts already
// hold), then serves the merged result.
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { runId } = await params;
  let result = await getFomeAnalysisResult(runId);
  if (!result) {
    return NextResponse.json({ error: "Analysis run not found." }, { status: 404 });
  }

  const technicalDone = result.status === "completed" || result.status === "partial";
  if (technicalDone && result.newsRelevance == null) {
    const claimed = await claimNewsStage(runId);
    if (claimed) {
      await appendNews(runId, result);
      result = await getFomeAnalysisResult(runId);
    }
  }

  return NextResponse.json({ result });
}

function serviceClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) return null;
  return createServiceClient(SUPABASE_URL, secretKey, { auth: { persistSession: false } });
}

/**
 * Atomic-ish claim so two near-simultaneous polls never both fetch/insert
 * news for the same run: only succeeds (returns true) when this call is the
 * one that actually flips current_stage from its post-technical-analysis
 * value to "retrieving_news" -- a second concurrent call finds the stage
 * already changed and does nothing.
 */
async function claimNewsStage(runId: string): Promise<boolean> {
  const service = serviceClient();
  if (!service) return false;
  const { data } = await service
    .from("fome_analysis_runs")
    .update({ current_stage: "retrieving_news" })
    .eq("id", runId)
    .neq("current_stage", "retrieving_news")
    .is("news_relevance", null)
    .select("id");
  return (data?.length ?? 0) > 0;
}

function deriveTechnicalDirection(finalAlignment: string | null): TechnicalDirection {
  if (finalAlignment === "ALIGNED_BULLISH") return "bullish";
  if (finalAlignment === "ALIGNED_BEARISH") return "bearish";
  if (finalAlignment === "SIDEWAYS" || finalAlignment === "VOLATILITY_EXPANSION") return "sideways";
  return null;
}

async function appendNews(runId: string, result: NonNullable<Awaited<ReturnType<typeof getFomeAnalysisResult>>>) {
  const service = serviceClient();
  if (!service) return; // no secret key configured -- leave news_relevance null; the page shows NEWS_UNAVAILABLE

  let relevance = "NEWS_UNAVAILABLE";
  try {
    const { data: instrument } = await service
      .from("instruments")
      .select("id, symbol, name")
      .eq("id", result.instrumentId)
      .maybeSingle();

    if (instrument) {
      const articles = await fetchNewsArticles();
      const direction = deriveTechnicalDirection(result.finalAlignment);
      const classified = findAndClassifyInstrumentNews(
        articles,
        { instrumentId: instrument.id, symbol: instrument.symbol, name: instrument.name },
        direction
      );

      if (classified.length > 0) {
        await service.from("fome_news_items").insert(
          classified.map((c) => ({
            analysis_run_id: runId,
            headline: c.headline,
            source: c.source,
            published_at: c.publishedAt,
            url: c.url,
            event_category: c.eventCategory,
            relevance: c.relevance,
            confidence: c.confidence,
            explanation: c.explanation,
          }))
        );
      }
      relevance = classifyRunNewsRelevance(classified);
    }
  } catch (err) {
    console.error(`[fome-analysis news] run=${runId} failed:`, err);
    relevance = "NEWS_UNAVAILABLE";
  }

  await service
    .from("fome_analysis_runs")
    .update({ news_relevance: relevance, current_stage: "saving_and_presenting_result" })
    .eq("id", runId);
}
