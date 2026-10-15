import { NextRequest, NextResponse } from "next/server";
import { GITHUB_SESSION_COOKIE } from "@/lib/coding-github";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(_request: NextRequest) {
  const response = NextResponse.json({ connected: false });
  response.cookies.set(GITHUB_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
