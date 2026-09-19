import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db/pool";
import { getFomeAnalysisResult } from "@/lib/data/fome";
import { claimNewsStage, finishNewsStage, getInstrumentForNews, insertNewsItems } from "@/lib/data/fome-runs";
import { fetchNewsArticles } from "@/lib/news/rss";
import { findAndClassifyInstrumentNews, classifyRunNewsRelevance, type TechnicalDirection } from "@/lib/news/fome-relevance";

const RunId = z.string().uuid();

// GET /api/fome-analysis/{runId} -- the /fome page polling endpoint.
//
// News hand-off (stage 7 of the page 10-step progress, "Retrieving news"):
// the FOME job does not fetch news itself; the news infrastructure
// (lib/news/rss.ts) lives in this Node app. The first poll that observes a
// terminal technical result (completed/partial) with `news_relevance` still
// null claims the news step (an atomic conditional UPDATE guards against two
// concurrent polls both fetching news), fetches + classifies + persists it,
// then serves the merged result.
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const parsedId = RunId.safeParse((await params).runId);
  if (!parsedId.success) return NextResponse.json({ error: "Analysis run not found." }, { status: 404 });
  const runId = parsedId.data;

  let result = await getFomeAnalysisResult(runId);
  if (!result) {
    return NextResponse.json({ error: "Analysis run not found." }, { status: 404 });
  }

  const technicalDone = result.status === "completed" || result.status === "partial";
  if (technicalDone && result.newsRelevance == null) {
    const claimed = await claimNewsStage(getDb(), runId);
    if (claimed) {
      await appendNews(runId, result);
      result = await getFomeAnalysisResult(runId);
    }
  }

  return NextResponse.json({ result });
}

function deriveTechnicalDirection(finalAlignment: string | null): TechnicalDirection {
  if (finalAlignment === "ALIGNED_BULLISH") return "bullish";
  if (finalAlignment === "ALIGNED_BEARISH") return "bearish";
  if (finalAlignment === "SIDEWAYS" || finalAlignment === "VOLATILITY_EXPANSION") return "sideways";
  return null;
}

async function appendNews(runId: string, result: NonNullable<Awaited<ReturnType<typeof getFomeAnalysisResult>>>) {
  const db = getDb();
  let relevance = "NEWS_UNAVAILABLE";
  try {
    const instrument = await getInstrumentForNews(db, result.instrumentId);
    if (instrument) {
      const articles = await fetchNewsArticles();
      const direction = deriveTechnicalDirection(result.finalAlignment);
      const classified = findAndClassifyInstrumentNews(
        articles,
        { instrumentId: instrument.id, symbol: instrument.symbol, name: instrument.name },
        direction,
      );
      if (classified.length > 0) {
        await insertNewsItems(
          db,
          runId,
          classified.map((c) => ({
            headline: c.headline,
            source: c.source,
            publishedAt: c.publishedAt,
            url: c.url,
            eventCategory: c.eventCategory,
            relevance: c.relevance,
            confidence: c.confidence,
            explanation: c.explanation,
          })),
        );
      }
      relevance = classifyRunNewsRelevance(classified);
    }
  } catch (err) {
    console.error(`[fome-analysis news] run=${runId} failed:`, err);
    relevance = "NEWS_UNAVAILABLE";
  }
  await finishNewsStage(db, runId, relevance);
}
