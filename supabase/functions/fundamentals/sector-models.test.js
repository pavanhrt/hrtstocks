import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSectorModel, componentDefinitionsFor, componentWeightsFor, SECTOR_MODELS } from "./sector-models.js";
import { parseFundamentalScoreSpec } from "../../seed/parse-fundamental-score.mjs";

const { spec } = parseFundamentalScoreSpec();

test("resolveSectorModel: recognizes each modeled sector", () => {
  assert.equal(resolveSectorModel("NON_FINANCIAL").sectorModel, SECTOR_MODELS.NON_FINANCIAL);
  assert.equal(resolveSectorModel("BANK").sectorModel, SECTOR_MODELS.BANK);
  assert.equal(resolveSectorModel("NBFC").sectorModel, SECTOR_MODELS.NBFC);
});

test("resolveSectorModel: undisclosed classification is NO_DATA (resolved:false), never guessed", () => {
  assert.deepEqual(resolveSectorModel(null), { sectorModel: null, resolved: false });
  assert.deepEqual(resolveSectorModel(undefined), { sectorModel: null, resolved: false });
  assert.deepEqual(resolveSectorModel(""), { sectorModel: null, resolved: false });
});

test("resolveSectorModel: a disclosed but unrecognized classification (e.g. insurer) is UNSUPPORTED_FALLBACK, resolved:true -- a real MANUAL_REVIEW case, not missing data", () => {
  const r = resolveSectorModel("INSURANCE");
  assert.equal(r.sectorModel, SECTOR_MODELS.UNSUPPORTED_FALLBACK);
  assert.equal(r.resolved, true);
});

test("componentDefinitionsFor: UNSUPPORTED_FALLBACK returns null -- caller must not attempt to score", () => {
  assert.equal(componentDefinitionsFor(spec, SECTOR_MODELS.UNSUPPORTED_FALLBACK), null);
});

test("componentWeightsFor: UNSUPPORTED_FALLBACK has no scored components", () => {
  assert.deepEqual(componentWeightsFor(spec, SECTOR_MODELS.UNSUPPORTED_FALLBACK), {});
});

test("componentWeightsFor: every non-fallback sector model declares all six components", () => {
  for (const model of [SECTOR_MODELS.NON_FINANCIAL, SECTOR_MODELS.BANK, SECTOR_MODELS.NBFC]) {
    const weights = componentWeightsFor(spec, model);
    assert.deepEqual(Object.keys(weights).sort(), ["balance_sheet", "cash_flow", "future_growth", "growth", "profitability", "promoter_governance"]);
  }
});
