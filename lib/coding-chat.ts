import { z } from "zod";
import {
  CodingRevisionIdSchema,
  CodingWorkspaceFileSchema,
  CodingWorkspaceIdSchema,
} from "@/lib/coding-workspace";

export const CodingModeSchema = z.enum(["ask", "plan", "code"]);
export type CodingMode = z.infer<typeof CodingModeSchema>;

export const CodingContextStrategySchema = z.enum(["full", "focused"]);
export type CodingContextStrategy = z.infer<typeof CodingContextStrategySchema>;
export const CodingContextScopeHeaderSchema = z.string().regex(/^\d{1,3}\/\d{1,3}$/);

export const CodingAgentSchema = z.enum(["deepseek-chat", "deepseek-reasoner", "deepseek-flash"]);
export type CodingAgent = z.infer<typeof CodingAgentSchema>;

export const CODING_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const MAX_CODING_IMAGES = 4;
export const MAX_CODING_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CODING_IMAGES_BASE64_CHARACTERS = 8 * 1024 * 1024;

const MAX_CODING_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_CODING_IMAGE_BYTES / 3) * 4;
const CodingImageBase64Schema = z.string()
  .min(4)
  .max(MAX_CODING_IMAGE_BASE64_CHARACTERS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const CodingChatImageSchema = z.object({
  name: z.string().trim().min(1).max(240),
  mediaType: z.enum(CODING_IMAGE_MEDIA_TYPES),
  data: CodingImageBase64Schema,
}).strict();

export type CodingChatImage = z.infer<typeof CodingChatImageSchema>;

export const CodingFileSchema = CodingWorkspaceFileSchema;

export type CodingFile = z.infer<typeof CodingFileSchema>;

export const MAX_CODING_HISTORY_MESSAGE_CHARACTERS = 120_000;
export const CODING_PARTIAL_RESPONSE_MARKER =
  "\n\n> **Partial response.** Use “Continue response” to pick up from here.";

export const CodingHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_CODING_HISTORY_MESSAGE_CHARACTERS),
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
  contextStrategy: CodingContextStrategySchema.default("full"),
  agent: CodingAgentSchema.default("deepseek-chat"),
  workspaceId: CodingWorkspaceIdSchema.optional(),
  revisionId: CodingRevisionIdSchema.optional(),
  history: z.array(CodingHistoryMessageSchema).max(20).default([]),
  attachedFileNames: z.array(z.string().trim().min(1).max(240)).max(200).default([]),
  files: z.array(CodingFileSchema).max(200).default([]),
  images: z.array(CodingChatImageSchema).max(MAX_CODING_IMAGES).default([]),
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
  const totalImageCharacters = value.images.reduce((sum, image) => sum + image.data.length, 0);
  if (totalImageCharacters > MAX_CODING_IMAGES_BASE64_CHARACTERS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["images"],
      message: "Attached images are too large. Keep their combined encoded size at or below 8 MB.",
    });
  }
  if (value.images.length > 0 && value.agent !== "deepseek-flash") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agent"],
      message: "Image attachments require the DeepSeek Vision model.",
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

export const CodingChatThreadSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(120),
  messages: z.array(CodingStoredMessageSchema).max(80),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
}).strict();

export type CodingChatThread = z.infer<typeof CodingChatThreadSchema>;

export const CodingChatHistorySchema = z.object({
  version: z.literal(1),
  activeThreadId: z.string().min(1).max(100),
  threads: z.array(CodingChatThreadSchema).min(1).max(20),
  updatedAt: z.string().max(100),
}).strict().superRefine((history, context) => {
  const threadIds = new Set(history.threads.map((thread) => thread.id));
  if (threadIds.size !== history.threads.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["threads"],
      message: "Chat history thread ids must be unique.",
    });
  }
  if (!threadIds.has(history.activeThreadId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeThreadId"],
      message: "The active chat thread must exist in history.",
    });
  }
});

export type CodingChatHistory = z.infer<typeof CodingChatHistorySchema>;

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
