import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_BUCKET_ID, MAX_CHART_BYTES, createChartStore, validateChartUpload } from "./charts.js";

function fakeDb() {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return []; } };
}

function fakeBucket(behavior) {
  const saved = [];
  return {
    saved,
    file: (name) => ({
      async save(data, opts) {
        saved.push({ name, data, opts });
        if (behavior) await behavior(name);
      },
    }),
  };
}

test("uploads with an immutability precondition, then registers the object", async () => {
  const db = fakeDb();
  const bucket = fakeBucket();
  await createChartStore(db, bucket).putSvg("NSE_TCS/daily/abc.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  assert.equal(bucket.saved[0].opts.preconditionOpts.ifGenerationMatch, 0);
  assert.equal(bucket.saved[0].opts.contentType, "image/svg+xml");
  assert.match(db.calls[0].sql, /insert into stored_objects/);
  assert.deepEqual(db.calls[0].params, [CHART_BUCKET_ID, "NSE_TCS/daily/abc.svg", Buffer.byteLength('<svg xmlns="http://www.w3.org/2000/svg"/>')]);
});

test("an already-existing identical object is success and is still registered", async () => {
  const db = fakeDb();
  const bucket = fakeBucket(async () => { throw Object.assign(new Error("conditionNotMet"), { code: 412 }); });
  await createChartStore(db, bucket).putSvg("p.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  assert.equal(db.calls.length, 1);
});

test("a real storage failure is not swallowed and nothing is registered", async () => {
  const db = fakeDb();
  const bucket = fakeBucket(async () => { throw Object.assign(new Error("backend error"), { code: 503 }); });
  await assert.rejects(createChartStore(db, bucket).putSvg("p.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), /backend error/);
  assert.equal(db.calls.length, 0);
});

test("the store validates type, size and content BEFORE any write", async () => {
  const db = fakeDb();
  const bucket = fakeBucket();
  const store = createChartStore(db, bucket);
  const bad = [
    ["NSE_TCS/daily/abc.png", "<svg/>"],
    ["../etc/passwd.svg", "<svg/>"],
    ["NSE_TCS/daily/abc.svg", "<html><body>not svg</body></html>"],
    ["NSE_TCS/daily/abc.svg", "<svg><script>alert(1)</script></svg>"],
    ["NSE_TCS/daily/abc.svg", "<svg onload=\"x()\"/>"],
    ["NSE_TCS/daily/abc.svg", "<svg><a href=\"https://evil.example/x\"/></svg>"],
    ["NSE_TCS/daily/abc.svg", "<svg><foreignObject/></svg>"],
    ["NSE_TCS/daily/abc.svg", ""],
    ["NSE_TCS/daily/abc.svg", "<svg>" + "x".repeat(MAX_CHART_BYTES) + "</svg>"],
  ];
  for (const [path, svg] of bad) await assert.rejects(store.putSvg(path, svg), /unsafe object path|not an SVG|disallowed|outside the allowed range|SVG string/, path);
  assert.equal(bucket.saved.length, 0, "nothing was written");
  assert.equal(db.calls.length, 0, "nothing was registered");
});

test("legitimate paths (including NSE symbols with & and -) and real chart shapes are accepted", () => {
  for (const path of ["NSE_TCS/daily/abc.svg", "NSE_M&M/weekly/0f.svg", "NSE_BAJAJ-AUTO/fome-15m/aa.svg", "nifty-50/daily/bb.svg"]) {
    assert.doesNotThrow(() => validateChartUpload(path, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>text{fill:#333}</style><text>ok</text></svg>'), path);
  }
});
