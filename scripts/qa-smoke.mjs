// Black-box smoke test for a running deployment: local build, Firebase-generated URL or the QA custom domain.
//
//   node scripts/qa-smoke.mjs --base-url https://hrtstocksqa.example.com [--expect-migrations 21] [--check-http]
//
// It needs no credentials and changes nothing: it only makes read requests and requests that MUST be refused.
// It proves the edge/server behavior that does not require a signed-in user; checks that need a real signed-in user
// (session cookie attributes after login, viewer/staff pages, first upload/download) are listed in
// docs/gcp/qa-deployment.md and are performed by hand in QA.
import { fileURLToPath } from "node:url";

// A JWT-shaped cookie claiming an admin. It passes the edge (cookie present) but must fail server-side verification.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FORGED = `${b64({ alg: "none" })}.${b64({ uid: "attacker", role: "system_admin" })}.`;

export async function runSmoke({ baseUrl, expectMigrations = null, checkHttp = false, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const results = [];
  const add = (name, pass, detail = "") => results.push({ name, pass: Boolean(pass), detail });
  const req = (path, opts = {}) => fetchImpl(new URL(path, origin), { redirect: "manual", ...opts });
  const cookie = { Cookie: `__session=${FORGED}` };

  // --- liveness / readiness ---
  let r = await req("/api/health");
  add("liveness /api/health -> 200 ok", r.status === 200 && (await r.json()).ok === true, `status ${r.status}`);
  r = await req("/api/health/ready");
  const ready = r.status === 200 ? await r.json() : {};
  add("readiness /api/health/ready -> database reachable", r.status === 200 && ready.ok === true, `status ${r.status}`);
  if (expectMigrations != null) add(`schema has all ${expectMigrations} migrations applied`, ready.migrationsApplied === expectMigrations, `applied=${ready.migrationsApplied}`);

  // --- login page: invite-only UI + security headers ---
  r = await req("/login");
  const html = await r.text();
  add("login page renders (200)", r.status === 200 && html.includes("Access is by invitation"), `status ${r.status}`);
  add("login page offers no public sign-up", !html.includes("Create account"));
  const h = (name) => r.headers.get(name) ?? "";
  add("HSTS header present", /max-age=\d{7,}/.test(h("strict-transport-security")));
  add("CSP present and has no 'unsafe-eval'", h("content-security-policy").includes("default-src 'self'") && !h("content-security-policy").includes("unsafe-eval"));
  add("clickjacking + sniffing protections", h("x-frame-options").toUpperCase() === "DENY" && h("x-content-type-options") === "nosniff");
  add("dynamic pages are not cacheable by shared caches", /no-store/.test(h("cache-control")) && /private/.test(h("cache-control")), h("cache-control"));

  // --- authentication is enforced ---
  r = await req("/dashboard");
  add("no session: protected page redirects to /login", [301, 302, 303, 307, 308].includes(r.status) && (r.headers.get("location") ?? "").includes("/login"), `status ${r.status}`);
  for (const path of ["/api/charts/NSE_X/daily/abc.svg", "/api/export/stocks?runId=11111111-1111-1111-1111-111111111111", "/api/instruments/search?q=a"]) {
    r = await req(path);
    add(`no session: ${path.split("?")[0]} -> 401`, r.status === 401, `status ${r.status}`);
    r = await req(path, { headers: cookie });
    add(`FORGED cookie: ${path.split("?")[0]} -> 401`, r.status === 401, `status ${r.status}`);
  }
  r = await req("/dashboard", { headers: cookie });
  add("FORGED cookie: protected page redirects to /login", [301, 302, 303, 307, 308].includes(r.status) && (r.headers.get("location") ?? "").includes("/login"), `status ${r.status}`);
  r = await req("/api/screening-runs", { method: "POST", headers: { ...cookie, Origin: origin } });
  add("FORGED cookie: start-screening POST -> 401", r.status === 401, `status ${r.status}`);
  r = await req("/api/screening-runs", { method: "POST", headers: { ...cookie, Origin: "https://evil.example" } });
  add("cross-origin POST -> 403 (CSRF)", r.status === 403, `status ${r.status}`);
  r = await req("/api/screening-runs", { method: "POST", headers: cookie });
  add("POST without Origin -> 403 (CSRF)", r.status === 403, `status ${r.status}`);
  r = await req("/api/auth/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "x".repeat(40) }) });
  add("session endpoint rejects a garbage token -> 401", r.status === 401, `status ${r.status}`);

  // --- removed features are gone (a forged cookie passes the edge check, so this shows real routing) ---
  for (const path of ["/buy-signals", "/sell-signals", "/backtests"]) {
    r = await req(path, { headers: cookie });
    add(`removed page ${path} -> 404`, r.status === 404, `status ${r.status}`);
  }

  // --- FYERS redirect landing page never reflects the authorization code ---
  r = await req("/fyers/callback?auth_code=SMOKE_MARKER_123");
  const cb = await r.text();
  add("FYERS callback page is public and does not echo the code", r.status === 200 && !cb.includes("SMOKE_MARKER_123"), `status ${r.status}`);
  add("FYERS callback sends Referrer-Policy: no-referrer", r.headers.get("referrer-policy") === "no-referrer");

  // --- HTTP -> HTTPS (only meaningful on a real domain) ---
  if (checkHttp) {
    r = await fetchImpl(`http://${base.host}/login`, { redirect: "manual" });
    add("HTTP redirects to HTTPS", [301, 308].includes(r.status) && (r.headers.get("location") ?? "").startsWith("https://"), `status ${r.status}`);
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const baseUrl = arg("base-url");
  if (!baseUrl) {
    console.error("Usage: node scripts/qa-smoke.mjs --base-url <https://host> [--expect-migrations N] [--check-http]");
    process.exit(2);
  }
  const results = await runSmoke({ baseUrl, expectMigrations: arg("expect-migrations") ? Number(arg("expect-migrations")) : null, checkHttp: process.argv.includes("--check-http") });
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass || !r.detail ? "" : `  (${r.detail})`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? `\nSMOKE PASSED (${results.length} checks)` : `\nSMOKE FAILED (${failed} of ${results.length})`);
  process.exitCode = failed === 0 ? 0 : 1;
}
