# Runbook: users (invite-only)

Access is by invitation. Nobody can create their own account (provider sign-up is disabled) and even a valid account without a profile is refused.
See [authentication.md](../authentication.md).

## Invite someone

Needs database access (through the Cloud SQL Auth Proxy) and Firebase Admin access (your Application Default Credentials, or the emulator locally).

```bash
cd app
DATABASE_URL=... NEXT_PUBLIC_FIREBASE_PROJECT_ID=<project id> \
  node scripts/invite-user.ts --email person@example.com --role researcher --reset-link
```

- Creates (or updates the role of) the profile and the identity account. **It never sends e-mail.**
- `--reset-link` prints a one-time link for **you** to deliver privately (it is a credential: treat it like a password). Without it, the person can use **Forgot password?** on the login page.
- On their first verified sign-in the account is linked to the profile. Roles: `viewer`, `researcher`, `strategy_admin`, `system_admin`.

## Change a role

Re-run the invite command with the new `--role` (idempotent), or `update profiles set role = '...' where lower(email) = '...'`. Takes effect on the next request (the role is read from the database each time).

## Remove access

1. `delete from profiles where lower(email) = '...'` (or set role `viewer`), which blocks sign-in immediately.
2. Disable the identity account in Identity Platform, and revoke sessions: `admin.auth().revokeRefreshTokens(uid)` (session cookies are checked for revocation).

## First administrator

A fresh deployment has **no users and no administrator**, and none is created or invited until an administrator address is supplied by the owner. Then:

1. `BOOTSTRAP_ADMIN_EMAIL=<address> npm run seed:system` authorizes that address (an e-mail in `bootstrap_admin_emails` becomes `system_admin` on its first verified sign-in). It creates no account.
2. `cd app && node scripts/invite-user.ts --email <address> --role system_admin --reset-link` creates the Identity Platform account and prints a one-time link for you to deliver.

The address is never assumed to be the operator's own. Full procedure: [qa-deployment.md](qa-deployment.md) §6.
