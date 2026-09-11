import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same non-secret fallback pattern as src/lib/env.ts (NEXT_PUBLIC_* values
// ship in the client bundle regardless of how they're supplied, so a
// hardcoded fallback here is not a new exposure) -- duplicated rather than
// imported since this file runs before Next's own module resolution for
// src/ is set up.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://yqxpucjtzrmwjniruebt.supabase.co";
const SUPABASE_WS_URL = SUPABASE_URL.replace(/^https:/, "wss:");

// The app is entirely self-contained: no external fonts/scripts/CDN, no
// OAuth redirect (email/password auth only), inline `style={{}}` used
// throughout (hence 'unsafe-inline' on style-src -- tightening that further
// would need converting every inline style to CSS classes first, out of
// scope here), and direction-chart images are Supabase Storage signed URLs
// on the same project origin.
//
// script-src also needs 'unsafe-inline': verified live in the Browser pane
// that a plain `script-src 'self'` blocks Next.js's own inline RSC-hydration
// bootstrap scripts entirely (every navigation, every console full of CSP
// violation errors, the app non-functional client-side despite the initial
// server-rendered HTML looking fine). A nonce-per-request CSP would avoid
// this while still blocking injected inline scripts, but that needs
// middleware.ts to generate and thread a nonce through every response --
// a real, larger change, not a "headers" default. Disclosed trade-off, not
// a silent downgrade: this CSP still blocks external script/connect
// exfiltration to any domain outside the Supabase project's own origin,
// framing (frame-ancestors), and MIME-sniffing -- it does not defend against
// inline-script-based XSS specifically.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${SUPABASE_URL}`,
  `connect-src 'self' ${SUPABASE_URL} ${SUPABASE_WS_URL}`,
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app has its own package-lock.json, but stock-platform/package.json
  // (the seed/rule-engine tooling one level up) also has one -- pin the
  // tracing root here so Next doesn't guess between them.
  outputFileTracingRoot: __dirname,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
