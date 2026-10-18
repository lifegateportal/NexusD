import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceIdSchema,
  CodingWorkspaceFileSchema,
} from "@/lib/coding-workspace";

export const CodingDeploymentIdSchema = z.string().regex(/^dep-[a-z0-9-]{36}$/);

export const CodingDeploymentRequestSchema = z.object({
  revisionId: CodingRevisionIdSchema,
  confirmBilling: z.literal(true),
}).strict();

export const CodingDeploymentDeleteRequestSchema = z.object({
  confirmDeletion: z.literal(true),
}).strict();

export const CodingDeploymentSchema = z.object({
  id: CodingDeploymentIdSchema,
  workspaceId: CodingWorkspaceIdSchema,
  revisionId: CodingRevisionIdSchema,
  runnerJobId: z.string().regex(/^build-[a-z0-9-]{36}$/).nullable(),
  appId: z.string().min(1).max(120).nullable(),
  appDeploymentId: z.string().min(1).max(120).nullable(),
  appName: z.string().min(2).max(32),
  imageRepository: z.string().min(1).max(63),
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
  registry: z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
  repository: z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
  tag: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/),
  dockerConfig: z.string().min(1).max(50_000),
  files: z.array(CodingWorkspaceFileSchema).max(200),
}).strict();

export const CodingBuildSchema = z.object({
  id: z.string().regex(/^build-[a-z0-9-]{36}$/),
  deploymentId: CodingDeploymentIdSchema,
  status: z.enum(["queued", "building", "completed", "failed"]),
  image: z.string().max(300).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const CodingBuildResponseSchema = z.object({
  build: CodingBuildSchema,
  logs: z.string().max(1_000_000),
  error: z.string().max(1000).nullable(),
}).strict();
