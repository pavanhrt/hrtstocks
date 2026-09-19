import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpstoxClient, UpstoxApiError } from "./upstox-client.js";

const VALID_ISIN = "INE002A01018";

function fakeFetch(responses, capturedUrls = []) {
  let call = 0;
  return async (url) => {
    capturedUrls.push(url);
    const response = responses[call++];
    if (!response) throw new Error(`fakeFetch: no recorded response for call ${call} (${url})`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

test("createUpstoxClient: throws without an access token rather than making an unauthenticated call", () => {
  assert.throws(() => createUpstoxClient(""));
  assert.throws(() => createUpstoxClient(null));
});

test("getCashFlow: requests only type/fs, never the undocumented time_period param (correction 2026-09-16 -- official docs list only type and fs for this endpoint)", async () => {
  const urls = [];
  const fetchImpl = fakeFetch([{ status: 200, body: { status: "success", data: {} } }], urls);
  const client = createUpstoxClient("test-token", fetchImpl);
  await client.getCashFlow(VALID_ISIN);
  assert.ok(urls[0].includes("type=consolidated"));
  assert.ok(urls[0].includes("fs=true"));
  assert.ok(!urls[0].includes("time_period"), "cash-flow must never send the undocumented time_period param");
});

test("getBalanceSheet: a successful response returns the .data payload", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { status: "success", data: { history: [] } } }]);
  const client = createUpstoxClient("test-token", fetchImpl);
  const data = await client.getBalanceSheet(VALID_ISIN);
  assert.deepEqual(data, { history: [] });
});

test("invalid ISIN: refused before any network call is made, never fuzzy-matched by name", async () => {
  const fetchImpl = fakeFetch([]); // would throw if called -- proves no request is made
  const client = createUpstoxClient("test-token", fetchImpl);
  await assert.rejects(() => client.getBalanceSheet("NOT-AN-ISIN"), UpstoxApiError);
  await assert.rejects(() => client.getBalanceSheet(""), UpstoxApiError);
});

test("rate limiting: a 429 response is classified retryable", async () => {
  const fetchImpl = fakeFetch([{ status: 429, body: { status: "error", errors: [{ message: "rate limit exceeded" }] } }]);
  const client = createUpstoxClient("test-token", fetchImpl);
  try {
    await client.getKeyRatios(VALID_ISIN);
    assert.fail("expected UpstoxApiError");
  } catch (err) {
    assert.ok(err instanceof UpstoxApiError);
    assert.equal(err.retryable, true);
    assert.equal(err.status, 429);
  }
});

test("authentication error: a 401/403 response is classified NOT retryable -- must never be blindly retried", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = fakeFetch([{ status, body: { status: "error" } }]);
    const client = createUpstoxClient("test-token", fetchImpl);
    try {
      await client.getProfile(VALID_ISIN);
      assert.fail("expected UpstoxApiError");
    } catch (err) {
      assert.equal(err.retryable, false, `status ${status} must not be retryable`);
    }
  }
});

test("invalid request (4xx, e.g. an ISIN Upstox itself doesn't recognize): NOT retryable", async () => {
  const fetchImpl = fakeFetch([{ status: 404, body: { status: "error" } }]);
  const client = createUpstoxClient("test-token", fetchImpl);
  try {
    await client.getProfile(VALID_ISIN);
    assert.fail("expected UpstoxApiError");
  } catch (err) {
    assert.equal(err.retryable, false);
  }
});

test("server error (5xx): classified retryable", async () => {
  const fetchImpl = fakeFetch([{ status: 503, body: { status: "error" } }]);
  const client = createUpstoxClient("test-token", fetchImpl);
  try {
    await client.getProfile(VALID_ISIN);
    assert.fail("expected UpstoxApiError");
  } catch (err) {
    assert.equal(err.retryable, true);
  }
});

test("thrown errors never include the access token in message or fields", async () => {
  const fetchImpl = fakeFetch([{ status: 401, body: { status: "error" } }]);
  const client = createUpstoxClient("super-secret-token-value", fetchImpl);
  try {
    await client.getProfile(VALID_ISIN);
    assert.fail("expected UpstoxApiError");
  } catch (err) {
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    assert.ok(!serialized.includes("super-secret-token-value"), "the access token must never leak into a thrown error");
  }
});
