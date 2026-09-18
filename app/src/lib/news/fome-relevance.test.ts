import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyArticleRelevance,
  findAndClassifyInstrumentNews,
  classifyRunNewsRelevance,
} from "./fome-relevance.ts";
import type { NewsArticle } from "./rss.ts";

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    title: "Reliance Industries announces results",
    link: "https://example.com/a",
    snippet: "",
    source: "Test Feed",
    publishedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("classifyArticleRelevance: positive keywords + bullish direction is supportive", () => {
  const a = { title: "Reliance beats estimates, record profit", snippet: "" };
  assert.equal(classifyArticleRelevance(a, "bullish"), "supportive");
});

test("classifyArticleRelevance: positive keywords + bearish direction is opposing", () => {
  const a = { title: "Reliance beats estimates, record profit", snippet: "" };
  assert.equal(classifyArticleRelevance(a, "bearish"), "opposing");
});

test("classifyArticleRelevance: negative keywords + bearish direction is supportive", () => {
  const a = { title: "Company faces probe, fraud investigation", snippet: "" };
  assert.equal(classifyArticleRelevance(a, "bearish"), "supportive");
});

test("classifyArticleRelevance: no keyword hits is neutral, never guessed", () => {
  const a = { title: "Company holds annual general meeting", snippet: "" };
  assert.equal(classifyArticleRelevance(a, "bullish"), "neutral");
});

test("classifyArticleRelevance: both positive and negative keywords is uncertain, never forced to a side", () => {
  const a = { title: "Company beats estimates but faces investigation", snippet: "" };
  assert.equal(classifyArticleRelevance(a, "bullish"), "uncertain");
});

test("classifyArticleRelevance: no technical direction available still classifies the article's own polarity", () => {
  const a = { title: "Company beats estimates, record profit", snippet: "" };
  assert.equal(classifyArticleRelevance(a, null), "supportive");
});

test("findAndClassifyInstrumentNews: matches by symbol, deduplicates by headline, respects lookback window", () => {
  const instrument = { instrumentId: "NSE_RELIANCE", symbol: "RELIANCE", name: "Reliance Industries" };
  const recent = article({ title: "RELIANCE wins order for new refinery", publishedAt: new Date().toISOString() });
  const duplicate = article({ title: "RELIANCE wins order for new refinery", link: "https://example.com/dup", publishedAt: new Date().toISOString() });
  const stale = article({
    title: "RELIANCE old news item",
    publishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const unrelated = article({ title: "TCS announces buyback", publishedAt: new Date().toISOString() });

  const result = findAndClassifyInstrumentNews([recent, duplicate, stale, unrelated], instrument, "bullish", 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].headline, "RELIANCE wins order for new refinery");
  assert.equal(result[0].confidence, "low");
});

test("classifyRunNewsRelevance: no matched items is NO_MATERIAL_NEWS", () => {
  assert.equal(classifyRunNewsRelevance([]), "NO_MATERIAL_NEWS");
});

test("classifyRunNewsRelevance: only supportive items is SUPPORTS_TECHNICAL_TREND", () => {
  const items = [
    { headline: "a", source: "s", publishedAt: null, url: "u", eventCategory: "general", relevance: "supportive" as const, confidence: "low" as const, explanation: "" },
  ];
  assert.equal(classifyRunNewsRelevance(items), "SUPPORTS_TECHNICAL_TREND");
});

test("classifyRunNewsRelevance: mix of supportive and opposing is MIXED_NEWS, never picks a side", () => {
  const items = [
    { headline: "a", source: "s", publishedAt: null, url: "u", eventCategory: "general", relevance: "supportive" as const, confidence: "low" as const, explanation: "" },
    { headline: "b", source: "s", publishedAt: null, url: "u", eventCategory: "general", relevance: "opposing" as const, confidence: "low" as const, explanation: "" },
  ];
  assert.equal(classifyRunNewsRelevance(items), "MIXED_NEWS");
});
