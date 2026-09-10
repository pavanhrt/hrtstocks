import { getDirectionAnalysis } from "@/lib/data/direction";
import DirectionTable from "./DirectionTable";

export default async function DirectionPage() {
  const rows = await getDirectionAnalysis();

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Direction</h1>
        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
          Monthly, weekly, and daily Dow-theory swing structure (HH/HL/LH/LL) for every stock, with a best-effort
          Elliott-wave label where the last swings validate against GUE&apos;s documented hard gates. Charts are
          replaced in place on each run; if the underlying structure hasn&apos;t changed, the existing chart is kept
          rather than re-rendered.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p style={{ color: "var(--text-dim)" }}>
            No direction data yet -- it is populated by the next completed screening run once market data is
            flowing.
          </p>
        </div>
      ) : (
        <DirectionTable rows={rows} />
      )}
    </div>
  );
}
