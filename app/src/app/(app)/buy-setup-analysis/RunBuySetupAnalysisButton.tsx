"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000; // give up polling after 20 min -- the enrichment itself may still be self-chaining; a manual refresh will pick it up whenever it finishes

type EnrichmentState = "pending" | "processing" | "validated" | "validation_failed" | "published" | null;

/**
 * Visible to Researcher/strategy_admin/system_admin only (the page itself
 * only renders this component for those roles -- see page.tsx). Clicking
 * POSTs to /api/buy-setup-analysis, which authenticates server-side and
 * forwards to the analyze-buy-setup Edge Function with the service secret --
 * the secret itself never reaches this component. Repeated clicks are safe:
 * the Edge Function is idempotent and returns the existing
 * processing/published state instead of starting a duplicate enrichment
 * (see that function's own header comment).
 */
export default function RunBuySetupAnalysisButton({ initialEnrichmentState }: { initialEnrichmentState: EnrichmentState }) {
  const [state, setState] = useState<EnrichmentState>(initialEnrichmentState);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function startPolling() {
    if (pollRef.current) return;
    pollStartedAtRef.current = Date.now();
    pollRef.current = setInterval(() => {
      if (pollStartedAtRef.current && Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);
  }

  async function trigger() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/buy-setup-analysis", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = body.error ?? `Request failed (${res.status})`;
        throw new Error(body.correlationId ? `${message} (ref: ${body.correlationId})` : message);
      }
      setState(body.status === "published" ? "published" : "processing");
      if (body.status !== "published") startPolling();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start buy-setup analysis");
    } finally {
      setPending(false);
    }
  }

  // Wording must match actual behavior: the Edge Function returns
  // immediately for an already-published run WITHOUT creating or processing
  // any new immutable analysis (its Deno.serve handler short-circuits on
  // enrichment_state === "published"). Calling this "Re-run" implied a fresh
  // computation that does not happen -- "Analysis published" is the truthful
  // state, and clicking it only ever checks whether a NEWER published
  // screening run now needs its own (not-yet-started) enrichment.
  const label =
    state === "processing"
      ? "Buy-setup analysis running..."
      : state === "validation_failed"
        ? "Retry buy-setup analysis"
        : state === "published"
          ? "Analysis published"
          : "Run buy-setup analysis";

  return (
    <div>
      <button onClick={trigger} disabled={pending || state === "processing"}>
        {pending ? "Starting..." : label}
      </button>
      {state === "published" && (
        <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "4px 0 0" }}>
          This run&apos;s 15-minute analysis is already published and immutable. Clicking only checks whether a newer
          screening run now needs its own enrichment -- it never reprocesses this one.
        </p>
      )}
      {state === "processing" && (
        <p role="status" aria-live="polite" style={{ color: "var(--watch)", fontSize: 12, margin: "4px 0 0" }}>
          Processing -- this page refreshes automatically every 15s while it runs.
        </p>
      )}
      {error && (
        <p role="status" aria-live="polite" style={{ color: "var(--fail)", fontSize: 13, margin: "4px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}
