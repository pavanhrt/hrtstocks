import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate only: it runs on the Edge runtime, which cannot verify a
// session with the Admin SDK. It just sends visitors without a session cookie
// to /login. The AUTHORITATIVE check is server-side -- getCurrentUser() in
// lib/auth.ts (signature, expiry, revocation, invite-only profile) is required
// by the (app) layout, every API route and every repository. Forging a cookie
// value gets past this file but never past those.
// /fyers/callback: the manual FYERS token flow lands here (public, does nothing with the query string).
const PUBLIC_PATHS = ["/login", "/api/auth/session", "/api/auth/logout", "/api/health", "/fyers/callback"];
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "__session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
