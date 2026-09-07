// Manual daily token refresh for the Fyers data provider (chosen over fully
// automated TOTP login: no trading PIN/2FA secret needs to be stored
// anywhere, at the cost of running this once per trading day yourself).
//
// Fyers access tokens expire daily (SEBI requirement, same as every Indian
// broker API) -- there is no way around a daily refresh with this app type.
//
// Usage:
//   1. FYERS_APP_ID=... FYERS_SECRET_KEY=... FYERS_REDIRECT_URI=... node scripts/fyers-get-token.mjs
//      -> prints a login URL. Open it, log into Fyers, approve access.
//   2. You'll land on your redirect URI with ?auth_code=...&state=... in the
//      URL (the page itself will likely 404 -- that's fine, we only need the
//      URL bar). Copy the full URL (or just the auth_code value).
//   3. FYERS_APP_ID=... FYERS_SECRET_KEY=... node scripts/fyers-get-token.mjs "<paste auth_code or full redirect URL>"
//      -> prints that day's access token. Paste it into Netlify as
//      FYERS_ACCESS_TOKEN and redeploy, or wherever else it's consumed.
//
// Endpoints per Fyers API v3 (api-t1.fyers.in) -- see
// https://myapi.fyers.in/dashboard for app management.

import { createHash } from "node:crypto";

const APP_ID = process.env.FYERS_APP_ID;
const SECRET_KEY = process.env.FYERS_SECRET_KEY;
const REDIRECT_URI = process.env.FYERS_REDIRECT_URI ?? "https://hrtstocksdev.netlify.app/auth/callback";

if (!APP_ID || !SECRET_KEY) {
  console.error("Set FYERS_APP_ID and FYERS_SECRET_KEY in the environment first.");
  process.exit(1);
}

const arg = process.argv[2];

if (!arg) {
  const state = Math.random().toString(36).slice(2);
  const url = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
  url.searchParams.set("client_id", APP_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  console.log("Open this URL, log into Fyers, and approve access:\n");
  console.log(url.toString());
  console.log(
    "\nThen re-run this script with the auth_code (or the full URL you land on) as the argument."
  );
  process.exit(0);
}

// Accept either a bare code or the full redirected URL.
let authCode = arg;
if (arg.includes("auth_code=")) {
  authCode = new URL(arg).searchParams.get("auth_code") ?? "";
}
if (!authCode) {
  console.error("Could not find an auth_code in the given argument.");
  process.exit(1);
}

// Per the official SDK source (fyers_apiv3/fyersModel.py, SessionModel.get_hash):
// hashlib.sha256(f"{client_id}:{secret_key}".encode()) -- colon separator, confirmed
// against source rather than community examples (one of which had this wrong).
const appIdHash = createHash("sha256").update(`${APP_ID}:${SECRET_KEY}`).digest("hex");

const res = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "authorization_code",
    appIdHash,
    code: authCode,
  }),
});

const body = await res.json();

if (!res.ok || body.s !== "ok") {
  console.error("Token exchange failed:", JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log("\nAccess token (valid until end of trading day):\n");
console.log(body.access_token);
console.log("\nPaste this into Netlify as FYERS_ACCESS_TOKEN, then redeploy or re-trigger the run.");
