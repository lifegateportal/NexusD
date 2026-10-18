import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CodingBuildResponseSchema,
  CodingDeploymentSchema,
  type CodingDeployment,
} from "@/lib/coding-deployment";
import {
  codingAppName,
  codingImageRepository,
  deleteDigitalOceanApp,
  deployCodingImage,
  findLatestDigitalOceanDeployment,
  getDigitalOceanAppDeployment,
  getDigitalOceanRegistryDockerConfig,
  CodingDigitalOceanError,
} from "@/lib/coding-digitalocean";
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
    return "Configure Nexus login before enabling DigitalOcean deployments.";
  }
  if (!env.CODING_RUNNER_URL || !env.CODING_RUNNER_TOKEN) {
    return "The isolated coding runner is not configured for deployments.";
  }
  if (!env.DIGITALOCEAN_API_TOKEN || !env.DIGITALOCEAN_REGISTRY_NAME) {
    return "DigitalOcean deployments are not configured on the server.";
  }
  return null;
}

function runnerUrl(path: string): string {
  return `${env.CODING_RUNNER_URL?.replace(/\/$/, "")}${path}`;
}

async function runnerRequest(path: string, init: RequestInit = {}): Promise<unknown> {
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
    signal: AbortSignal.timeout(25_000),
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

function packageStartError(snapshot: CodingWorkspaceSnapshot): string | null {
  if (snapshot.revision.files.some((file) => file.name === "Dockerfile")) {
    return "Custom Dockerfiles are not supported yet; Nexus generates the Node.js production image.";
  }
  if (snapshot.revision.files.some((file) => (
    /^\.env(?:$|\.(?!example$))/i.test(file.name)
    || file.name.includes("/.env")
  ))) {
    return "Remove .env secrets from the project before deploying.";
  }
  const packageFile = snapshot.revision.files.find((file) => file.name === "package.json");
  if (!packageFile) return "Deploy currently supports Node.js projects with a root package.json.";
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

export async function createCodingDeployment(
  snapshot: CodingWorkspaceSnapshot,
): Promise<CodingDeployment> {
  const projectError = packageStartError(snapshot);
  if (projectError) throw new CodingDeploymentError(projectError, 400);
  const existingDeployments = await listCodingDeployments(snapshot.workspace.id);
  if (existingDeployments.some((deployment) => (
    deployment.status === "queued"
    || deployment.status === "building"
    || deployment.status === "deploying"
  ))) {
    throw new CodingDeploymentError("Wait for the current DigitalOcean deployment to finish.", 409);
  }
  if (!env.DIGITALOCEAN_REGISTRY_NAME) {
    throw new CodingDeploymentError("Set DIGITALOCEAN_REGISTRY_NAME to use DigitalOcean deployments.", 503);
  }

  const now = new Date().toISOString();
  const deployment: CodingDeployment = {
    id: `dep-${randomUUID()}`,
    workspaceId: snapshot.workspace.id,
    revisionId: snapshot.revision.id,
    runnerJobId: null,
    appId: null,
    appDeploymentId: null,
    appName: codingAppName(snapshot.workspace.id),
    imageRepository: codingImageRepository(snapshot.workspace.id),
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
    const dockerConfig = await getDigitalOceanRegistryDockerConfig();
    const payload = await runnerRequest("/deployments", {
      method: "POST",
      body: JSON.stringify({
        id: deployment.id,
        workspaceId: deployment.workspaceId,
        revisionId: deployment.revisionId,
        registry: env.DIGITALOCEAN_REGISTRY_NAME,
        repository: deployment.imageRepository,
        tag: deployment.revisionId,
        dockerConfig,
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
      status: parsed.data.build.status === "queued" ? "queued" : "building",
      logs: parsed.data.logs,
      error: parsed.data.error,
    });
    await saveCodingDeployment(next);
    return next;
  } catch (error) {
    const failed = updateDeployment(deployment, {
      status: "failed",
      error: error instanceof Error ? error.message : "Deployment build could not be started.",
    });
    await saveCodingDeployment(failed);
    if (error instanceof CodingDeploymentError || error instanceof CodingDigitalOceanError) {
      throw error;
    }
    console.error("[coding/deployments] Could not start deployment build", error);
    throw new CodingDeploymentError("Deployment build could not be started.", 502);
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

  if (deployment.status === "queued" || deployment.status === "building") {
    if (!deployment.runnerJobId) return deployment;
    let payload: unknown;
    try {
      payload = await runnerRequest(`/deployments/${encodeURIComponent(deployment.runnerJobId)}`);
    } catch (error) {
      if (!(error instanceof CodingDeploymentError) || error.status !== 404) throw error;
      deployment = updateDeployment(deployment, {
        status: "failed",
        error: "The deployment runner no longer has this build. Start a new deployment.",
      });
      await saveCodingDeployment(deployment);
      return deployment;
    }
    const parsed = CodingBuildResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] Runner returned invalid build status", parsed.error.issues);
      throw new CodingDeploymentError("The isolated runner returned invalid deployment status.", 502);
    }
    if (parsed.data.build.status === "failed") {
      deployment = updateDeployment(deployment, {
        status: "failed",
        logs: parsed.data.logs,
        error: parsed.data.error ?? "The project image build failed.",
      });
      await saveCodingDeployment(deployment);
      return deployment;
    }
    deployment = updateDeployment(deployment, {
      status: parsed.data.build.status === "completed" ? "building" : parsed.data.build.status,
      logs: parsed.data.logs,
      error: parsed.data.error,
    });
    await saveCodingDeployment(deployment);
    if (parsed.data.build.status !== "completed") return deployment;

    const currentDeploymentId = deployment.id;
    const priorDeployments = await listCodingDeployments(workspaceId);
    const existingAppId = deployment.appId
      ?? priorDeployments.find((prior) => (
        prior.id !== currentDeploymentId
        && prior.status !== "stopped"
        && prior.appId
      ))?.appId
      ?? null;
    if (existingAppId && deployment.appId !== existingAppId) {
      deployment = updateDeployment(deployment, { appId: existingAppId });
      await saveCodingDeployment(deployment);
    }
    try {
      const appDeployment = await deployCodingImage(
        workspaceId,
        deployment.imageRepository,
        deployment.revisionId,
        existingAppId,
      );
      deployment = updateDeployment(deployment, {
        status: "deploying",
        appId: appDeployment.appId,
        appDeploymentId: appDeployment.deploymentId,
        url: appDeployment.url,
        phase: appDeployment.deploymentId ? "PENDING" : "Waiting for DigitalOcean deployment",
        error: null,
      });
      await saveCodingDeployment(deployment);
      if (!deployment.appDeploymentId) {
        const appDeploymentId = await findLatestDigitalOceanDeployment(appDeployment.appId);
        if (appDeploymentId) {
          deployment = updateDeployment(deployment, { appDeploymentId });
          await saveCodingDeployment(deployment);
        }
      }
    } catch (error) {
      deployment = updateDeployment(deployment, {
        status: "failed",
        error: error instanceof Error ? error.message : "DigitalOcean could not start the app deployment.",
      });
      await saveCodingDeployment(deployment);
      return deployment;
    }
  }

  if (deployment.status !== "deploying" || !deployment.appId) return deployment;
  try {
    if (!deployment.appDeploymentId) {
      const appDeploymentId = await findLatestDigitalOceanDeployment(deployment.appId);
      if (!appDeploymentId) return deployment;
      deployment = updateDeployment(deployment, { appDeploymentId });
      await saveCodingDeployment(deployment);
    }
    const appId = deployment.appId;
    const appDeploymentId = deployment.appDeploymentId;
    if (!appId || !appDeploymentId) return deployment;
    const appStatus = await getDigitalOceanAppDeployment(appId, appDeploymentId);
    const phase = appStatus.phase.toUpperCase();
    const isActive = phase === "ACTIVE" || phase === "COMPLETE";
    const isFailure = ["ERROR", "CANCELED", "CANCELLED", "SUPERSEDED"].includes(phase);
    deployment = updateDeployment(deployment, {
      status: isActive ? "active" : isFailure ? "failed" : "deploying",
      phase: appStatus.phase,
      url: appStatus.url ?? deployment.url,
      error: isFailure ? `DigitalOcean deployment ended in ${appStatus.phase}. Check its deployment logs in DigitalOcean.` : null,
    });
    await saveCodingDeployment(deployment);
  } catch (error) {
    if (error instanceof CodingDigitalOceanError) throw error;
    throw new CodingDeploymentError(
      error instanceof Error ? error.message : "DigitalOcean deployment status could not be loaded.",
      502,
    );
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
  if (deployment.appId) {
    await deleteDigitalOceanApp(deployment.appId);
  } else if (deployment.runnerJobId) {
    const payload = await runnerRequest(`/deployments/${encodeURIComponent(deployment.runnerJobId)}`, {
      method: "DELETE",
    });
    const parsed = CodingBuildResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] Runner returned invalid cancellation data", parsed.error.issues);
      throw new CodingDeploymentError("The isolated runner returned invalid cancellation data.", 502);
    }
  }

  const related = deployment.appId
    ? await listCodingDeployments(workspaceId)
    : [deployment];
  const stopped = related.filter((item) => (
    item.id === deployment.id || (deployment.appId !== null && item.appId === deployment.appId)
  ));
  for (const item of stopped) {
    await saveCodingDeployment(updateDeployment(item, {
      status: "stopped",
      appId: null,
      appDeploymentId: null,
      url: null,
      error: null,
      phase: "STOPPED",
    }));
  }
  return getCodingDeployment(workspaceId, deploymentId);
}
