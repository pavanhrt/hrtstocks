import { currentViewer } from "../access.ts";
import { getDb } from "../db/pool.ts";
import type { Tables } from "../database.types.ts";

export async function getStrategyVersions() {
  await currentViewer();
  return getDb().query<Pick<Tables<"strategy_versions">, "id" | "framework" | "strategy_id" | "rule_version" | "status" | "is_active" | "created_at">>(
    `select id, framework, strategy_id, rule_version, status, is_active, created_at
       from strategy_versions
      order by framework asc`,
  );
}

export async function getRuleDefinitionsForVersion(strategyVersionId: string) {
  await currentViewer();
  return getDb().query<Tables<"rule_definitions">>(
    `select * from rule_definitions where strategy_version_id = $1 order by rule_id asc`,
    [strategyVersionId],
  );
}
