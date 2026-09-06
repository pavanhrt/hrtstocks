export default function BacktestsPage() {
  return (
    <div className="card">
      <h1 style={{ marginTop: 0 }}>Backtests</h1>
      <p style={{ color: "var(--text-dim)" }}>
        Historical validation (point-in-time universe, costs/slippage, original-vs-optimized
        comparison) is Phase 2 work &mdash; see <code>skills/backtesting/SKILL.md</code> and the
        <code> backtest_runs</code>/<code>backtest_trades</code> entities in{" "}
        <code>references/technical-architecture.md</code>. Phase 1 ships the daily screening
        pipeline and rule-trace reporting first, per <code>AGENTS.md</code>'s CRITICAL rule 9:
        "Backtest a strategy before describing it as validated."
      </p>
    </div>
  );
}
