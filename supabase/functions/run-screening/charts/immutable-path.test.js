import { test } from "node:test";
import assert from "node:assert/strict";
import { immutableChartIdentity, isExistingChartObjectError } from "./immutable-path.js";

test("identical chart bytes reuse one immutable path", async () => {
  const a = await immutableChartIdentity("NSE_TCS", "daily", "<svg>same</svg>");
  const b = await immutableChartIdentity("NSE_TCS", "daily", "<svg>same</svg>");
  assert.deepEqual(a, b);
  assert.match(a.objectPath, /^NSE_TCS\/daily\/[a-f0-9]{64}\.svg$/);
});

test("changed chart bytes produce a new object path", async () => {
  const a = await immutableChartIdentity("NSE_TCS", "daily", "<svg>a</svg>");
  const b = await immutableChartIdentity("NSE_TCS", "daily", "<svg>b</svg>");
  assert.notEqual(a.contentHash, b.contentHash);
  assert.notEqual(a.objectPath, b.objectPath);
});

test("only an existing-object conflict is safe immutable reuse", () => {
  assert.equal(isExistingChartObjectError({ statusCode: "409", message: "The resource already exists" }), true);
  assert.equal(isExistingChartObjectError({ message: "Duplicate" }), true);
  assert.equal(isExistingChartObjectError({ statusCode: "500", message: "storage unavailable" }), false);
});
