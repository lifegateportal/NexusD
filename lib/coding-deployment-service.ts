import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
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
import { validateCodingStaticArtifact } from "@/lib/coding-static-artifact";
import { isCodingStaticSensitivePath } from "@/lib/coding-static-policy";
import type { CodingWorkspaceSnapshot } from "@/lib/coding-workspace";
import {
  getCodingDeployment,
  listCodingDeployments,
  saveCodingDeployment,
} from "@/lib/coding-workspace-storage";

export class CodingDeploymentError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly deployment?: CodingDeployment,
  ) {
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

export function codingDeploymentConfigurationError(kind?: CodingDeploymentKind): string | null {
  if (!env.AUTH_PASSWORD || !env.AUTH_COOKIE_SECRET) {
    return "Configure Nexus login before enabling project deployments.";
  }
  if (!env.EPICGLOBAL_ORCHESTRATOR_API_KEY) {
    return "Configure the EpicGlobal orchestrator API key on the Nexus server.";
  }
  if (kind === "fullstack" && !env.CODING_FULLSTACK_ENABLED) {
    return "Full-stack deployment is disabled by CODING_FULLSTACK_ENABLED=false.";
  }
  if (kind === "fullstack" && (!env.CODING_RUNNER_URL || !env.CODING_RUNNER_TOKEN)) {
    return "The isolated coding runner is not configured for full-stack deployments.";
  }
  return null;
}

export function codingFullstackDeploymentAvailable(): boolean {
  return env.CODING_FULLSTACK_ENABLED
    && Boolean(env.CODING_RUNNER_URL)
    && Boolean(env.CODING_RUNNER_TOKEN)
    && Boolean(env.EPICGLOBAL_ORCHESTRATOR_API_KEY);
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
    if (files.some((file) => isCodingStaticSensitivePath(file.name))) {
      return "Remove environment secrets, package credentials, and private key files before deploying a static site.";
    }
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
      if (!files.some((file) => file.name === "public/index.html")) {
        return "Static deployment needs a root index.html or a package.json build script.";
      }
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

async function createDeploymentRecord(
  snapshot: CodingWorkspaceSnapshot,
  kind: CodingDeploymentKind,
  environment: Record<string, string>,
  status: CodingDeployment["status"],
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
    status,
    phase: status === "deploying" ? "Uploading the browser-built static site" : null,
    logs: "",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveCodingDeployment(deployment);
  return deployment;
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
  if (kind === "static") {
    throw new CodingDeploymentError("Static deployments must upload a browser-built artifact.", 400);
  }
  const parsedEnvironment = CodingDeploymentEnvironmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) throw new CodingDeploymentError("Runtime environment variables are invalid.", 400);
  const deployment = await createDeploymentRecord(snapshot, kind, parsedEnvironment.data, "queued");

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

function epicGlobalApiBase(): string {
  let apiUrl: URL;
  try {
    apiUrl = new URL(env.EPICGLOBAL_API_URL);
  } catch {
    throw new CodingDeploymentError("The EpicGlobal API URL is invalid.", 503);
  }
  if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new CodingDeploymentError("The EpicGlobal API URL must be a clean HTTPS URL.", 503);
  }
  return `${apiUrl.origin}${apiUrl.pathname.replace(/\/$/, "")}`;
}

function createEpicGlobalUploadBody(
  projectName: string,
  archive: Uint8Array,
  boundary: string,
): { parts: Uint8Array[]; contentLength: number } {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="projectName"\r\n\r\n${projectName}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${projectName}.zip"\r\n`
    + "Content-Type: application/zip\r\n\r\n",
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    parts: [prefix, archive, suffix],
    contentLength: prefix.byteLength + archive.byteLength + suffix.byteLength,
  };
}

async function postEpicGlobalStaticArtifact(
  url: string,
  headers: Record<string, string>,
  parts: Uint8Array[],
  signal: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(url, { method: "POST", headers, signal }, (incoming) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > 1_000_000) {
          incoming.destroy(new Error("EpicGlobal returned an oversized upload response."));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload: unknown = null;
        try {
          payload = JSON.parse(raw) as unknown;
        } catch {
          payload = null;
        }
        resolve({ status: incoming.statusCode ?? 502, payload });
      });
      incoming.once("error", reject);
    });
    outgoing.once("error", reject);
    Readable.from(parts).pipe(outgoing);
  });
}

async function uploadStaticArtifact(
  deployment: CodingDeployment,
  archive: Uint8Array,
): Promise<CodingDeployment> {
  const boundary = `nexus-${randomUUID()}`;
  const multipart = createEpicGlobalUploadBody(deployment.projectName, archive, boundary);
  let response: { status: number; payload: unknown };
  try {
    response = await postEpicGlobalStaticArtifact(
      `${epicGlobalApiBase()}/api/orchestrator/upload`,
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(multipart.contentLength),
        "x-api-key": env.EPICGLOBAL_ORCHESTRATOR_API_KEY ?? "",
      },
      multipart.parts,
      AbortSignal.timeout(180_000),
    );
  } catch (error) {
    if (error instanceof CodingDeploymentError) throw error;
    throw new CodingDeploymentError(
      error instanceof Error ? `EpicGlobal upload failed: ${error.message}` : "EpicGlobal upload failed.",
      502,
    );
  }
  const parsed = z.object({
    success: z.literal(true),
    url: z.string().url(),
  }).passthrough().safeParse(response.payload);
  if (response.status < 200 || response.status >= 300 || !parsed.success) {
    const errorPayload = z.object({ error: z.string().max(1000).optional() }).passthrough().safeParse(response.payload);
    throw new CodingDeploymentError(
      errorPayload.success && errorPayload.data.error
        ? errorPayload.data.error
        : "EpicGlobal rejected the static site upload.",
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  const deployedUrl = new URL(parsed.data.url);
  if (
    deployedUrl.protocol !== "https:"
    || deployedUrl.hostname !== `${deployment.projectName}.epicglobal.app`
    || deployedUrl.username
    || deployedUrl.password
    || deployedUrl.port
    || deployedUrl.pathname !== "/"
    || deployedUrl.search
    || deployedUrl.hash
  ) {
    throw new CodingDeploymentError("EpicGlobal returned an unexpected static site URL.", 502);
  }

  const active = updateDeployment(deployment, {
    status: "active",
    url: deployedUrl.toString(),
    phase: "Published",
    error: null,
    logs: `${deployment.logs}[nexus] Browser-built static files are live at ${deployedUrl.toString()}\n`,
  });
  await saveCodingDeployment(active);
  await markPreviousDeploymentsStopped(deployment.workspaceId, active);
  return active;
}

async function deleteEpicGlobalStaticProject(
  projectName: string,
): Promise<z.infer<typeof CodingProjectDeleteResponseSchema>> {
  let response: Response;
  try {
    response = await fetch(`${epicGlobalApiBase()}/api/orchestrator/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.EPICGLOBAL_ORCHESTRATOR_API_KEY ?? "",
      },
      body: JSON.stringify({ projectName }),
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    if (error instanceof CodingDeploymentError) throw error;
    throw new CodingDeploymentError(
      error instanceof Error ? `EpicGlobal could not remove the static site: ${error.message}` : "EpicGlobal could not remove the static site.",
      502,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  const parsed = z.object({ success: z.literal(true) }).passthrough().safeParse(payload);
  if (!response.ok || !parsed.success) {
    const errorPayload = z.object({ error: z.string().max(1000).optional() }).passthrough().safeParse(payload);
    throw new CodingDeploymentError(
      errorPayload.success && errorPayload.data.error
        ? errorPayload.data.error
        : "EpicGlobal could not remove the static site.",
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  return {
    success: true,
    logs: `${projectName} was removed from EpicGlobal.\n`,
  };
}

export async function deployCodingStaticArtifact(
  snapshot: CodingWorkspaceSnapshot,
  archive: Uint8Array,
): Promise<CodingDeployment> {
  try {
    validateCodingStaticArtifact(archive);
  } catch (error) {
    throw new CodingDeploymentError(
      error instanceof Error ? error.message : "The static build artifact is invalid.",
      400,
    );
  }
  return withDeploymentLock(snapshot.workspace.id, async () => {
    const deployment = await createDeploymentRecord(snapshot, "static", {}, "deploying");
    return withDeploymentLock(`${deployment.workspaceId}:${deployment.id}`, () => (
      withDeploymentLock("epicglobal-static-upload", async () => {
        const current = await getCodingDeployment(deployment.workspaceId, deployment.id);
        if (!current || current.status !== "deploying") {
          throw new CodingDeploymentError("This static deployment was cancelled before upload.", 409, current ?? undefined);
        }
        try {
          return await uploadStaticArtifact(current, archive);
        } catch (error) {
          const latest = await getCodingDeployment(deployment.workspaceId, deployment.id);
          if (latest?.status === "active") {
            const message = error instanceof Error
              ? `The site is live, but deployment history could not be updated: ${error.message}`
              : "The site is live, but deployment history could not be updated.";
            console.error("[coding/deployments] Static site published but history update failed", error);
            throw new CodingDeploymentError(message, 500, latest);
          }
          const failed = updateDeployment(latest ?? current, {
            status: "failed",
            phase: "Failed",
            error: error instanceof Error ? error.message : "EpicGlobal upload failed.",
            logs: `${current.logs}[nexus] Static upload failed.\n`,
          });
          await saveCodingDeployment(failed);
          if (error instanceof CodingDeploymentError) {
            throw new CodingDeploymentError(error.message, error.status, failed);
          }
          console.error("[coding/deployments] Static upload failed", error);
          throw new CodingDeploymentError("EpicGlobal upload failed.", 502, failed);
        }
      })
    ));
  });
}

export async function withCodingStaticArtifactRequest<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withDeploymentLock("epicglobal-static-artifact-request", operation);
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
  if (!deployment.runnerJobId) {
    if (
      deployment.kind === "static"
      && Date.now() - Date.parse(deployment.updatedAt) > 10 * 60_000
    ) {
      deployment = updateDeployment(deployment, {
        status: "failed",
        phase: "Failed",
        error: "The browser upload did not finish. Start a new static deployment.",
      });
      await saveCodingDeployment(deployment);
    }
    return deployment;
  }

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
    const payload = deployment.kind === "static"
      ? await deleteEpicGlobalStaticProject(deployment.projectName)
      : await runnerRequest(`/projects/${encodeURIComponent(deployment.projectName)}/delete`, {
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
