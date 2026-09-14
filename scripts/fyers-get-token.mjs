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
//      -> prints that day's access token. Store it as FYERS_ACCESS_TOKEN in
//      the Supabase run-screening Edge Function secrets, then trigger a run.
//
// Endpoints per Fyers API v3 (api-t1.fyers.in) -- see
// https://myapi.fyers.in/dashboard for app management.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseAuthCode(arg) {
  if (!arg) return "";

  if (arg.includes("auth_code=")) {
    try {
      return new URL(arg).searchParams.get("auth_code")?.trim() ?? "";
    } catch {
      return "";
    }
  }

  // A common copy/paste mistake is passing "<code>&state=...". That is not
  // a bare auth code, and sending it to Fyers produces error -437.
  if (arg.includes("&") || arg.includes("?")) return "";
  return arg.trim();
}

async function main() {
  const appId = process.env.FYERS_APP_ID;
  const secretKey = process.env.FYERS_SECRET_KEY;
  const redirectUri =
    process.env.FYERS_REDIRECT_URI ?? "https://hrtstocksdev.netlify.app/auth/callback";

  if (!appId || !secretKey) {
    console.error("Set FYERS_APP_ID and FYERS_SECRET_KEY in the environment first.");
    return 1;
  }

  const arg = process.argv[2];

  if (!arg) {
    const state = Math.random().toString(36).slice(2);
    const url = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);

    console.log("Open this URL, log into Fyers, and approve access:\n");
    console.log(url.toString());
    console.log(
      "\nThen re-run this script with the full redirected URL (recommended), or only the auth_code value."
    );
    return 0;
  }

  const authCode = parseAuthCode(arg);
  if (!authCode) {
    console.error(
      "Could not read a valid auth code. Pass the complete redirected URL, or only the auth_code value without '&state=...'."
    );
    return 1;
  }

// Per the official SDK source (fyers_apiv3/fyersModel.py, SessionModel.get_hash):
// hashlib.sha256(f"{client_id}:{secret_key}".encode()) -- colon separator, confirmed
// against source rather than community examples (one of which had this wrong).
  const appIdHash = createHash("sha256").update(`${appId}:${secretKey}`).digest("hex");

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
    return 1;
  }

  console.log("\nAccess token (valid until end of trading day):\n");
  console.log(body.access_token);
  console.log(
    "\nStore this as FYERS_ACCESS_TOKEN in the Supabase run-screening Edge Function secrets, then trigger a fresh run."
  );
  return 0;
}

// Setting exitCode lets Node close its fetch handles normally on Windows and
// avoids the libuv assertion caused by terminating the process abruptly.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
