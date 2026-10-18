import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceIdSchema,
  CodingWorkspaceFileSchema,
} from "@/lib/coding-workspace";

export const CodingDeploymentIdSchema = z.string().regex(/^dep-[a-z0-9-]{36}$/);
export const CodingProjectNameSchema = z.string().regex(/^nx-[a-z0-9-]{8,40}$/);

export const CodingDeploymentKindSchema = z.enum(["static", "fullstack"]);
export type CodingDeploymentKind = z.infer<typeof CodingDeploymentKindSchema>;

export const CodingDeploymentEnvironmentSchema = z.record(
  z.string(),
  z.string().max(8000).refine((value) => !/[\r\n\0]/.test(value), "Environment values must be single-line."),
).superRefine((values, context) => {
  if (Object.keys(values).length > 50) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "No more than 50 runtime variables are allowed." });
  }
  let bytes = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || ["PORT", "HOST", "NODE_ENV", "PATH", "HOME"].includes(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "Use a valid environment variable name that is not reserved by Nexus.",
      });
    }
    bytes += new TextEncoder().encode(`${key}=${value}`).length;
  }
  if (bytes > 32_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Runtime variables must total less than 32 KB." });
  }
});

export function parseCodingDeploymentEnvironmentText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (text.length > 40_000) throw new Error("Runtime variables must total less than 32 KB.");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Runtime variable line ${index + 1} must use KEY=value format.`);
    const key = line.slice(0, separator).trim();
    if (Object.hasOwn(values, key)) throw new Error(`Runtime variable ${key} is listed more than once.`);
    values[key] = line.slice(separator + 1);
  }
  const parsed = CodingDeploymentEnvironmentSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Runtime environment variables are invalid.");
  }
  return parsed.data;
}

export const CodingDeploymentRequestSchema = z.object({
  revisionId: CodingRevisionIdSchema,
  kind: CodingDeploymentKindSchema,
  environment: CodingDeploymentEnvironmentSchema.default({}),
  confirmDeployment: z.literal(true),
}).strict();

export const CodingDeploymentDeleteRequestSchema = z.object({
  confirmDeletion: z.literal(true),
}).strict();

export const CodingDeploymentSchema = z.object({
  id: CodingDeploymentIdSchema,
  workspaceId: CodingWorkspaceIdSchema,
  revisionId: CodingRevisionIdSchema,
  kind: CodingDeploymentKindSchema,
  runnerJobId: z.string().regex(/^build-[a-z0-9-]{36}$/).nullable(),
  projectName: CodingProjectNameSchema,
  url: z.string().url().nullable(),
  status: z.enum(["queued", "building", "deploying", "active", "failed", "stopped"]),
  phase: z.string().max(80).nullable(),
  logs: z.string().max(1_000_000),
  error: z.string().max(1000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type CodingDeployment = z.infer<typeof CodingDeploymentSchema>;

export const CodingDeploymentResponseSchema = z.object({
  deployment: CodingDeploymentSchema,
}).strict();

export const CodingDeploymentListResponseSchema = z.object({
  deployments: z.array(CodingDeploymentSchema).max(100),
}).strict();

export const CodingBuildRequestSchema = z.object({
  id: CodingDeploymentIdSchema,
  workspaceId: CodingWorkspaceIdSchema,
  revisionId: CodingRevisionIdSchema,
  kind: CodingDeploymentKindSchema,
  projectName: CodingProjectNameSchema,
  environment: CodingDeploymentEnvironmentSchema,
  epicGlobalApiUrl: z.string().url(),
  epicGlobalApiKey: z.string().min(1).max(500),
  files: z.array(CodingWorkspaceFileSchema).max(200),
}).strict();

export const CodingBuildSchema = z.object({
  id: z.string().regex(/^build-[a-z0-9-]{36}$/),
  deploymentId: CodingDeploymentIdSchema,
  status: z.enum(["queued", "building", "deploying", "completed", "failed"]),
  phase: z.string().max(80).nullable(),
  url: z.string().url().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const CodingBuildResponseSchema = z.object({
  build: CodingBuildSchema,
  logs: z.string().max(1_000_000),
  error: z.string().max(1000).nullable(),
}).strict();

export const CodingProjectDeleteResponseSchema = z.object({
  success: z.literal(true),
  logs: z.string().max(1_000_000),
}).strict();
