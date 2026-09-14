import assert from "node:assert/strict";
import test from "node:test";

import { parseAuthCode } from "./fyers-get-token.mjs";

test("extracts auth_code from the full redirect URL", () => {
  assert.equal(
    parseAuthCode("https://example.test/callback?s=ok&auth_code=fresh-code&state=random"),
    "fresh-code"
  );
});

test("accepts a bare auth code", () => {
  assert.equal(parseAuthCode("fresh-code"), "fresh-code");
});

test("rejects a code copied together with state", () => {
  assert.equal(parseAuthCode("fresh-code&state=random"), "");
});

test("rejects a malformed redirect URL", () => {
  assert.equal(parseAuthCode("not a URL?auth_code=fresh-code"), "");
});
