import { serverConfig } from "./config.ts";
import { isSameOrigin, parseOrigins } from "./same-origin.ts";

/**
 * CSRF check for state-changing routes, driven by configuration:
 *   APP_BASE_URL     the canonical public origin (for QA: the custom domain)
 *   ALLOWED_ORIGINS  extra EXACT origins (e.g. the Firebase-generated URL for pre-DNS testing)
 * In production, missing configuration FAILS CLOSED (every state-changing request is refused).
 */
export function csrfOk(request: Request): boolean {
  const cfg = serverConfig();
  const allowed = parseOrigins([cfg.APP_BASE_URL, cfg.ALLOWED_ORIGINS]);
  if (allowed.length === 0) {
    if (process.env.NODE_ENV === "production") return false;
    return isSameOrigin(request); // local development convenience
  }
  return isSameOrigin(request, allowed);
}
