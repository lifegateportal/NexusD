import { z } from "zod";

export const CodingModeSchema = z.enum(["ask", "plan", "code"]);
export type CodingMode = z.infer<typeof CodingModeSchema>;

export const CodingAgentSchema = z.enum(["deepseek-chat", "deepseek-reasoner"]);
export type CodingAgent = z.infer<typeof CodingAgentSchema>;

export const CodingFileSchema = z.object({
  name: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(500_000),
  language: z.string().trim().max(40).optional(),
}).strict();

export type CodingFile = z.infer<typeof CodingFileSchema>;

export const CodingHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
}).strict();

export const CodingChatRequestSchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  mode: CodingModeSchema.default("ask"),
  agent: CodingAgentSchema.default("deepseek-chat"),
  history: z.array(CodingHistoryMessageSchema).max(20).default([]),
  files: z.array(CodingFileSchema).max(12).default([]),
}).superRefine((value, context) => {
  const totalCharacters = value.files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalCharacters > 2_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "Attached code is too large. Keep the total under 2 million characters.",
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
