import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceIdSchema,
} from "@/lib/coding-workspace";

export const CodingGitHubRepositorySchema = z.object({
  fullName: z.string().min(1).max(200),
  private: z.boolean(),
  defaultBranch: z.string().max(255).nullable(),
}).strict();

export const CodingGitHubRepositoriesResponseSchema = z.object({
  connected: z.boolean(),
  login: z.string().max(100).nullable(),
  repositories: z.array(CodingGitHubRepositorySchema).max(1000),
}).strict();

export const CodingGitHubPublishRequestSchema = z.object({
  workspaceId: CodingWorkspaceIdSchema,
  revisionId: CodingRevisionIdSchema,
  repository: z.string().min(3).max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
  message: z.string().trim().min(1).max(200),
}).strict();

export const CodingGitHubPublishResponseSchema = z.object({
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(255),
  commitUrl: z.string().url(),
  fileCount: z.number().int().nonnegative(),
}).strict();
