import { test } from "node:test";
import assert from "node:assert/strict";
import { safeRedirectPath } from "./safe-redirect.ts";

test("safeRedirectPath accepts a plain internal path", () => {
  assert.equal(safeRedirectPath("/direction"), "/direction");
  assert.equal(safeRedirectPath("/stocks/NSE_TCS"), "/stocks/NSE_TCS");
});

test("safeRedirectPath falls back to /dashboard for absolute URLs (open-redirect attempt)", () => {
  assert.equal(safeRedirectPath("https://evil.com"), "/dashboard");
  assert.equal(safeRedirectPath("http://evil.com/phish"), "/dashboard");
});

test("safeRedirectPath falls back to /dashboard for protocol-relative URLs", () => {
  assert.equal(safeRedirectPath("//evil.com"), "/dashboard");
  assert.equal(safeRedirectPath("///evil.com"), "/dashboard");
});

test("safeRedirectPath falls back to /dashboard for a backslash-based bypass attempt", () => {
  assert.equal(safeRedirectPath("/\\evil.com"), "/dashboard");
});

test("safeRedirectPath falls back to /dashboard for missing/empty input", () => {
  assert.equal(safeRedirectPath(null), "/dashboard");
  assert.equal(safeRedirectPath(undefined), "/dashboard");
  assert.equal(safeRedirectPath(""), "/dashboard");
});

test("safeRedirectPath falls back to /dashboard for a relative path with no leading slash", () => {
  assert.equal(safeRedirectPath("evil.com"), "/dashboard");
});

test("safeRedirectPath honors a custom fallback", () => {
  assert.equal(safeRedirectPath("https://evil.com", "/login"), "/login");
});
