import { getStrategyVersions, getRuleDefinitionsForVersion } from "@/lib/data/strategies";

export default async function StrategiesPage() {
  const versions = await getStrategyVersions();

  const rulesByVersion = await Promise.all(
    versions.map(async (v) => ({ version: v, rules: await getRuleDefinitionsForVersion(v.id) }))
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Strategy manager</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Read-only in Phase 1: rules are versioned from{" "}
          <code>strategies/*.yaml</code> via <code>supabase/seed/seed-strategies.mjs</code>.
          Approval workflows, conflict resolution, and editing land in Phase 2.
        </p>
      </div>

      {rulesByVersion.map(({ version, rules }) => (
        <div className="card" key={version.id}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            {version.framework} &middot; {version.strategy_id} v{version.rule_version}{" "}
            <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 400 }}>({version.status})</span>
          </h2>
          {rules.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
              Composite/cross-strategy gates &mdash; see{" "}
              <code>strategies/shared-gates.yaml</code> for the tier and hard-gate definitions.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rule ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Direction</th>
                  <th>Hard gate</th>
                  <th>Expression</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.rule_id}</td>
                    <td>{r.name}</td>
                    <td>{r.source_status}</td>
                    <td>{r.direction ?? "-"}</td>
                    <td>{r.hard_gate ? "yes" : "no"}</td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{r.expression}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}
