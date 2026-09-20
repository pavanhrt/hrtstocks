import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotAuthFailure, FyersAuthError, fyersAuthHeader, NOT_CONFIGURED, readAccessToken } from "./fyers-credentials.js";

test("a missing token fails clearly, points at the runbook, and never echoes secrets", () => {
  assert.throws(() => readAccessToken({}), (err) => err instanceof FyersAuthError && /FYERS_ACCESS_TOKEN is not set/.test(err.message) && /runbooks\/fyers-token\.md/.test(err.message));
});

test("a missing app id fails clearly", () => {
  assert.throws(() => fyersAuthHeader({ FYERS_ACCESS_TOKEN: "t" }), /FYERS_APP_ID is not set/);
});

test("the auth header is APP_ID:TOKEN", () => {
  assert.equal(fyersAuthHeader({ FYERS_APP_ID: "APP-100", FYERS_ACCESS_TOKEN: "tok" }), "APP-100:tok");
});

test("an expired/invalid token response stops the run with FyersAuthError (and the message omits the token)", () => {
  for (const [status, body] of [[401, null], [403, { s: "error" }], [200, { s: "error", code: -16, message: "Could not authenticate the user" }], [400, { s: "error", message: "token expired" }]]) {
    assert.throws(() => assertNotAuthFailure(status, body), (err) => err instanceof FyersAuthError && /rotate|Rotate/.test(err.message), `${status} ${JSON.stringify(body)}`);
  }
});

test("ordinary errors (rate limit, bad symbol, server error) are not mistaken for auth failures", () => {
  assert.doesNotThrow(() => assertNotAuthFailure(429, { s: "error", code: 429, message: "rate limit" }));
  assert.doesNotThrow(() => assertNotAuthFailure(422, { s: "error", code: -300, message: "Invalid input" }));
  assert.doesNotThrow(() => assertNotAuthFailure(500, null));
});

test("the deployment placeholder means not configured: it fails like a missing value and is never used as a credential", () => {
  assert.throws(() => readAccessToken({ FYERS_ACCESS_TOKEN: NOT_CONFIGURED }), /FYERS_ACCESS_TOKEN is not set/);
  assert.throws(() => fyersAuthHeader({ FYERS_APP_ID: NOT_CONFIGURED, FYERS_ACCESS_TOKEN: "tok" }), /FYERS_APP_ID is not set/);
});
