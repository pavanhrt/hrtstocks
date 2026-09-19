import { NextResponse } from "next/server";
import { serverConfig } from "@/lib/config";
import { csrfOk } from "@/lib/csrf";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!csrfOk(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(serverConfig().SESSION_COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
