import { NextResponse } from "next/server";
import { z } from "zod";
import { serverConfig } from "@/lib/config";
import { getDb } from "@/lib/db/pool";
import { resolveAuthorizedUser } from "@/lib/auth-profile";
import { adminAuth } from "@/lib/firebase/admin";
import { csrfOk } from "@/lib/csrf";

export const runtime = "nodejs";

const Body = z.object({ idToken: z.string().min(20).max(8192) });

// A session cookie may only be minted from a freshly-issued ID token, i.e. an
// actual recent sign-in, never from a token that leaked earlier.
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

/**
 * Exchanges a Firebase / Identity Platform ID token for a server-side session
 * cookie. The token is verified (signature, audience, expiry, revocation) with
 * the Admin SDK; whether this person may enter at all is decided by OUR
 * database (invite-only), not by anything the browser claims.
 */
export async function POST(request: Request) {
  if (!csrfOk(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const cfg = serverConfig();
  const auth = adminAuth();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(parsed.data.idToken, true);
  } catch {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }
  if (Date.now() / 1000 - decoded.auth_time > MAX_TOKEN_AGE_SECONDS) {
    return NextResponse.json({ error: "stale_sign_in" }, { status: 401 });
  }

  const user = await resolveAuthorizedUser(
    getDb(),
    { uid: decoded.uid, email: decoded.email ?? "", emailVerified: decoded.email_verified === true },
    { signupMode: cfg.SIGNUP_MODE },
  );
  if (!user) {
    // Deliberately generic: do not reveal whether the address is invited.
    return NextResponse.json({ error: "not_authorized" }, { status: 403 });
  }

  const expiresIn = cfg.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cookie = await auth.createSessionCookie(parsed.data.idToken, { expiresIn });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(cfg.SESSION_COOKIE_NAME, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(expiresIn / 1000),
  });
  return response;
}
