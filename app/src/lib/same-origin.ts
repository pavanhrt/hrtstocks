/**
 * CSRF defense in depth for state-changing routes (session cookies are also SameSite=Lax).
 * Browsers always send an Origin header on cross-site POSTs.
 *
 * With `allowedOrigins` (production): the Origin must EXACTLY equal one of the configured origins
 * (scheme + host + port). No wildcards, no subdomain matching, and the Host header is not consulted, so a
 * request through any other hostname is refused.
 * Without it (local development only): the Origin's host must equal the host the request was addressed to.
 */
export function isSameOrigin(request: Request, allowedOrigins?: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins) return allowedOrigins.includes(parsed.origin);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return !!host && parsed.host === host;
}

/** Normalizes a configured list of origins; rejects anything that is not a plain http(s) origin. */
export function parseOrigins(values: readonly (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const u = new URL(item);
      if (
        !/^https?:$/.test(u.protocol) ||
        u.pathname !== "/" ||
        u.search ||
        u.hash ||
        u.username ||
        u.password ||
        !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(u.hostname) // no wildcards, no odd characters
      ) {
        throw new Error(`Not a plain origin: ${item}`);
      }
      out.add(u.origin);
    }
  }
  return [...out];
}
