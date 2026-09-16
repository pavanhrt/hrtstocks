// Unambiguous, exchange-facing date/time formatting (AGENTS.md: "Use
// Asia/Kolkata for exchange-facing display and retain UTC internally").
// Renders "11 Sep 2026, 3:30 pm IST" instead of a locale-ambiguous numeric
// format like "11/9/2026" (which reads as 9 Nov in a US locale).

// Built from formatToParts (not a locale's own punctuation/ordering) so the
// output is pinned to exactly "DD Mon YYYY, H:MM am/pm IST" regardless of
// ICU/locale differences (e.g. some locales render "Sept" instead of "Sep",
// or order month-before-day).
const PART_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function partsFor(date: Date) {
  const parts = Object.fromEntries(PART_FORMATTER.formatToParts(date).map((p) => [p.type, p.value]));
  return parts as Record<"day" | "month" | "year" | "hour" | "minute" | "dayPeriod", string>;
}

/** "11 Sep 2026, 3:30 pm IST" -- never an ambiguous numeric date. */
export function formatIstDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const p = partsFor(date);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()} IST`;
}

/** "11 Sep 2026" -- date only, no time. */
export function formatIstDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const p = partsFor(date);
  return `${p.day} ${p.month} ${p.year}`;
}
