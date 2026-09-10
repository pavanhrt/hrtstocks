/**
 * Validates a post-login/auth `next` destination as a safe, same-origin
 * internal path before it's ever passed to redirect()/NextResponse.redirect().
 *
 * Both `app/login/actions.ts` and `app/auth/callback/route.ts` previously
 * redirected to whatever `next` value arrived from a form field or query
 * string with no validation -- an open redirect (a signed-in victim could be
 * sent to `//evil.com` or `https://evil.com` straight off this app's own
 * login/auth flow). Only a path that starts with exactly one `/` and does not
 * start with `//` (protocol-relative) is accepted; anything else falls back
 * to `fallback`.
 */
export function safeRedirectPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback; // rejects absolute URLs like https://evil.com
  if (next.startsWith("//")) return fallback; // rejects protocol-relative URLs like //evil.com
  if (next.includes("\\")) return fallback; // some browsers treat backslash like forward slash
  return next;
}
