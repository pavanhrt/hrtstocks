import type { NewsArticle } from "./rss";

export type LedgerInstrument = {
  instrumentId: string;
  symbol: string;
  name: string | null;
};

export type MatchedArticle = NewsArticle & { matchedInstruments: LedgerInstrument[] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Headlines almost never include the corporate suffix ("Reliance Industries
// Limited" appears in filings, "Reliance Industries" appears in headlines),
// so stripping it is safe and meaningfully improves recall. This is
// different from truncating to the first word: "Reliance Industries" and
// "Tata Motors" stay fully distinctive multi-word names, so it doesn't
// reopen the conglomerate-group false-positive problem below.
const CORPORATE_SUFFIX_RE = /\s+(limited|ltd\.?|inc\.?|corp\.?|corporation|plc)\.?$/i;

function stripCorporateSuffix(name: string): string {
  return name.replace(CORPORATE_SUFFIX_RE, "").trim();
}

/**
 * Heuristic, not authoritative: matches an article to a ledger instrument if
 * its exchange symbol appears as a whole word, or its company name (with any
 * trailing "Limited"/"Ltd" stripped) appears as a substring. This can miss
 * real mentions (a headline using a name fragment shorter than the full
 * name) and, in principle, still over-match if two ledger instruments share
 * an identical stripped name -- neither is a verified tag, just "articles
 * possibly about this stock."
 *
 * Deliberately does NOT fall back to matching only a company name's first
 * word (e.g. bare "Tata" or "HDFC"): tested against live feeds, that
 * produced real misattributions for Indian conglomerate group names --
 * "Tata Motors" and "HDFC Life" headlines both matched onto TCS and HDFC
 * Bank respectively, since "Tata" and "HDFC" are shared by many
 * separately-listed companies. False attribution is worse than a missed
 * mention here, so precision wins over recall.
 */
export function matchArticlesToLedger(
  articles: NewsArticle[],
  instruments: LedgerInstrument[]
): MatchedArticle[] {
  const matchers = instruments.map((inst) => {
    const patterns: RegExp[] = [new RegExp(`\\b${escapeRegExp(inst.symbol)}\\b`, "i")];
    if (inst.name) {
      patterns.push(new RegExp(escapeRegExp(stripCorporateSuffix(inst.name)), "i"));
    }
    return { inst, patterns };
  });

  return articles
    .map((article) => {
      const haystack = `${article.title} ${article.snippet}`;
      const matchedInstruments = matchers
        .filter(({ patterns }) => patterns.some((p) => p.test(haystack)))
        .map(({ inst }) => inst);
      return { ...article, matchedInstruments };
    })
    .filter((a) => a.matchedInstruments.length > 0);
}
