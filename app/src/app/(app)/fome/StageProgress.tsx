"use client";

import { FOME_STAGES } from "./stages";

/**
 * The page's 10-step loading indicator. `completedStages` is derived from
 * the run's own `stage_history` (server-authoritative), never guessed
 * client-side.
 */
export default function StageProgress({ currentStage, completedStages }: { currentStage: string | null; completedStages: Set<string> }) {
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
      {FOME_STAGES.map((stage, i) => {
        const done = completedStages.has(stage.key);
        const active = stage.key === currentStage;
        return (
          <li key={stage.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                color: done ? "white" : active ? "white" : "var(--text-dim)",
                background: done ? "var(--pass)" : active ? "var(--watch)" : "var(--panel-border)",
                flexShrink: 0,
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span style={{ color: active ? undefined : done ? undefined : "var(--text-dim)", fontWeight: active ? 600 : 400 }}>
              {stage.label}
              {active ? "…" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
