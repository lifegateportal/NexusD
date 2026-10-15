import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

const COOKIE_NAME = "nexus_session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const BodySchema = z.object({ password: z.string().min(1) });

export async function POST(request: Request) {
  const authPassword = process.env.AUTH_PASSWORD;
  const cookieSecret = process.env.AUTH_COOKIE_SECRET;

  if (!authPassword || !cookieSecret) {
    return NextResponse.json({ error: "Auth not configured on server" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (parsed.data.password !== authPassword) {
    // Constant-time compare would be ideal; for a single-user personal tool this is fine
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const token = createHmac("sha256", cookieSecret).update(authPassword).digest("hex");

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ONE_YEAR_SECONDS,
    path: "/",
  });
  return res;
}
