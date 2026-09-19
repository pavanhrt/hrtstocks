import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The app is self-contained: no external fonts/scripts/CDN. The only
// cross-origin calls are the browser's email/password sign-in requests to
// Google Identity Toolkit (Firebase Auth / Identity Platform). Chart images are
// served same-origin by the authenticated /api/charts route.
//
// style-src needs 'unsafe-inline' (inline `style={{}}` is used throughout).
// script-src also needs 'unsafe-inline': Next.js's own inline RSC-hydration
// bootstrap scripts are blocked outright by a plain `script-src 'self'`
// (verified in a browser: every navigation floods the console with CSP
// violations and the app is non-functional client-side). A nonce-per-request
// CSP would avoid this, but needs middleware to generate and thread a nonce
// through every response -- a larger change than a headers default.
// Disclosed trade-off: this CSP still blocks external script/connect
// exfiltration outside the origins below, framing, and MIME sniffing; it does
// not defend against inline-script XSS specifically.
const AUTH_ORIGINS = ["https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"];
// Local Firebase Auth emulator (development only; unset in deployed builds).
const authEmulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL;

// Next's development tooling needs eval(); production builds never get it.
const scriptSrc = `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self' ${AUTH_ORIGINS.join(" ")}${authEmulator ? ` ${authEmulator}` : ""}`,
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the Cloud Run container (see Dockerfile).
  output: "standalone",

  // This app has its own package-lock.json, but the repo root package.json
  // (db/seed tooling) also has one -- pin the tracing root so Next does not guess.
  outputFileTracingRoot: __dirname,

  // Keep server-only SDKs out of the bundler; they are loaded from node_modules at runtime.
  serverExternalPackages: ["firebase-admin", "pg", "@google-cloud/cloud-sql-connector", "@google-cloud/storage", "@google-cloud/run"],

  async headers() {
    return [
      {
        // The FYERS authorization redirect carries a one-time code in the URL: never leak it via Referer.
        // Next applies every matching rule and the LAST value wins, so the catch-all below must not set
        // Referrer-Policy for this path (see the negative lookahead on its source).
        source: "/fyers/callback",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        // Everything dynamic is per-user: never cacheable by a CDN or shared cache (Firebase Hosting fronts this
        // service in QA). Static build assets keep Next's own immutable caching.
        source: "/((?!_next/static|_next/image).*)",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        source: "/((?!fyers/callback$).*)",
        headers: [{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }],
      },
    ];
  },
};

export default nextConfig;
