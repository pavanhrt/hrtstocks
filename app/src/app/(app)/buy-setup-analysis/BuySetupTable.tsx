import Link from "next/link";
import type { BuySetupRow } from "@/lib/data/buy-setup-analysis";
import { Badge } from "../Badge";
import ChartPreview from "../ChartPreview";

function NotApplicableCell({ reason = "three-timeframe gate not passed" }: { reason?: string }) {
  return (
    <span className="badge badge-NOT_APPLICABLE" title={`NOT_APPLICABLE -- ${reason}`}>
      NOT APPLICABLE
    </span>
  );
}

function Cell({ value, notApplicable, reason }: { value: React.ReactNode; notApplicable: boolean; reason?: string }) {
  if (notApplicable) return <NotApplicableCell reason={reason} />;
  return <>{value}</>;
}

function DowCell({ state, result }: { state: string | null; result: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ fontSize: 12 }}>{state ?? "—"}</span>
      <Badge status={result} />
    </div>
  );
}

function BreakoutEvidenceCell({ breakoutUpWithVolume }: { breakoutUpWithVolume: boolean | null }) {
  if (breakoutUpWithVolume == null) return <span style={{ color: "var(--text-dim)", fontSize: 12 }}>n/a</span>;
  return <span style={{ fontSize: 12 }}>{breakoutUpWithVolume ? "breakout + volume" : "no confirmed breakout"}</span>;
}

export default function BuySetupTable({ rows, startIndex }: { rows: BuySetupRow[]; startIndex: number }) {
  if (rows.length === 0) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No stocks match these filters.</p>;
  }
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Buy setup analysis results; scroll horizontally for all columns">
      <table>
        <caption className="sr-only">Three-timeframe bullish gate and downstream 15-minute analysis, per stock</caption>
        <thead>
          <tr>
            <th>#</th>
            <th>Instrument</th>
            <th>Monthly Dow</th>
            <th>Monthly breakout/vol.</th>
            <th>Weekly Dow</th>
            <th>Weekly breakout/vol.</th>
            <th>Daily Dow</th>
            <th>Daily breakout/vol.</th>
            <th>3-TF gate</th>
            <th>Daily pattern</th>
            <th>Daily EMA crossover</th>
            <th>Daily chart pattern</th>
            <th>Support</th>
            <th>Resistance</th>
            <th>Breakout</th>
            <th>Channel/range</th>
            <th>15m EMA crossover</th>
            <th>15m RSI</th>
            <th>15m Stochastic</th>
            <th>15m Bollinger</th>
            <th>15m +DI</th>
            <th>15m -DI</th>
            <th>15m ADX</th>
            <th>15m GUE wave</th>
            <th>RSI bull. reversal</th>
            <th>MACD bull. reversal</th>
            <th>Overall status</th>
            <th>Evidence time</th>
            <th>Charts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const na = !row.qualified;
            return (
              <tr key={row.instrumentId}>
                <td>{startIndex + i + 1}</td>
                <td>
                  <Link href={`/buy-setup-analysis/${row.instrumentId}`}>{row.symbol}</Link>{" "}
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{row.name}</span>
                </td>
                <td>
                  <DowCell state={row.monthly.dowState} result={row.monthly.result} />
                </td>
                <td>
                  <BreakoutEvidenceCell breakoutUpWithVolume={row.monthly.breakoutUpWithVolume} />
                </td>
                <td>
                  <DowCell state={row.weekly.dowState} result={row.weekly.result} />
                </td>
                <td>
                  <BreakoutEvidenceCell breakoutUpWithVolume={row.weekly.breakoutUpWithVolume} />
                </td>
                <td>
                  <DowCell state={row.daily.dowState} result={row.daily.result} />
                </td>
                <td>
                  <BreakoutEvidenceCell breakoutUpWithVolume={row.daily.breakoutUpWithVolume} />
                </td>
                <td>
                  <Badge status={row.threeTimeframeGate} />
                </td>
                <td>
                  <Cell
                    notApplicable={na}
                    value={
                      row.candlestickPatterns.length > 0 ? (
                        <span style={{ fontSize: 12 }}>{row.candlestickPatterns.map((p) => `${p.name} (${p.state})`).join(", ")}</span>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: 12 }} title="No signal from the currently implemented candlestick detectors -- not proof no pattern exists (see detector coverage above)">
                          none among implemented detectors
                        </span>
                      )
                    }
                  />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.dailyEmaCrossover ? <Badge status={row.dailyEmaCrossover.status} /> : <Badge status="NO_DATA" />} />
                </td>
                <td>
                  <Cell
                    notApplicable={na}
                    value={
                      row.chartPatterns.length > 0 ? (
                        <span style={{ fontSize: 12 }}>{row.chartPatterns.map((p) => `${p.name} (${p.state})`).join(", ")}</span>
                      ) : (
                        <span style={{ color: "var(--text-dim)", fontSize: 12 }} title="No signal from the currently implemented chart-pattern detectors -- not proof no pattern exists (see detector coverage above)">
                          none among implemented detectors
                        </span>
                      )
                    }
                  />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.support != null ? row.support.toFixed(2) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.resistance != null ? row.resistance.toFixed(2) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={<Badge status={row.breakoutStatus} />} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.channelType ?? <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={<Badge status={row.fifteenMinEmaCrossover ?? "NO_DATA"} />} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinRsi != null ? row.fifteenMinRsi.toFixed(1) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinStochastic ? `%K ${row.fifteenMinStochastic.k?.toFixed(1) ?? "—"} / %D ${row.fifteenMinStochastic.d?.toFixed(1) ?? "—"}` : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={<Badge status={row.fifteenMinBollingerStatus ?? "NO_DATA"} />} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinPlusDi != null ? row.fifteenMinPlusDi.toFixed(1) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinMinusDi != null ? row.fifteenMinMinusDi.toFixed(1) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinAdx != null ? row.fifteenMinAdx.toFixed(1) : <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={row.fifteenMinWave ?? <span style={{ color: "var(--text-dim)" }}>n/a</span>} />
                </td>
                <td>
                  <Cell notApplicable={na} value={<Badge status={row.rsiBullishReversal ?? "NO_DATA"} />} />
                </td>
                <td>
                  <Cell notApplicable={na} value={<Badge status={row.macdBullishReversal ?? "NO_DATA"} />} />
                </td>
                <td>
                  <Badge status={row.overallStatus} />
                </td>
                <td style={{ fontSize: 11 }}>{row.evidenceTimestamp ? new Date(row.evidenceTimestamp).toLocaleString("en-IN") : "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: 4 }}>
                    <ChartPreview src={row.dailyChartUrl} alt={`${row.symbol} daily buy-setup chart`} compact />
                    <ChartPreview src={row.fifteenMinChartUrl} alt={`${row.symbol} 15-minute buy-setup chart`} compact />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
