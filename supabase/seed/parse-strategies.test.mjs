import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrategyFile } from "./parse-strategies.mjs";

test("parseStrategyFile preserves exact per-rule source references", () => {
  for (const filename of ["buy-signal-playbook.yaml", "sell-signal-playbook.yaml", "buy-swing.yaml", "sell-swing.yaml", "smm.yaml", "papa.yaml"]) {
    const parsed = parseStrategyFile(filename);
    assert.ok(parsed.rules.length > 0, `${filename} should contain decision rules`);
    for (const rule of parsed.rules) {
      assert.ok(rule.source_refs?.document, `${rule.rule_id} should retain a source document`);
      assert.ok(rule.source_refs?.locator, `${rule.rule_id} should retain an exact locator`);
      assert.deepEqual(rule.source_refs, rule.raw.source_refs);
    }
  }
});

test("swing strategy semantic version changes with restored branches and evidence gates", () => {
  const buy = parseStrategyFile("buy-swing.yaml");
  const sell = parseStrategyFile("sell-swing.yaml");
  assert.equal(buy.strategy.rule_version, "1.1.0");
  assert.equal(sell.strategy.rule_version, "1.1.0");
  assert.match(buy.rules.find((r) => r.rule_id === "WBP-M1").expression, /sideways/);
  assert.match(sell.rules.find((r) => r.rule_id === "WSP-S1").expression, /sideways/);
  assert.equal(buy.rules.find((r) => r.rule_id === "WBP-M2").missing_result, "MANUAL_REVIEW");
  assert.equal(sell.rules.find((r) => r.rule_id === "WSP-S3").missing_result, "MANUAL_REVIEW");
});
