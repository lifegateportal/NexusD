import { NextResponse } from "next/server";
import {
  buildGitHubAuthorizationUrl,
  CodingGitHubError,
  createGitHubOAuthState,
  GITHUB_STATE_COOKIE,
} from "@/lib/coding-github";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const state = createGitHubOAuthState();
    const response = NextResponse.redirect(buildGitHubAuthorizationUrl(state));
    response.cookies.set(GITHUB_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/coding/github/callback",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    const message = error instanceof CodingGitHubError
      ? error.message
      : "GitHub authorization could not be started.";
    if (!(error instanceof CodingGitHubError)) {
      console.error("[coding/github/connect] Failed to start OAuth", error);
    }
    const target = new URL("/coding", request.url);
    target.searchParams.set("github_error", message);
    return NextResponse.redirect(target);
  }
}
