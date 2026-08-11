import { NextResponse, type NextRequest } from "next/server";

const COOKIE_NAME = "nexus_session";

/** Derives the expected session token via HMAC-SHA256 using the Web Crypto API (Edge-compatible). */
async function computeExpectedToken(secret: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const authPassword = process.env.AUTH_PASSWORD;
  const cookieSecret = process.env.AUTH_COOKIE_SECRET;

  // Auth is opt-in — if env vars are absent, allow all traffic (useful for local dev)
  if (!authPassword || !cookieSecret) return NextResponse.next();

  // Always allow the login page, auth API routes, the public reading library,
  // and the scripture monitor (which has its own auth)
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/library") ||
    pathname.startsWith("/monitor") ||
    pathname.startsWith("/api/monitor/auth") ||
    pathname.startsWith("/api/monitor/state")
  ) {
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get(COOKIE_NAME)?.value;
  if (!sessionToken) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const expected = await computeExpectedToken(cookieSecret, authPassword);
  if (sessionToken !== expected) {
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      res.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
      return res;
    }
    const res = NextResponse.redirect(new URL("/login", request.url));
    // Clear the stale / tampered cookie
    res.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
    return res;
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except Next.js internals and static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
