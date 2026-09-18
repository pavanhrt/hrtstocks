import type { NewsArticle } from "./rss.ts";
import { matchArticlesToLedger, type LedgerInstrument } from "./match.ts";

export const FOME_NEWS_LOOKBACK_DAYS = 7; // PROJECT_DEFAULT, disclosed
export const FOME_RELEVANCE_HEURISTIC_VERSION = "1.0.0";

export type ArticleRelevance = "supportive" | "opposing" | "neutral" | "uncertain";
export type RelevanceConfidence = "low" | "medium" | "high";
export type TechnicalDirection = "bullish" | "bearish" | "sideways" | null;

export type ClassifiedNewsItem = {
  headline: string;
  source: string;
  publishedAt: string | null;
  url: string;
  eventCategory: string;
  relevance: ArticleRelevance;
  confidence: RelevanceConfidence;
  explanation: string;
};

// A plain keyword-polarity heuristic -- NOT a validated NLP/sentiment model.
// This project has no licensed financial-news-sentiment API or trained
// classifier; a keyword count is a disclosed, low-confidence PROJECT_DEFAULT
// stand-in, always surfaced at confidence "low" (never "high"), and never
// allowed to override the deterministic technical/FOME result.
const POSITIVE_KEYWORDS = [
  "beats estimates", "record profit", "upgrade", "upgraded", "outperform", "buyback",
  "order win", "wins order", "strong guidance", "raises guidance", "expansion", "positive",
  "surge", "rally", "all-time high", "record high", "bonus issue", "stake increase",
];
const NEGATIVE_KEYWORDS = [
  "misses estimates", "downgrade", "downgraded", "underperform", "probe", "investigation",
  "fraud", "resign", "resignation", "default", "layoffs", "job cuts", "plunge", "crash",
  "weak guidance", "cuts guidance", "loss widens", "recall", "fire", "explosion", "fine imposed",
  "penalty", "scam",
];
const EVENT_CATEGORY_KEYWORDS: Record<string, string[]> = {
  earnings: ["earnings", "quarterly results", "q1", "q2", "q3", "q4", "profit", "revenue"],
  regulatory: ["sebi", "rbi", "regulator", "probe", "investigation", "fine imposed", "penalty"],
  corporate_action: ["dividend", "bonus issue", "stock split", "buyback", "rights issue"],
  management: ["ceo", "cfo", "resign", "resignation", "appointment", "board"],
  order_contract: ["order win", "wins order", "contract", "deal signed"],
};

function detectEventCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(EVENT_CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return "general";
}

/**
 * Classifies one article's relevance to a technical direction using a plain
 * keyword count. `direction` may be null (e.g. MIXED/UNAVAILABLE alignment),
 * in which case the article's own polarity is labeled without a technical
 * comparison to check against.
 */
export function classifyArticleRelevance(article: { title: string; snippet: string }, direction: TechnicalDirection): ArticleRelevance {
  const text = `${article.title} ${article.snippet}`.toLowerCase();
  const positiveHits = POSITIVE_KEYWORDS.filter((k) => text.includes(k)).length;
  const negativeHits = NEGATIVE_KEYWORDS.filter((k) => text.includes(k)).length;

  if (positiveHits === 0 && negativeHits === 0) return "neutral";
  if (positiveHits > 0 && negativeHits > 0) return "uncertain"; // mixed signal within one article -- never forced to a side
  if (!direction || direction === "sideways") return positiveHits > negativeHits ? "supportive" : "opposing";

  const articleIsPositive = positiveHits > negativeHits;
  const directionIsBullish = direction === "bullish";
  return articleIsPositive === directionIsBullish ? "supportive" : "opposing";
}

/**
 * Finds articles mentioning the given instrument within the lookback window,
 * deduplicates by headline, and classifies each relative to `direction`.
 * Reuses matchArticlesToLedger (app/src/lib/news/match.ts) rather than a
 * second matching heuristic.
 */
export function findAndClassifyInstrumentNews(
  articles: NewsArticle[],
  instrument: LedgerInstrument,
  direction: TechnicalDirection,
  lookbackDays: number = FOME_NEWS_LOOKBACK_DAYS
): ClassifiedNewsItem[] {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const withinLookback = articles.filter((a) => {
    if (!a.publishedAt) return true; // an article with no timestamp is not silently dropped -- shown, but its recency can't be verified
    const t = Date.parse(a.publishedAt);
    return Number.isNaN(t) || t >= cutoff;
  });

  const matched = matchArticlesToLedger(withinLookback, [instrument]);

  const seenHeadlines = new Set<string>();
  const deduped = matched.filter((a) => {
    const key = a.title.trim().toLowerCase();
    if (seenHeadlines.has(key)) return false;
    seenHeadlines.add(key);
    return true;
  });

  return deduped.map((a) => {
    const relevance = classifyArticleRelevance(a, direction);
    const confidence: RelevanceConfidence = "low"; // keyword heuristic never claims more than low confidence
    return {
      headline: a.title,
      source: a.source,
      publishedAt: a.publishedAt,
      url: a.link,
      eventCategory: detectEventCategory(`${a.title} ${a.snippet}`),
      relevance,
      confidence,
      explanation: `Keyword-heuristic read (${FOME_RELEVANCE_HEURISTIC_VERSION}, not a validated sentiment model): classified "${relevance}" relative to the technical direction "${direction ?? "unavailable"}". Never claims causation and never overrides the deterministic technical/FOME result.`,
    };
  });
}

export type RunNewsRelevance = "SUPPORTS_TECHNICAL_TREND" | "OPPOSES_TECHNICAL_TREND" | "MIXED_NEWS" | "NO_MATERIAL_NEWS" | "NEWS_UNAVAILABLE";

/**
 * Aggregates classified articles into the run-level news_relevance state.
 * Never overrides the deterministic technical result -- presented as
 * contextual evidence only.
 */
export function classifyRunNewsRelevance(items: ClassifiedNewsItem[]): RunNewsRelevance {
  if (items.length === 0) return "NO_MATERIAL_NEWS";
  const supportive = items.filter((i) => i.relevance === "supportive").length;
  const opposing = items.filter((i) => i.relevance === "opposing").length;
  if (supportive > 0 && opposing > 0) return "MIXED_NEWS";
  if (supportive > 0) return "SUPPORTS_TECHNICAL_TREND";
  if (opposing > 0) return "OPPOSES_TECHNICAL_TREND";
  return "NO_MATERIAL_NEWS";
}
