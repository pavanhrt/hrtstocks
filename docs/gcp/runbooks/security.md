# Runbook: security

## 1. Historical Supabase key (owner-accepted risk)

A service-role key for the historical Supabase project (`miruhnvfkmwffuchqiku`) was committed to this repository's history in the past. The owner has **accepted that risk**:
there is no rotation work, key recovery or git-history rewrite in scope. The rules that follow from that decision:

- Nothing in this repository connects to that project, and **no key, password or project reference for it is needed** to build, test or deploy. No script reads one.
- The key is never displayed, copied, validated or reused by anyone working on this repository, and it must never be used for anything new.
- The tracked `.env.local` was removed from the index and `.gitignore` ignores `.env` and `.env.*` (except `*.example`); CI runs a gitleaks scan on every change so no new secret can be added unnoticed.
- The historical project is provenance only ([../schema-provenance.md](../schema-provenance.md)).

## 2. Secrets policy

| Secret | Where it lives | Never |
|---|---|---|
| `FYERS_ACCESS_TOKEN`, `FYERS_APP_ID` | Secret Manager (deployed); ignored env file (local) | in Git, logs, chat, Terraform state |
| `postgres` password (operator, for migrations) | typed by the operator; set with `gcloud sql users set-password`; **never in Terraform, state or the repository** | in shell history, files |
| Runtime DB access | IAM authentication (no password) | |
| Cloud credentials | Application Default Credentials locally; Workload Identity Federation in CI | service-account key files, OAuth tokens in the repo |

Terraform never writes a secret value, so its state holds no credential. Keep the state bucket private anyway (it lists every resource).

## 3. Scanning for leaked secrets (without printing them)

```bash
# Filenames and secret TYPES only; never print the matching text.
git ls-files -z | xargs -0 grep -lIE 'sb_secret_[A-Za-z0-9_-]{20,}'                      # Supabase secret key
git ls-files -z | xargs -0 grep -lIE 'eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.'    # JWT (service-role / anon keys)
git ls-files -z | xargs -0 grep -lIE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----'              # private keys
git ls-files -z | xargs -0 grep -lIE 'AIza[0-9A-Za-z_-]{35}'                              # Google API key
git ls-files --error-unmatch .env.local 2>/dev/null && echo "TRACKED (bad)" || echo ".env.local not tracked"
```

## 4. Runtime exposure

- The Cloud SQL instance has a public IPv4 address with **no authorized networks** and TLS required; the only path in is the IAM-authorized connector (and the operator's Cloud SQL Auth Proxy). A private-IP design is the next hardening step.
- The public entry point is Firebase Hosting → Cloud Run. Every page and API is authenticated in the application (invite-only). Chart objects are served only to signed-in users and only for registered paths; the bucket is private with public access prevention.
- State-changing requests are accepted only from exact configured origins (`APP_BASE_URL`, `ALLOWED_ORIGINS`); there is no wildcard CORS.
- The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax` and **host-only** (no `Domain`); Hosting forwards only this cookie. Dynamic responses are `Cache-Control: private, no-store`.
- The FYERS redirect page (`/fyers/callback`) is public, ignores its query string and sends `Referrer-Policy: no-referrer`, so the one-time code is never stored or leaked.
- SVG charts are validated before upload (type, size, no script/event/external references) and stored under content-addressed names; overwrites are refused.
- IAM is described in [../iam-proposal.md](../iam-proposal.md) and is **not applied**.
