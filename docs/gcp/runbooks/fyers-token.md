# Runbook: FYERS access token (manual daily rotation)

FYERS access tokens expire **every trading day** (a broker/SEBI requirement). Per project decision, refresh stays **manual**.
Automating FYERS login (a stored trading PIN and TOTP secret) is a much larger credential surface and has **not** been done; it needs a separate review of the
officially supported FYERS flow and its security implications before anyone builds it.

## Where the token lives

| Environment | Location |
|---|---|
| Deployed | Secret Manager secret `<prefix>-fyers-access-token`, mounted into the pipeline jobs as `FYERS_ACCESS_TOKEN` |
| Local development | `services/pipeline/.env.local` (git-ignored) |

`FYERS_APP_ID` is stored the same way (`<prefix>-fyers-app-id`). Never commit either; never paste the token into chat, tickets, or logs.

## Rotation procedure (each trading day, before the run)

```bash
# 1. Get a login URL (prints a URL; open it, sign in to FYERS, approve).
FYERS_APP_ID=... FYERS_SECRET_KEY=... FYERS_REDIRECT_URI=<as registered on the FYERS app> node scripts/fyers-get-token.mjs

# 2. Paste the auth_code (or the full redirect URL) to get today's token. It is printed once.
FYERS_APP_ID=... FYERS_SECRET_KEY=... FYERS_REDIRECT_URI=... node scripts/fyers-get-token.mjs "<auth_code or redirect URL>"

# 3. Store it as a NEW secret version (never a file, never the command history).
printf %s "$TOKEN" | gcloud secrets versions add <prefix>-fyers-access-token --data-file=-
unset TOKEN

# 4. (optional) disable yesterday's version
gcloud secrets versions list <prefix>-fyers-access-token
gcloud secrets versions disable <old-version> --secret=<prefix>-fyers-access-token
```

Jobs read `latest` when an execution **starts**, so the next execution uses the new token; nothing needs redeploying.
### Redirect URI

The FYERS app's redirect URI must match exactly. For QA it is:

```
https://hrtstocksqa.manaoorugpt.com/fyers/callback
```

The owner sets this on the FYERS side; **this repository does not modify the external FYERS app**. The route is public, reads nothing from the query string and sends
`Referrer-Policy: no-referrer`; you copy the `auth_code` from the address bar into the script yourself (step 2). The previous `/auth/callback` route was part of the removed
hosted-auth flow and no longer exists, so a FYERS app still pointing at it must be updated before rotating the token. Before DNS is ready the same page exists on the
Firebase-generated URL, but FYERS will only redirect to the URI registered on the app.

## Credential hygiene (learned from the first QA run)

- Store each value with **no trailing newline**: `printf %s "$VALUE" | gcloud secrets versions add <secret> --data-file=-`. A value pasted through a Windows shell or the clipboard ends with CR/LF.
- The pipeline **trims** leading/trailing whitespace on both `FYERS_APP_ID` and `FYERS_ACCESS_TOKEN` when it reads them, and refuses (naming the variable, never the value) a value that is empty, is the `not-configured` placeholder, or still contains a line break or control character inside it.
- **Credentials can never be persisted or logged.** Every FYERS call goes through one wrapper that turns any client failure into a fixed message (HTTP clients echo the offending header value in their own error text), and a central redactor removes header values, token-shaped strings and the configured credential values from anything written to PostgreSQL (`services/pipeline/src/db/client.js`) or to a log line (`jobs/runner.js`). Tests scan every text/JSON column of every table after a failing run.
- The first failed QA run (505 `NO_DATA`, cause: a trailing CR/LF on the App ID) had stored the header text in `data_quality_results.details`; those rows were redacted in place (audit records kept).

## How an expired token fails (clearly)

- The provider boundary is `services/pipeline/src/run-screening/providers/fyers-credentials.js`.
- A missing token, or a FYERS response showing an invalid/expired token (HTTP 401/403 or an auth error code), raises **`FyersAuthError`** with the message
  "FYERS rejected the access token ... Rotate it following docs/gcp/runbooks/fyers-token.md".
- The job **stops immediately** and exits non-zero (Cloud Run marks the execution failed, the *job failed* alert fires and the error appears in Cloud Logging). It does **not** record thousands
  of per-instrument `NO_DATA` results. The screening run row is marked `failed`; the buy-setup manifest is marked `validation_failed` with the same message; a FOME run shows the message.
- The token value is never included in any message.

After rotating, re-run: **Run screening now** in the app, or `gcloud run jobs execute <prefix>-screening --region asia-south1`.
To resume an interrupted run instead of starting a new one: `--update-env-vars RESUME_RUN_ID=<run uuid>`.

## Adding supported automatic refresh later

All FYERS credential reads go through `fyers-credentials.js` (`readAccessToken`). A future supported refresh mechanism only needs to replace that function; no provider call changes.
Do not build it before the separate security review.
