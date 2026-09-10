// Public, non-secret config with hardcoded fallbacks.
//
// NEXT_PUBLIC_* values are bundled into the client-side JS bundle by Next.js
// no matter how they're supplied -- anyone can already read them from the
// browser's network tab or source maps, so a fallback here is not a new
// exposure. It exists only so the site works even when the hosting
// platform's environment variables aren't configured.
//
// Never add SUPABASE_SECRET_KEY (or any other real secret) to this
// file or give it a fallback -- that key bypasses every RLS policy and must
// only ever come from a platform-managed environment variable, never from
// source control. See README.md and the "Removed committed .env.local"
// commit for why this distinction matters here specifically.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://yqxpucjtzrmwjniruebt.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxeHB1Y2p0enJtd2puaXJ1ZWJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2NjEyMDcsImV4cCI6MjEwNDIzNzIwN30.TeOSoWC0VPKg-q0kS8USbSlRaJBxlX9_XsODBWJFSeY";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://hrtstocksdev.netlify.app";
