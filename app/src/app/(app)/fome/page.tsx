"use client";

import { useEffect, useRef, useState } from "react";
import InstrumentSearch from "./InstrumentSearch";
import StageProgress from "./StageProgress";
import TimeframeTable from "./TimeframeTable";
import DailySummary from "./DailySummary";
import FifteenMinSummary from "./FifteenMinSummary";
import RuleChecklist from "./RuleChecklist";
import DerivativePanel from "./DerivativePanel";
import StrategyComparison from "./StrategyComparison";
import NewsPanel from "./NewsPanel";
import RiskAndProvenance from "./RiskAndProvenance";
import type { FomeAnalysisResult, InstrumentFomeSummary, InstrumentSearchResult } from "@/lib/data/fome";

const POLL_INTERVAL_MS = 2000;

const FINAL_ALIGNMENT_LABEL: Record<string, string> = {
  ALIGNED_BULLISH: "Aligned bullish",
  ALIGNED_BEARISH: "Aligned bearish",
  SIDEWAYS: "Sideways",
  VOLATILITY_EXPANSION: "Volatility expansion",
  MIXED: "Mixed evidence",
  WAIT_FOR_ENTRY_CONFIRMATION: "Wait for entry confirmation",
  MANUAL_REVIEW: "Manual review",
  UNAVAILABLE: "Unavailable",
};

function isRunFullyDone(result: FomeAnalysisResult | null): boolean {
  if (!result) return false;
  if (result.status === "failed") return true;
  const technicalDone = result.status === "completed" || result.status === "partial";
  return technicalDone && result.newsRelevance != null;
}

export default function FomePage() {
  const [selected, setSelected] = useState<InstrumentSearchResult | null>(null);
  const [summary, setSummary] = useState<InstrumentFomeSummary | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<FomeAnalysisResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!selected) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/instruments/${encodeURIComponent(selected.id)}/summary`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setSummary(body.summary ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    if (!runId) return;
    async function poll() {
      const res = await fetch(`/api/fome-analysis/${runId}`);
      if (!res.ok) return;
      const body = await res.json();
      setResult(body.result ?? null);
      if (isRunFullyDone(body.result)) {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runId]);

  async function onAnalyze() {
    if (!selected) return;
    setStarting(true);
    setError(null);
    setResult(null);
    setRunId(null);
    try {
      const res = await fetch("/api/fome-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrumentId: selected.id }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not start the analysis.");
        return;
      }
      setRunId(body.runId);
    } finally {
      setStarting(false);
    }
  }

  const completedStages = new Set((result?.stageHistory ?? []).map((s) => s.stage));
  const running = Boolean(runId) && !isRunFullyDone(result) && result?.status !== "failed";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>FOME -- Futures &amp; Options Made Easy</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Search for any supported NSE stock or tracked index, then analyze it on demand. This refreshes and
          evaluates only the selected instrument -- it never triggers the full-universe screening pipeline.
        </p>
        <InstrumentSearch onSelect={setSelected} />
      </div>

      {selected && summary && (
        <div className="card" style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {summary.symbol} {summary.name ? <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>-- {summary.name}</span> : null}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              {summary.isIndex ? "Index" : "Stock"} &middot; {summary.exchange} &middot; Derivative eligibility:{" "}
              {summary.derivativeEligible == null ? "unknown until analyzed" : summary.derivativeEligible ? "eligible" : "not currently eligible"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Last analysis: {summary.lastAnalysisAt ? new Date(summary.lastAnalysisAt).toLocaleString() : "never"}
              {summary.dataFreshness ? ` (${summary.dataFreshness})` : ""}
            </div>
          </div>
          <button onClick={onAnalyze} disabled={starting || running} style={{ padding: "10px 18px", fontWeight: 600 }}>
            {starting || running ? "Analyzing..." : "Analyze latest data"}
          </button>
        </div>
      )}

      {error && (
        <div className="card" style={{ color: "var(--fail)" }}>
          {error}
        </div>
      )}

      {runId && result && !isRunFullyDone(result) && result.status !== "failed" && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 15 }}>Analyzing {selected?.symbol}...</h2>
          <StageProgress currentStage={result.currentStage} completedStages={completedStages} />
        </div>
      )}

      {result?.status === "failed" && (
        <div className="card" style={{ color: "var(--fail)" }}>
          The analysis failed: {result.errorMessage ?? "unknown error"}.
        </div>
      )}

      {result && isRunFullyDone(result) && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Final direction and market regime</h2>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{result.finalAlignment ? (FINAL_ALIGNMENT_LABEL[result.finalAlignment] ?? result.finalAlignment) : "Unavailable"}</div>
            <p style={{ fontSize: 13, marginTop: 4 }}>{result.alignmentReason}</p>
            {result.underlyingAlignment && (
              <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Underlying higher-timeframe conclusion (deferred, not discarded): {FINAL_ALIGNMENT_LABEL[result.underlyingAlignment] ?? result.underlyingAlignment}
              </p>
            )}
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Monthly / Weekly / Daily / 15-minute direction</h2>
            <TimeframeTable timeframes={result.timeframes} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Daily chart and summary</h2>
            <DailySummary row={result.timeframes.daily} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>15-minute chart and summary</h2>
            <FifteenMinSummary row={result.timeframes["15m"]} dailyRow={result.timeframes.daily} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>FOME rule checklist</h2>
            <RuleChecklist traces={result.ruleTraces} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Futures and option-chain / OI analysis</h2>
            <DerivativePanel
              derivativeEligible={result.derivativeEligible}
              derivativeSource={result.derivativeSource}
              selectedExpiry={result.selectedExpiry}
              spotDerivativeAligned={result.spotDerivativeAligned}
              spotDerivativeSkewReason={result.spotDerivativeSkewReason}
              ruleTraces={result.ruleTraces}
            />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Strategy comparison</h2>
            <StrategyComparison candidates={result.strategyCandidates} derivativeEligible={result.derivativeEligible} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Recent news and trend relevance</h2>
            <NewsPanel newsRelevance={result.newsRelevance} items={result.news} />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 15 }}>Risk, limitations, conflicts, and data provenance</h2>
            <RiskAndProvenance result={result} />
          </div>
        </>
      )}
    </div>
  );
}
