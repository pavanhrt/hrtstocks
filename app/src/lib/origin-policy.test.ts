import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOrigin, parseOrigins } from "./same-origin.ts";
import { chartUrl, isSafeObjectPath } from "./charts.ts";

const QA = "https://qa.example.com";
const req = (headers: Record<string, string>) => new Request("http://cloud-run.internal/api/x", { method: "POST", headers });

test("with a configured origin list, only EXACT origins pass (no wildcard, no sibling subdomain, no Host trust)", () => {
  const allowed = [QA];
  assert.equal(isSameOrigin(req({ origin: QA, host: "cloud-run.internal" }), allowed), true);
  for (const evil of ["https://evil.example", "https://qa.example.com.evil.example", "https://other.example.com", "http://qa.example.com", "https://qa.example.com:8443", "https://example.com", "null", ""]) {
    assert.equal(isSameOrigin(req({ origin: evil, host: "qa.example.com", "x-forwarded-host": "qa.example.com" }), allowed), false, `origin "${evil}"`);
  }
  assert.equal(isSameOrigin(req({ host: "qa.example.com" }), allowed), false, "no Origin header");
});

test("extra pre-DNS origins are exact too", () => {
  const allowed = parseOrigins([QA, "https://site.web.app, https://site.firebaseapp.com"]);
  assert.deepEqual(allowed, [QA, "https://site.web.app", "https://site.firebaseapp.com"]);
  assert.equal(isSameOrigin(req({ origin: "https://site.web.app" }), allowed), true);
  assert.equal(isSameOrigin(req({ origin: "https://x.web.app" }), allowed), false);
});

test("configuration that is not a plain origin is rejected instead of silently widening access", () => {
  for (const bad of ["*", "https://*.example.com", "https://qa.example.com/path", "https://u:p@qa.example.com", "ftp://qa.example.com", "qa.example.com"]) {
    assert.throws(() => parseOrigins([bad]), /Not a plain origin|Invalid URL/, bad);
  }
  assert.deepEqual(parseOrigins([undefined, ""]), []);
});

test("chart paths for NSE symbols containing & are servable, traversal is still refused", () => {
  assert.equal(isSafeObjectPath("NSE_M&M/daily/abc.svg"), true);
  assert.equal(chartUrl("NSE_M&M/daily/abc.svg"), "/api/charts/NSE_M%26M/daily/abc.svg");
  for (const bad of ["NSE_M&M/../x.svg", "&/x.svg", "a//b.svg", "a/b.svg#frag"]) assert.equal(isSafeObjectPath(bad), false, bad);
});
