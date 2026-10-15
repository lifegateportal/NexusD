import { NextRequest, NextResponse } from "next/server";
import {
  CodingGitHubError,
  encryptGitHubToken,
  exchangeGitHubOAuthCode,
  GITHUB_SESSION_COOKIE,
  GITHUB_STATE_COOKIE,
  isValidGitHubOAuthState,
} from "@/lib/coding-github";
import { env } from "@/lib/env";

export const runtime = "nodejs";

function redirectToCoding(request: NextRequest, error?: string) {
  const target = new URL("/coding", request.url);
  if (error) target.searchParams.set("github_error", error);
  return NextResponse.redirect(target);
}

export async function GET(request: NextRequest) {
  const stateCookie = request.cookies.get(GITHUB_STATE_COOKIE)?.value;
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");
  const response = redirectToCoding(
    request,
    providerError ? "GitHub authorization was cancelled." : undefined,
  );
  response.cookies.set(GITHUB_STATE_COOKIE, "", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/coding/github/callback",
    maxAge: 0,
  });
  if (providerError) return response;
  if (!isValidGitHubOAuthState(stateCookie, state) || !code || code.length > 2048) {
    const invalid = redirectToCoding(request, "GitHub authorization state was invalid. Please connect again.");
    invalid.cookies.set(GITHUB_STATE_COOKIE, "", {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/coding/github/callback",
      maxAge: 0,
    });
    return invalid;
  }

  try {
    const token = await exchangeGitHubOAuthCode(code);
    const connected = redirectToCoding(request);
    connected.cookies.set(GITHUB_STATE_COOKIE, "", {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/coding/github/callback",
      maxAge: 0,
    });
    connected.cookies.set(GITHUB_SESSION_COOKIE, encryptGitHubToken(token), {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return connected;
  } catch (error) {
    const message = error instanceof CodingGitHubError
      ? error.message
      : "GitHub connection could not be completed. Please try again.";
    if (!(error instanceof CodingGitHubError)) {
      console.error("[coding/github/callback] OAuth callback failed", error);
    }
    const failed = redirectToCoding(request, message);
    failed.cookies.set(GITHUB_STATE_COOKIE, "", {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/coding/github/callback",
      maxAge: 0,
    });
    return failed;
  }
}
