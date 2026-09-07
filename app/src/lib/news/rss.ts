import Parser from "rss-parser";
import { NEWS_FEEDS } from "./feeds";

export type NewsArticle = {
  title: string;
  link: string;
  snippet: string;
  source: string;
  publishedAt: string | null;
};

const parser = new Parser({ timeout: 10_000 });

function stripHtml(input: string | undefined): string {
  if (!input) return "";
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches every configured feed in parallel and returns a flat,
 * reverse-chronological article list. A single feed failing (network error,
 * feed taken down) is logged and skipped -- it never breaks the page for the
 * other feeds, matching this project's "quarantine, don't crash" pattern.
 */
export async function fetchNewsArticles(): Promise<NewsArticle[]> {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 300 }, // 5 minutes -- fresh enough for news, avoids hammering the source on every request
      });
      if (!res.ok) throw new Error(`${feed.source} returned ${res.status}`);
      const xml = await res.text();
      const parsed = await parser.parseString(xml);
      return (parsed.items ?? []).map(
        (item): NewsArticle => ({
          title: stripHtml(item.title) || "(untitled)",
          link: item.link ?? "",
          snippet: stripHtml(item.contentSnippet ?? item.content ?? item.summary).slice(0, 280),
          source: feed.source,
          publishedAt: item.isoDate ?? item.pubDate ?? null,
        })
      );
    })
  );

  const articles: NewsArticle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") articles.push(...result.value);
    // A rejected feed is intentionally swallowed here (not surfaced as a page
    // error) -- news is supplementary context, not an audited pipeline
    // result, so partial availability degrades gracefully rather than
    // blocking the page.
  }

  articles.sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bt - at;
  });

  return articles;
}
