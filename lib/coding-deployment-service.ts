import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CodingBuildResponseSchema,
  CodingDeploymentEnvironmentSchema,
  CodingDeploymentSchema,
  CodingProjectDeleteResponseSchema,
  type CodingDeployment,
  type CodingDeploymentKind,
} from "@/lib/coding-deployment";
import { env } from "@/lib/env";
import type { CodingWorkspaceSnapshot } from "@/lib/coding-workspace";
import {
  getCodingDeployment,
  listCodingDeployments,
  saveCodingDeployment,
} from "@/lib/coding-workspace-storage";

export class CodingDeploymentError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "CodingDeploymentError";
  }
}

const deploymentLocks = new Map<string, Promise<unknown>>();

async function withDeploymentLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = deploymentLocks.get(key);
  const operationPromise = previous
    ? previous.then(operation, operation)
    : operation();
  const settled = operationPromise.then(() => undefined, () => undefined);
  deploymentLocks.set(key, settled);
  try {
    return await operationPromise;
  } finally {
    if (deploymentLocks.get(key) === settled) deploymentLocks.delete(key);
  }
}

export function codingDeploymentConfigurationError(): string | null {
  if (!env.AUTH_PASSWORD || !env.AUTH_COOKIE_SECRET) {
    return "Configure Nexus login before enabling project deployments.";
  }
  if (!env.CODING_RUNNER_URL || !env.CODING_RUNNER_TOKEN) {
    return "The isolated coding runner is not configured for deployments.";
  }
  if (!env.EPICGLOBAL_ORCHESTRATOR_API_KEY) {
    return "Configure the EpicGlobal orchestrator API key on the Nexus server.";
  }
  return null;
}

function runnerUrl(path: string): string {
  return `${env.CODING_RUNNER_URL?.replace(/\/$/, "")}${path}`;
}

async function runnerRequest(path: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<unknown> {
  if (!env.CODING_RUNNER_URL || !env.CODING_RUNNER_TOKEN) {
    throw new CodingDeploymentError("The isolated coding runner is not configured.", 503);
  }
  const response = await fetch(runnerUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = z.object({ error: z.string().max(1000).optional() }).passthrough().safeParse(payload);
    throw new CodingDeploymentError(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : "The isolated runner could not process the deployment.",
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  return payload;
}

function isEnvironmentFile(name: string): boolean {
  return name.split("/").some((segment) => /^\.env(?:$|\.(?!example$))/i.test(segment));
}

function projectFilesError(snapshot: CodingWorkspaceSnapshot, kind: CodingDeploymentKind): string | null {
  const files = snapshot.revision.files;
  if (files.some((file) => isEnvironmentFile(file.name))) {
    return "Remove .env secrets from the project before deploying.";
  }
  if (kind === "static") {
    const manifestFile = files.find((file) => file.name === "package.json");
    if (manifestFile) {
      let manifest: unknown;
      try {
        manifest = JSON.parse(manifestFile.content) as unknown;
      } catch {
        return "The project root package.json is not valid JSON.";
      }
      const parsed = z.object({
        scripts: z.object({ build: z.string().trim().min(1).optional() }).passthrough().optional(),
      }).passthrough().safeParse(manifest);
      if (!parsed.success) return "The project root package.json has an invalid scripts section.";
      if (!parsed.data.scripts?.build && !files.some((file) => (
        file.name === "index.html" || file.name === "public/index.html"
      ))) {
        return "Add a build script or a root index.html before deploying a static site.";
      }
    } else if (!files.some((file) => file.name === "index.html")) {
      return "Static deployment needs a root index.html or a package.json build script.";
    }
    return null;
  }

  if (files.some((file) => file.name === "Dockerfile")) {
    return "Custom Dockerfiles are not supported by the Droplet deployment agent.";
  }
  const packageFile = files.find((file) => file.name === "package.json");
  if (!packageFile) return "Full-stack deployment supports Node.js projects with a root package.json.";
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageFile.content) as unknown;
  } catch {
    return "The project root package.json is not valid JSON.";
  }
  const parsed = z.object({
    scripts: z.object({ start: z.string().trim().min(1) }).passthrough(),
  }).passthrough().safeParse(manifest);
  return parsed.success ? null : "Add a start script to package.json before deploying.";
}

function projectName(snapshot: CodingWorkspaceSnapshot): string {
  const namePart = snapshot.workspace.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 26) || "project";
  const idSuffix = snapshot.workspace.id.replace(/[^a-z0-9]/g, "").slice(-8);
  return `nx-${namePart}-${idSuffix}`;
}

function updateDeployment(
  deployment: CodingDeployment,
  updates: Partial<CodingDeployment>,
): CodingDeployment {
  return CodingDeploymentSchema.parse({
    ...deployment,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

function statusFromBuild(status: "queued" | "building" | "deploying" | "completed" | "failed"): CodingDeployment["status"] {
  return status === "completed" ? "active" : status;
}

async function markPreviousDeploymentsStopped(
  workspaceId: string,
  activeDeployment: CodingDeployment,
): Promise<void> {
  const previous = await listCodingDeployments(workspaceId);
  for (const item of previous) {
    if (
      item.id !== activeDeployment.id
      && item.projectName === activeDeployment.projectName
      && item.status === "active"
    ) {
      await saveCodingDeployment(updateDeployment(item, {
        status: "stopped",
        url: null,
        phase: "Replaced by a newer deployment",
      }));
    }
  }
}

export async function createCodingDeployment(
  snapshot: CodingWorkspaceSnapshot,
  kind: CodingDeploymentKind,
  environment: Record<string, string> = {},
): Promise<CodingDeployment> {
  return withDeploymentLock(snapshot.workspace.id, () => createCodingDeploymentUnlocked(snapshot, kind, environment));
}

async function createCodingDeploymentUnlocked(
  snapshot: CodingWorkspaceSnapshot,
  kind: CodingDeploymentKind,
  environment: Record<string, string>,
): Promise<CodingDeployment> {
  const projectError = projectFilesError(snapshot, kind);
  if (projectError) throw new CodingDeploymentError(projectError, 400);
  const parsedEnvironment = CodingDeploymentEnvironmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) throw new CodingDeploymentError("Runtime environment variables are invalid.", 400);
  if (kind === "static" && Object.keys(parsedEnvironment.data).length > 0) {
    throw new CodingDeploymentError("Runtime environment variables are available for full-stack apps only.", 400);
  }

  const name = projectName(snapshot);
  const existingDeployments = await listCodingDeployments(snapshot.workspace.id);
  if (existingDeployments.some((deployment) => (
    deployment.status === "queued"
    || deployment.status === "building"
    || deployment.status === "deploying"
  ))) {
    throw new CodingDeploymentError("Wait for the current deployment to finish.", 409);
  }
  const activeDeployment = existingDeployments.find((deployment) => (
    deployment.projectName === name && deployment.status === "active"
  ));
  if (activeDeployment && activeDeployment.kind !== kind) {
    throw new CodingDeploymentError(
      "Delete the current site before switching between static and full-stack hosting.",
      409,
    );
  }
  if (!env.EPICGLOBAL_ORCHESTRATOR_API_KEY) {
    throw new CodingDeploymentError("Set EPICGLOBAL_ORCHESTRATOR_API_KEY on the Nexus server.", 503);
  }

  const now = new Date().toISOString();
  const deployment: CodingDeployment = {
    id: `dep-${randomUUID()}`,
    workspaceId: snapshot.workspace.id,
    revisionId: snapshot.revision.id,
    kind,
    runnerJobId: null,
    projectName: name,
    url: null,
    status: "queued",
    phase: null,
    logs: "",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveCodingDeployment(deployment);

  try {
    const payload = await runnerRequest("/deployments", {
      method: "POST",
      body: JSON.stringify({
        id: deployment.id,
        workspaceId: deployment.workspaceId,
        revisionId: deployment.revisionId,
        kind,
        projectName: deployment.projectName,
        environment: parsedEnvironment.data,
        epicGlobalApiUrl: env.EPICGLOBAL_API_URL,
        epicGlobalApiKey: env.EPICGLOBAL_ORCHESTRATOR_API_KEY,
        files: snapshot.revision.files,
      }),
    });
    const parsed = CodingBuildResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] Runner returned invalid build data", parsed.error.issues);
      throw new CodingDeploymentError("The isolated runner returned invalid deployment data.", 502);
    }
    const next = updateDeployment(deployment, {
      runnerJobId: parsed.data.build.id,
      status: statusFromBuild(parsed.data.build.status),
      phase: parsed.data.build.phase,
      url: parsed.data.build.url,
      logs: parsed.data.logs,
      error: parsed.data.error,
    });
    await saveCodingDeployment(next);
    if (next.status === "active") await markPreviousDeploymentsStopped(snapshot.workspace.id, next);
    return next;
  } catch (error) {
    const failed = updateDeployment(deployment, {
      status: "failed",
      error: error instanceof Error ? error.message : "Deployment could not be started.",
    });
    await saveCodingDeployment(failed);
    if (error instanceof CodingDeploymentError) throw error;
    console.error("[coding/deployments] Could not start deployment", error);
    throw new CodingDeploymentError("Deployment could not be started.", 502);
  }
}

export async function listWorkspaceCodingDeployments(workspaceId: string): Promise<CodingDeployment[]> {
  return listCodingDeployments(workspaceId);
}

export async function refreshCodingDeployment(
  workspaceId: string,
  deploymentId: string,
): Promise<CodingDeployment | null> {
  return withDeploymentLock(`${workspaceId}:${deploymentId}`, () => refreshCodingDeploymentUnlocked(workspaceId, deploymentId));
}

async function refreshCodingDeploymentUnlocked(
  workspaceId: string,
  deploymentId: string,
): Promise<CodingDeployment | null> {
  let deployment = await getCodingDeployment(workspaceId, deploymentId);
  if (!deployment) return null;
  if (["active", "failed", "stopped"].includes(deployment.status)) return deployment;
  if (!deployment.runnerJobId) return deployment;

  let payload: unknown;
  try {
    payload = await runnerRequest(`/deployments/${encodeURIComponent(deployment.runnerJobId)}`);
  } catch (error) {
    if (!(error instanceof CodingDeploymentError) || error.status !== 404) throw error;
    deployment = updateDeployment(deployment, {
      status: "failed",
      error: "The deployment runner no longer has this job. Start a new deployment.",
    });
    await saveCodingDeployment(deployment);
    return deployment;
  }
  const parsed = CodingBuildResponseSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("[coding/deployments] Runner returned invalid deployment status", parsed.error.issues);
    throw new CodingDeploymentError("The isolated runner returned invalid deployment status.", 502);
  }

  const build = parsed.data.build;
  deployment = updateDeployment(deployment, {
    status: statusFromBuild(build.status),
    phase: build.phase,
    url: build.url,
    logs: parsed.data.logs,
    error: parsed.data.error,
  });
  await saveCodingDeployment(deployment);
  if (deployment.status === "active") {
    await markPreviousDeploymentsStopped(workspaceId, deployment);
  }
  return deployment;
}

export async function stopCodingDeployment(
  workspaceId: string,
  deploymentId: string,
): Promise<CodingDeployment | null> {
  return withDeploymentLock(`${workspaceId}:${deploymentId}`, () => stopCodingDeploymentUnlocked(workspaceId, deploymentId));
}

async function stopCodingDeploymentUnlocked(
  workspaceId: string,
  deploymentId: string,
): Promise<CodingDeployment | null> {
  const deployment = await getCodingDeployment(workspaceId, deploymentId);
  if (!deployment) return null;
  const related = await listCodingDeployments(workspaceId);
  const projectDeployments = related.filter((item) => item.projectName === deployment.projectName);
  const needsRemoteDelete = deployment.url !== null
    || projectDeployments.some((item) => item.status === "active");
  const isInProgress = ["queued", "building", "deploying"].includes(deployment.status);

  if (isInProgress && deployment.runnerJobId) {
    const payload = await runnerRequest(`/deployments/${encodeURIComponent(deployment.runnerJobId)}`, {
      method: "DELETE",
    });
    const parsed = CodingBuildResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] Runner returned invalid cancellation data", parsed.error.issues);
      throw new CodingDeploymentError("The isolated runner returned invalid cancellation data.", 502);
    }
  } else if (!isInProgress && needsRemoteDelete) {
    const payload = await runnerRequest(`/projects/${encodeURIComponent(deployment.projectName)}/delete`, {
      method: "POST",
      body: JSON.stringify({
        kind: deployment.kind,
        epicGlobalApiUrl: env.EPICGLOBAL_API_URL,
        epicGlobalApiKey: env.EPICGLOBAL_ORCHESTRATOR_API_KEY,
      }),
    }, 190_000);
    const parsed = CodingProjectDeleteResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] Runner returned invalid project deletion data", parsed.error.issues);
      throw new CodingDeploymentError("The isolated runner returned invalid project deletion data.", 502);
    }
  }

  const deploymentsToStop = isInProgress ? [deployment] : projectDeployments;
  for (const item of deploymentsToStop) {
    if (item.status === "stopped") continue;
    await saveCodingDeployment(updateDeployment(item, {
      status: "stopped",
      url: null,
      error: null,
      phase: "STOPPED",
    }));
  }
  return getCodingDeployment(workspaceId, deploymentId);
}
