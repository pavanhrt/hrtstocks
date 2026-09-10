import { getLatestPublishedRun, getStockLedger } from "@/lib/data/runs";
import StockLedgerTable from "./StockLedgerTable";

export default async function StocksPage() {
  const run = await getLatestPublishedRun();
  if (!run) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Complete stock ledger</h1>
        <p style={{ color: "var(--text-dim)" }}>No completed run yet.</p>
      </div>
    );
  }

  const rows = await getStockLedger(run.id);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>Complete stock ledger &mdash; {run.run_date}</h1>
      <StockLedgerTable rows={rows as any} runId={run.id} />
    </div>
  );
}
