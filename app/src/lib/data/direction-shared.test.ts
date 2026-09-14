import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDirectionAlignment } from "./direction-shared.ts";

test("unavailable ledger rows remain visible as unavailable when alignment evidence is absent", () => {
  assert.equal(resolveDirectionAlignment({ persisted: null, terminalState: "NO_DATA", tier: "unavailable", dataQuality: "NO_DATA" }), "UNAVAILABLE");
});

test("missing alignment never becomes a directional pass", () => {
  assert.equal(resolveDirectionAlignment({ persisted: null, terminalState: "WATCH", tier: "watch", dataQuality: "PASS" }), "MANUAL_REVIEW");
  assert.equal(resolveDirectionAlignment({ persisted: "ALIGNED_BULLISH", terminalState: "WATCH", tier: "watch", dataQuality: "PASS" }), "ALIGNED_BULLISH");
});
