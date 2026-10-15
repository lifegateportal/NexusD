import { NextRequest, NextResponse } from "next/server";
import {
  CodingGitHubError,
  decryptGitHubToken,
  GITHUB_SESSION_COOKIE,
  listOwnedGitHubRepositories,
} from "@/lib/coding-github";
import { CodingGitHubRepositoriesResponseSchema } from "@/lib/coding-github-schema";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const encryptedToken = request.cookies.get(GITHUB_SESSION_COOKIE)?.value;
  if (!encryptedToken) {
    return NextResponse.json(CodingGitHubRepositoriesResponseSchema.parse({
      connected: false,
      login: null,
      repositories: [],
    }), { headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  try {
    const repositories = await listOwnedGitHubRepositories(decryptGitHubToken(encryptedToken));
    return NextResponse.json(repositories, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof CodingGitHubError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[coding/github/repos] Failed to list repositories", error);
    return NextResponse.json({ error: "GitHub repositories could not be loaded." }, { status: 500 });
  }
}
