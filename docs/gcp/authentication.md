# Authentication

Identity Platform (Firebase Authentication) with e-mail + password. The browser never holds an authorization decision:
the server verifies identity and reads the user's role from its own database on every request.

## Flow

1. The login form signs in with the Firebase web SDK and obtains an ID token.
2. It POSTs the token to `POST /api/auth/session` (exact allowed origin only). The server:
   - verifies the token with the Admin SDK (signature, audience, expiry, **revocation**),
   - requires a *fresh* sign-in (`auth_time` within 5 minutes) so a leaked older token cannot mint a session,
   - resolves the person to an authorized profile ([`app/src/lib/auth-profile.ts`](../../app/src/lib/auth-profile.ts)),
   - creates an `httpOnly`, `Secure`, `SameSite=Lax`, **host-only** (no `Domain`) **session cookie** named `__session` (default 5 days, max 14). The name matters: Firebase Hosting forwards only this cookie to Cloud Run.
3. The browser drops its Firebase state; only the opaque cookie remains.
4. Every page, API route and repository calls `getCurrentUser()` ([`app/src/lib/auth.ts`](../../app/src/lib/auth.ts)), which verifies the cookie again and loads `{id, email, role}` from
   `profiles`. Role changes therefore take effect immediately. `middleware.ts` is only an optimistic redirect for visitors with no cookie
   (it cannot verify a session on the Edge runtime); a forged cookie passes it but fails everywhere that matters.

Password reset uses Firebase's hosted reset page (the previous custom `/auth/callback` code exchange no longer exists).

The QA host name is an authorized Identity Platform domain (`authorized_domains` in `identity.tf`, together with the Firebase-generated hostnames), and the browser API key is restricted to those origins.

## Invite-only (default)

A person can sign in only if an administrator created their profile, or their e-mail is in `bootstrap_admin_emails`.
Two independent layers enforce this:

- **Provider:** Terraform sets `disabled_user_signup = true`, so strangers cannot create accounts at all.
- **Application:** even a valid account with no profile is refused (`403 not_authorized`, deliberately generic).

Linking a profile to an account by e-mail requires the account's e-mail to be **verified**, an already-linked profile can never be taken over by
a second account, and concurrent first sign-ins cannot create duplicates (unique indexes on `auth_uid` and `lower(email)`).

Invite someone (never sends e-mail): see [runbooks/user-management.md](runbooks/user-management.md).

## Enabling open self-signup later

It is a configuration change, but **do not enable it until** e-mail verification enforcement, abuse controls (rate limiting / CAPTCHA / blocking functions),
authorization tests for the new population, and cost controls are ready. The switches, all three must agree:

| Layer | Setting |
|---|---|
| Server | `SIGNUP_MODE=open` (Terraform `signup_mode = "open"`) |
| Build (shows the "Create account" tab) | `NEXT_PUBLIC_SIGNUP_MODE=open` (Docker build arg) |
| Provider | Terraform sets `disabled_user_signup = (signup_mode != "open")` |

New open-signup accounts get the `viewer` role only, and only after their e-mail is verified.

## Users on a fresh deployment

**No account, password, session, profile or role is migrated from any earlier system.** The deployment starts with no users. Access is created only by invitation:

1. The owner supplies an administrator e-mail address. Until then no user exists and none is created or invited (`bootstrap_admin_email` is `null` in Terraform, and `BOOTSTRAP_ADMIN_EMAIL` is unset for the seed). The address is never assumed to be the operator's.
2. `BOOTSTRAP_ADMIN_EMAIL=<address> npm run seed:system` authorizes that address (row in `bootstrap_admin_emails`; no account is created).
3. `node app/scripts/invite-user.ts --email <address> --role system_admin --reset-link` creates the Identity Platform account and prints a one-time link, which the operator delivers privately. No e-mail is sent by the tooling.
4. The person sets a password, signs in and verifies their e-mail; the account is linked to a `system_admin` profile. They then invite everyone else ([runbooks/user-management.md](runbooks/user-management.md)).

Public sign-up stays disabled at the provider and in the application (`signup_mode = "invite_only"`).

## Local development

Use the Firebase Auth emulator: `npx firebase-tools emulators:start --only auth` (`firebase.json`), with the `app/.env.example` settings.
