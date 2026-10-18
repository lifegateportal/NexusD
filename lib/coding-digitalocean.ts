import { z } from "zod";
import { env } from "@/lib/env";

const DigitalOceanErrorSchema = z.object({
  message: z.string().min(1).max(1000).optional(),
}).passthrough();

const AppDeploymentSummarySchema = z.object({
  id: z.string().min(1).max(120),
}).passthrough();

const DigitalOceanAppSchema = z.object({
  id: z.string().min(1).max(120),
  live_url: z.string().nullable().optional(),
  default_ingress: z.string().nullable().optional(),
  spec: z.record(z.unknown()),
  pending_deployment: AppDeploymentSummarySchema.nullable().optional(),
  active_deployment: AppDeploymentSummarySchema.nullable().optional(),
}).passthrough();

const DigitalOceanAppResponseSchema = z.object({
  app: DigitalOceanAppSchema,
}).passthrough();

const DigitalOceanDeploymentSchema = z.object({
  id: z.string().min(1).max(120),
  phase: z.string().min(1).max(80),
  cause: z.string().max(1000).optional(),
}).passthrough();

const DigitalOceanDeploymentResponseSchema = z.object({
  deployment: DigitalOceanDeploymentSchema,
}).passthrough();

const DigitalOceanDeploymentListSchema = z.object({
  deployments: z.array(DigitalOceanDeploymentSchema).max(1000),
}).passthrough();

export class CodingDigitalOceanError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "CodingDigitalOceanError";
  }
}

function apiToken(): string {
  if (!env.DIGITALOCEAN_API_TOKEN) {
    throw new CodingDigitalOceanError("DigitalOcean deployments are not configured on the server.", 503);
  }
  return env.DIGITALOCEAN_API_TOKEN;
}

function appUrl(app: z.infer<typeof DigitalOceanAppSchema>): string | null {
  const candidate = app.live_url ?? app.default_ingress;
  if (!candidate) return null;
  try {
    const normalized = new URL(candidate.startsWith("https://") ? candidate : `https://${candidate}`);
    return normalized.protocol === "https:" ? normalized.toString() : null;
  } catch {
    return null;
  }
}

async function digitalOceanRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.digitalocean.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 204) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = DigitalOceanErrorSchema.safeParse(payload);
    const message = parsedError.success
      ? parsedError.data.message
      : undefined;
    throw new CodingDigitalOceanError(
      message ?? `DigitalOcean returned HTTP ${response.status}.`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  return payload;
}

export function codingImageRepository(workspaceId: string): string {
  return `nexus-${workspaceId.replace(/^cw-/, "").replaceAll("-", "").slice(0, 32)}`;
}

export function codingAppName(workspaceId: string): string {
  return `nexus-${workspaceId.replace(/^cw-/, "").replaceAll("-", "").slice(0, 24)}`;
}

export async function getDigitalOceanRegistryDockerConfig(): Promise<string> {
  if (!env.DIGITALOCEAN_REGISTRY_NAME) {
    throw new CodingDigitalOceanError("Set DIGITALOCEAN_REGISTRY_NAME to use DigitalOcean deployments.", 503);
  }
  const payload = await digitalOceanRequest(
    `/registries/${encodeURIComponent(env.DIGITALOCEAN_REGISTRY_NAME)}/docker-credentials?read_write=true&expiry_seconds=3600`,
    {
    method: "POST",
    },
  );
  const parsed = z.object({ docker_credentials: z.union([z.string(), z.record(z.unknown())]) }).safeParse(payload);
  if (!parsed.success) {
    throw new CodingDigitalOceanError("DigitalOcean returned invalid Container Registry credentials.");
  }
  const dockerConfig = typeof parsed.data.docker_credentials === "string"
    ? parsed.data.docker_credentials
    : JSON.stringify(parsed.data.docker_credentials);
  let config: unknown;
  try {
    config = JSON.parse(dockerConfig) as unknown;
  } catch {
    throw new CodingDigitalOceanError("DigitalOcean returned invalid Container Registry credentials.");
  }
  const parsedConfig = z.object({
    auths: z.record(z.unknown()).refine((auths) => Boolean(auths["registry.digitalocean.com"])),
  }).passthrough().safeParse(config);
  if (!parsedConfig.success) {
    throw new CodingDigitalOceanError("DigitalOcean returned credentials for an unexpected registry.");
  }
  return dockerConfig;
}

function appSpec(
  workspaceId: string,
  repository: string,
  tag: string,
) {
  return {
    name: codingAppName(workspaceId),
    region: env.DIGITALOCEAN_REGION,
    services: [{
      name: "web",
      image: {
        registry_type: "DOCR",
        repository,
        tag,
        deploy_on_push: { enabled: false },
      },
      instance_count: 1,
      instance_size_slug: "apps-s-1vcpu-1gb",
      http_port: 8080,
      envs: [{ key: "PORT", value: "8080", scope: "RUN_TIME" }],
    }],
  };
}

function deploymentIdFromApp(app: z.infer<typeof DigitalOceanAppSchema>): string | null {
  return app.pending_deployment?.id ?? app.active_deployment?.id ?? null;
}

export async function deployCodingImage(
  workspaceId: string,
  repository: string,
  tag: string,
  existingAppId: string | null,
): Promise<{ appId: string; deploymentId: string | null; url: string | null }> {
  if (!env.DIGITALOCEAN_REGISTRY_NAME) {
    throw new CodingDigitalOceanError("Set DIGITALOCEAN_REGISTRY_NAME to use DigitalOcean deployments.", 503);
  }

  if (!existingAppId) {
    const payload = await digitalOceanRequest("/apps", {
      method: "POST",
      body: JSON.stringify({ spec: appSpec(workspaceId, repository, tag) }),
    });
    const parsed = DigitalOceanAppResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[coding/deployments] DigitalOcean returned an invalid app creation response", parsed.error.issues);
      throw new CodingDigitalOceanError("DigitalOcean returned an invalid app creation response.");
    }
    return {
      appId: parsed.data.app.id,
      deploymentId: deploymentIdFromApp(parsed.data.app),
      url: appUrl(parsed.data.app),
    };
  }

  const currentPayload = await digitalOceanRequest(`/apps/${encodeURIComponent(existingAppId)}`);
  const current = DigitalOceanAppResponseSchema.safeParse(currentPayload);
  if (!current.success) {
    console.error("[coding/deployments] DigitalOcean returned invalid app data", current.error.issues);
    throw new CodingDigitalOceanError("DigitalOcean returned invalid app data.");
  }
  const services = z.array(z.record(z.unknown())).safeParse(current.data.app.spec.services);
  if (!services.success) {
    throw new CodingDigitalOceanError("The DigitalOcean app spec does not contain valid services.");
  }
  const webServiceIndex = services.data.findIndex((service) => service.name === "web");
  if (webServiceIndex < 0) {
    throw new CodingDigitalOceanError("The DigitalOcean app no longer has its Nexus web service.");
  }
  const currentImage = z.record(z.unknown()).safeParse(services.data[webServiceIndex].image);
  if (!currentImage.success) {
    throw new CodingDigitalOceanError("The DigitalOcean app image configuration is invalid.");
  }
  services.data[webServiceIndex] = {
    ...services.data[webServiceIndex],
    image: { ...currentImage.data, repository, tag },
  };
  const updatedSpec = { ...current.data.app.spec, services: services.data };
  const updatedPayload = await digitalOceanRequest(`/apps/${encodeURIComponent(existingAppId)}`, {
    method: "PUT",
    body: JSON.stringify({ spec: updatedSpec }),
  });
  const updated = DigitalOceanAppResponseSchema.safeParse(updatedPayload);
  if (!updated.success) {
    console.error("[coding/deployments] DigitalOcean returned invalid app update data", updated.error.issues);
    throw new CodingDigitalOceanError("DigitalOcean returned an invalid app update response.");
  }
  return {
    appId: updated.data.app.id,
    deploymentId: deploymentIdFromApp(updated.data.app),
    url: appUrl(updated.data.app),
  };
}

export async function getDigitalOceanAppDeployment(
  appId: string,
  deploymentId: string,
): Promise<{ phase: string; url: string | null }> {
  const [appPayload, deploymentPayload] = await Promise.all([
    digitalOceanRequest(`/apps/${encodeURIComponent(appId)}`),
    digitalOceanRequest(`/apps/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}`),
  ]);
  const app = DigitalOceanAppResponseSchema.safeParse(appPayload);
  if (!app.success) {
    console.error("[coding/deployments] DigitalOcean returned invalid app data", app.error.issues);
    throw new CodingDigitalOceanError("DigitalOcean returned invalid app data.");
  }
  const deployment = DigitalOceanDeploymentResponseSchema.safeParse(deploymentPayload);
  if (!deployment.success) {
    console.error("[coding/deployments] DigitalOcean returned invalid deployment data", deployment.error.issues);
    throw new CodingDigitalOceanError("DigitalOcean returned invalid deployment data.");
  }
  return {
    phase: deployment.data.deployment.phase,
    url: appUrl(app.data.app),
  };
}

export async function findLatestDigitalOceanDeployment(appId: string): Promise<string | null> {
  const payload = await digitalOceanRequest(`/apps/${encodeURIComponent(appId)}/deployments?per_page=1`);
  const parsed = DigitalOceanDeploymentListSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("[coding/deployments] DigitalOcean returned invalid deployment list", parsed.error.issues);
    throw new CodingDigitalOceanError("DigitalOcean returned invalid deployment data.");
  }
  return parsed.data.deployments[0]?.id ?? null;
}

export async function deleteDigitalOceanApp(appId: string): Promise<void> {
  await digitalOceanRequest(`/apps/${encodeURIComponent(appId)}`, { method: "DELETE" });
}
