import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceFileSchema,
  CodingWorkspaceIdSchema,
} from "@/lib/coding-workspace";

export const CodingModeSchema = z.enum(["ask", "plan", "code"]);
export type CodingMode = z.infer<typeof CodingModeSchema>;

export const CodingAgentSchema = z.enum(["deepseek-chat", "deepseek-reasoner"]);
export type CodingAgent = z.infer<typeof CodingAgentSchema>;

export const CodingFileSchema = CodingWorkspaceFileSchema;

export type CodingFile = z.infer<typeof CodingFileSchema>;

export const CodingHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(120_000),
}).strict();

export const CodingWorkbenchContextSchema = z.object({
  projectName: z.string().max(120).default(""),
  workspaceStatus: z.string().max(100).default(""),
  activeSurface: z.enum(["assistant", "editor"]).default("assistant"),
  fileExplorerOpen: z.boolean().default(false),
  previewPanelOpen: z.boolean().default(false),
  selectedFileName: z.string().max(512).nullable().default(null),
  explorerPaths: z.array(z.string().max(512)).max(200).default([]),
  previewRuntime: z.enum(["webcontainer", "runner"]).default("webcontainer"),
  runtimeStatus: z.enum(["stopped", "starting", "installing", "ready", "running", "failed"]).default("stopped"),
  previewUrl: z.string().max(2048).nullable().default(null),
  terminalOutput: z.string().max(30_000).default(""),
}).strict();

export const CodingChatRequestSchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  mode: CodingModeSchema.default("ask"),
  agent: CodingAgentSchema.default("deepseek-chat"),
  workspaceId: CodingWorkspaceIdSchema.optional(),
  revisionId: CodingRevisionIdSchema.optional(),
  history: z.array(CodingHistoryMessageSchema).max(20).default([]),
  files: z.array(CodingFileSchema).max(200).default([]),
  workbench: CodingWorkbenchContextSchema.default({}),
}).superRefine((value, context) => {
  const totalCharacters = value.files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalCharacters > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "Attached code is too large. Keep the total under 4 million characters.",
    });
  }
});

export type CodingChatRequest = z.infer<typeof CodingChatRequestSchema>;

export const CodingStoredMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.string(),
  fileNames: z.array(z.string()).default([]),
}).strict();

export type CodingStoredMessage = z.infer<typeof CodingStoredMessageSchema>;

export const CodingChatArchiveSchema = z.object({
  messages: z.array(CodingStoredMessageSchema),
  updatedAt: z.string(),
}).strict();

export type CodingChatArchive = z.infer<typeof CodingChatArchiveSchema>;

export const CODING_MODE_LABELS: Record<CodingMode, { label: string; description: string }> = {
  ask: { label: "Ask", description: "Answer and infer the requested coding task." },
  plan: { label: "Plan", description: "Design the implementation before coding." },
  code: { label: "Code", description: "Implement the requested change." },
};
