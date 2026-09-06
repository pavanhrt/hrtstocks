import { createClient } from "@/lib/supabase/server";

export async function getStrategyVersions() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("strategy_versions")
    .select("id, framework, strategy_id, rule_version, status, is_active, created_at")
    .order("framework", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getRuleDefinitionsForVersion(strategyVersionId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rule_definitions")
    .select("*")
    .eq("strategy_version_id", strategyVersionId)
    .order("rule_id", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
