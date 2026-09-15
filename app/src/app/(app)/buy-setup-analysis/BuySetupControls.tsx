"use client";

import { useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

const SEARCH_DEBOUNCE_MS = 400;

const DOW_STATES = ["all", "uptrend_intact", "downtrend_intact", "sideways", "confirmed_reversal_bullish", "confirmed_reversal_bearish", "ambiguous"];
const GATES = ["all", "PASS", "FAIL", "NO_DATA"];
const REVERSALS = [
  { value: "all", label: "Any" },
  { value: "either_pass", label: "RSI or MACD divergence" },
  { value: "rsi_pass", label: "RSI divergence only" },
  { value: "macd_pass", label: "MACD divergence only" },
  { value: "none", label: "No divergence evidence" },
];
const OVERALL_STATUSES = ["all", "QUALIFIED_FOR_15M_ANALYSIS", "TECHNICAL_EVIDENCE_PRESENT", "WATCH", "MANUAL_REVIEW", "FAIL", "NO_DATA"];
const AVAILABILITY = [
  { value: "all", label: "All" },
  { value: "has_data", label: "Has 15-minute data" },
  { value: "no_data", label: "No data" },
];

export type BuySetupFilterState = {
  q: string;
  monthlyState: string;
  weeklyState: string;
  dailyState: string;
  gate: string;
  reversal: string;
  overallStatus: string;
  dataAvailability: string;
};

export default function BuySetupControls({ initial }: { initial: BuySetupFilterState }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState(initial);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function navigate(next: BuySetupFilterState) {
    const params = new URLSearchParams();
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.monthlyState !== "all") params.set("monthly", next.monthlyState);
    if (next.weeklyState !== "all") params.set("weekly", next.weeklyState);
    if (next.dailyState !== "all") params.set("daily", next.dailyState);
    if (next.gate !== "all") params.set("gate", next.gate);
    if (next.reversal !== "all") params.set("reversal", next.reversal);
    if (next.overallStatus !== "all") params.set("status", next.overallStatus);
    if (next.dataAvailability !== "all") params.set("data", next.dataAvailability);
    router.push(params.toString() ? `${pathname}?${params.toString()}` : pathname);
  }

  function update(patch: Partial<BuySetupFilterState>, debounce = false) {
    const next = { ...state, ...patch };
    setState(next);
    if (debounce) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => navigate(next), SEARCH_DEBOUNCE_MS);
    } else {
      navigate(next);
    }
  }

  return (
    <div className="filter-controls" style={{ flexWrap: "wrap", gap: 8 }}>
      <input
        aria-label="Search symbol or name"
        placeholder="Search symbol or name..."
        value={state.q}
        onChange={(e) => update({ q: e.target.value }, true)}
        style={{ flex: "1 1 200px", minWidth: 180, padding: "6px 10px" }}
      />
      <select aria-label="Filter by monthly Dow state" value={state.monthlyState} onChange={(e) => update({ monthlyState: e.target.value })}>
        {DOW_STATES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All monthly states" : s}
          </option>
        ))}
      </select>
      <select aria-label="Filter by weekly Dow state" value={state.weeklyState} onChange={(e) => update({ weeklyState: e.target.value })}>
        {DOW_STATES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All weekly states" : s}
          </option>
        ))}
      </select>
      <select aria-label="Filter by daily Dow state" value={state.dailyState} onChange={(e) => update({ dailyState: e.target.value })}>
        {DOW_STATES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All daily states" : s}
          </option>
        ))}
      </select>
      <select aria-label="Filter by three-timeframe gate" value={state.gate} onChange={(e) => update({ gate: e.target.value })}>
        {GATES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All gate results" : `Gate: ${s}`}
          </option>
        ))}
      </select>
      <select aria-label="Filter by reversal evidence" value={state.reversal} onChange={(e) => update({ reversal: e.target.value })}>
        {REVERSALS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <select aria-label="Filter by overall research status" value={state.overallStatus} onChange={(e) => update({ overallStatus: e.target.value })}>
        {OVERALL_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All statuses" : s}
          </option>
        ))}
      </select>
      <select aria-label="Filter by data availability" value={state.dataAvailability} onChange={(e) => update({ dataAvailability: e.target.value })}>
        {AVAILABILITY.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
    </div>
  );
}
