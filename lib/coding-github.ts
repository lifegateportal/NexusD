import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { getCodingWorkspace } from "@/lib/coding-workspace-storage";
import { CodingWorkspaceFileSchema } from "@/lib/coding-workspace";
import {
  CodingGitHubPublishResponseSchema,
  CodingGitHubRepositoriesResponseSchema,
  type CodingGitHubPublishRequestSchema,
} from "@/lib/coding-github-schema";

const GITHUB_API = "https://api.github.com";
export const GITHUB_STATE_COOKIE = "nexus_github_oauth_state";
export const GITHUB_SESSION_COOKIE = "nexus_github_session";

const GitHubOAuthConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  callbackUrl: z.string().url(),
  sessionSecret: z.string().min(32),
}).strict();

const GitHubTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  scope: z.string(),
}).passthrough();

const GitHubErrorSchema = z.object({
  message: z.string().optional(),
}).passthrough();

const GitHubUserSchema = z.object({
  login: z.string().min(1).max(100),
}).passthrough();

const GitHubApiRepositorySchema = z.object({
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string().nullable(),
  archived: z.boolean(),
  owner: z.object({ login: z.string() }).passthrough(),
}).passthrough();

const GitHubReferenceSchema = z.object({
  object: z.object({ sha: z.string().min(1) }).passthrough(),
}).passthrough();

const GitHubCommitSchema = z.object({
  tree: z.object({ sha: z.string().min(1) }).passthrough(),
}).passthrough();

const GitHubCreatedTreeSchema = z.object({
  sha: z.string().min(1),
}).passthrough();

const GitHubCreatedBlobSchema = z.object({
  sha: z.string().min(1),
}).passthrough();

const GitHubCreatedCommitSchema = z.object({
  sha: z.string().min(1),
  html_url: z.string().url(),
}).passthrough();

const GitHubRepositoryListSchema = z.array(GitHubApiRepositorySchema);

type GitHubOAuthConfig = z.infer<typeof GitHubOAuthConfigSchema>;
type GitHubPublishRequest = z.infer<typeof CodingGitHubPublishRequestSchema>;

export class CodingGitHubError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "CodingGitHubError";
  }
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig {
  const parsed = GitHubOAuthConfigSchema.safeParse({
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    callbackUrl: env.GITHUB_OAUTH_CALLBACK_URL,
    sessionSecret: env.GITHUB_OAUTH_SESSION_SECRET,
  });
  if (!parsed.success) {
    throw new CodingGitHubError(
      "GitHub publishing is not configured. Set the four GITHUB_OAUTH_* variables on the server.",
      503,
    );
  }
  const callbackUrl = new URL(parsed.data.callbackUrl);
  if (callbackUrl.protocol !== "https:" && !(env.NODE_ENV !== "production" && callbackUrl.hostname === "localhost")) {
    throw new CodingGitHubError("The GitHub OAuth callback URL must use HTTPS.", 503);
  }
  return parsed.data;
}

export function createGitHubOAuthState(): string {
  return randomBytes(32).toString("hex");
}

export function isValidGitHubOAuthState(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received || !/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export function buildGitHubAuthorizationUrl(state: string): URL {
  const config = getGitHubOAuthConfig();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", "repo read:user");
  url.searchParams.set("state", state);
  return url;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(getGitHubOAuthConfig().sessionSecret).digest();
}

export function encryptGitHubToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptGitHubToken(value: string | undefined): string {
  if (!value) throw new CodingGitHubError("Connect your GitHub account before publishing.", 401);
  const [ivValue, tagValue, encryptedValue, extra] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue || extra !== undefined) {
    throw new CodingGitHubError("The saved GitHub session is invalid. Connect GitHub again.", 401);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const token = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    if (!token) throw new Error("Empty GitHub token.");
    return token;
  } catch (error) {
    if (error instanceof CodingGitHubError) throw error;
    throw new CodingGitHubError("The saved GitHub session could not be decrypted. Connect GitHub again.", 401);
  }
}

async function githubRequest<T>(
  token: string,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<T | null> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const apiError = GitHubErrorSchema.safeParse(payload);
    throw new CodingGitHubError(
      apiError.success && apiError.data.message
        ? `GitHub: ${apiError.data.message}`
        : `GitHub request failed with status ${response.status}.`,
      response.status,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error("[coding/github] GitHub returned an invalid response", parsed.error.issues);
    throw new CodingGitHubError("GitHub returned an invalid response. Try again.");
  }
  return parsed.data;
}

export async function exchangeGitHubOAuthCode(code: string): Promise<string> {
  const config = getGitHubOAuthConfig();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CodingGitHubError("GitHub authorization could not be completed.", 502);
  }
  const parsed = GitHubTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const oauthError = GitHubErrorSchema.safeParse(payload);
    throw new CodingGitHubError(
      oauthError.success && oauthError.data.message
        ? `GitHub authorization failed: ${oauthError.data.message}`
        : "GitHub returned an invalid authorization response.",
      502,
    );
  }
  return parsed.data.access_token;
}

export async function listOwnedGitHubRepositories(token: string) {
  const user = await githubRequest(token, "/user", GitHubUserSchema);
  if (!user) throw new CodingGitHubError("GitHub did not return the signed-in account.", 502);
  const repositories: z.infer<typeof GitHubApiRepositorySchema>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubRequest(
      token,
      `/user/repos?affiliation=owner&sort=updated&per_page=100&page=${page}`,
      GitHubRepositoryListSchema,
    );
    if (!batch) throw new CodingGitHubError("GitHub did not return a repository list.", 502);
    repositories.push(...batch.filter((repository) => repository.owner.login.toLowerCase() === user.login.toLowerCase()));
    if (batch.length < 100) break;
  }
  const parsed = CodingGitHubRepositoriesResponseSchema.safeParse({
    connected: true,
    login: user.login,
    repositories: repositories.map((repository) => ({
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
    })),
  });
  if (!parsed.success) {
    console.error("[coding/github] Repository list exceeded response limits", parsed.error.issues);
    throw new CodingGitHubError("Too many repositories were returned to display. Narrow the list and try again.", 422);
  }
  return parsed.data;
}

function encodeBranch(branch: string): string {
  return branch.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export async function publishCodingWorkspaceToGitHub(
  token: string,
  input: GitHubPublishRequest,
) {
  const snapshot = await getCodingWorkspace(input.workspaceId);
  if (!snapshot) throw new CodingGitHubError("Coding project was not found.", 404);
  if (snapshot.workspace.currentRevisionId !== input.revisionId) {
    throw new CodingGitHubError("The coding project changed. Refresh it and publish the latest revision.", 409);
  }
  if (snapshot.revision.files.length === 0) {
    throw new CodingGitHubError("This project has no files to publish.", 400);
  }
  const files = snapshot.revision.files.map((file) => CodingWorkspaceFileSchema.parse(file));
  const user = await githubRequest(token, "/user", GitHubUserSchema);
  if (!user) throw new CodingGitHubError("GitHub did not return the signed-in account.", 502);
  const [owner, repositoryName] = input.repository.split("/");
  if (!owner || !repositoryName || owner.toLowerCase() !== user.login.toLowerCase()) {
    throw new CodingGitHubError("You can publish only to a repository owned by the connected personal account.", 403);
  }
  const repository = await githubRequest(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
    GitHubApiRepositorySchema,
  );
  if (!repository) throw new CodingGitHubError("GitHub repository was not found.", 404);
  if (repository.owner.login.toLowerCase() !== user.login.toLowerCase()) {
    throw new CodingGitHubError("You can publish only to a repository owned by the connected personal account.", 403);
  }
  if (repository.archived) throw new CodingGitHubError("This GitHub repository is archived and cannot be updated.", 409);

  const branch = repository.default_branch || "main";
  const branchRef = await githubRequest(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/git/ref/heads/${encodeBranch(branch)}`,
    GitHubReferenceSchema,
    {},
    true,
  );
  let baseTree: string | undefined;
  let parents: string[] = [];
  if (branchRef) {
    const parentSha = branchRef.object.sha;
    const parentCommit = await githubRequest(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/git/commits/${encodeURIComponent(parentSha)}`,
      GitHubCommitSchema,
    );
    if (!parentCommit) throw new CodingGitHubError("GitHub did not return the branch commit.", 502);
    baseTree = parentCommit.tree.sha;
    parents = [parentSha];
  }

  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (let index = 0; index < files.length; index += 10) {
    const batch = await Promise.all(files.slice(index, index + 10).map(async (file) => {
      const blob = await githubRequest(
        token,
        `${repositoryPath}/git/blobs`,
        GitHubCreatedBlobSchema,
        {
          method: "POST",
          body: JSON.stringify({
            content: Buffer.from(file.content, "utf8").toString("base64"),
            encoding: "base64",
          }),
        },
      );
      if (!blob) throw new CodingGitHubError("GitHub did not create a file blob.", 502);
      return {
        path: file.name.replaceAll("\\", "/"),
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      };
    }));
    treeEntries.push(...batch);
  }

  const tree = await githubRequest(
    token,
    `${repositoryPath}/git/trees`,
    GitHubCreatedTreeSchema,
    {
      method: "POST",
      body: JSON.stringify({
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: treeEntries,
      }),
    },
  );
  if (!tree) throw new CodingGitHubError("GitHub did not create a repository tree.", 502);

  const commit = await githubRequest(
    token,
    `${repositoryPath}/git/commits`,
    GitHubCreatedCommitSchema,
    {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents,
      }),
    },
  );
  if (!commit) throw new CodingGitHubError("GitHub did not create a commit.", 502);

  if (branchRef) {
    await githubRequest(
      token,
      `${repositoryPath}/git/refs/heads/${encodeBranch(branch)}`,
      GitHubReferenceSchema,
      {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );
  } else {
    await githubRequest(
      token,
      `${repositoryPath}/git/refs`,
      GitHubReferenceSchema,
      {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      },
    );
  }

  return CodingGitHubPublishResponseSchema.parse({
    repository: repository.full_name,
    branch,
    commitUrl: commit.html_url,
    fileCount: files.length,
  });
}
