import { z } from "zod";

const CODING_WORKSPACE_ID_PATTERN = /^cw-[a-z0-9-]{8,80}$/;
const CODING_REVISION_ID_PATTERN = /^cr-[a-z0-9-]{8,100}$/;

export const CodingWorkspaceIdSchema = z.string().regex(
  CODING_WORKSPACE_ID_PATTERN,
  "Invalid coding workspace id.",
);

export const CodingRevisionIdSchema = z.string().regex(
  CODING_REVISION_ID_PATTERN,
  "Invalid coding revision id.",
);

export const CodingWorkspaceFileSchema = z.object({
  name: z.string().trim().min(1).max(240),
  content: z.string().max(500_000),
  language: z.string().trim().max(40).optional(),
}).strict().superRefine((file, context) => {
  const normalized = file.name.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.split("/").some((segment) => segment === "." || segment === "..")
    || normalized.includes("//")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Coding file paths must be relative and normalized.",
    });
  }
});

export type CodingWorkspaceFile = z.infer<typeof CodingWorkspaceFileSchema>;

export const CodingFilePatchSchema = z.object({
  name: z.string().trim().min(1).max(240),
  search: z.string().min(1).max(500_000),
  replace: z.string().max(500_000),
}).strict().superRefine((patch, context) => {
  const normalized = normalizeCodingFilePath(patch.name);
  if (!normalized || normalized !== patch.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Coding patch paths must be relative and normalized.",
    });
  }
});

export type CodingFilePatch = z.infer<typeof CodingFilePatchSchema>;

export function codingLanguageFromName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  const languages: Record<string, string> = {
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension];
}

export function normalizeCodingFilePath(rawPath: string): string | null {
  const segments = rawPath
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..");
  const normalized = segments.join("/");
  return normalized && normalized.length <= 240 ? normalized : null;
}

export function extractCodingFiles(content: string): CodingWorkspaceFile[] {
  const pattern = /```nexus-file\s+path=(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*\n([\s\S]*?)```/gi;
  const generated: CodingWorkspaceFile[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = normalizeCodingFilePath(match[1] ?? match[2] ?? match[3] ?? "");
    if (!name) continue;
    const parsed = CodingWorkspaceFileSchema.safeParse({
      name,
      content: match[4],
      language: codingLanguageFromName(name),
    });
    if (parsed.success) generated.push(parsed.data);
  }
  return generated;
}

export function extractCodingPatches(content: string): CodingFilePatch[] {
  const pattern = /```nexus-patch\s+path=(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*\n([\s\S]*?)```/gi;
  const patchSections = new RegExp(
    `${"<".repeat(7)} SEARCH\n([\\s\\S]*?)\n${"=".repeat(7)}\n([\\s\\S]*?)\n${">".repeat(7)} REPLACE\\s*$`,
  );
  const patches: CodingFilePatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = normalizeCodingFilePath(match[1] ?? match[2] ?? match[3] ?? "");
    const body = match[4] ?? "";
    const sections = body.match(patchSections);
    if (!name || !sections) continue;
    const parsed = CodingFilePatchSchema.safeParse({
      name,
      search: sections[1],
      replace: sections[2],
    });
    if (parsed.success) patches.push(parsed.data);
  }
  return patches;
}

export function applyCodingPatches(
  files: CodingWorkspaceFile[],
  patches: CodingFilePatch[],
): CodingWorkspaceFile[] {
  const updated = new Map(files.map((file) => [file.name, file]));
  for (const patch of patches) {
    const file = updated.get(patch.name);
    if (!file) throw new Error(`Cannot apply patch: ${patch.name} is not in the workspace.`);
    const firstIndex = file.content.indexOf(patch.search);
    if (firstIndex < 0) {
      throw new Error(`Cannot apply patch: search text was not found in ${patch.name}.`);
    }
    if (file.content.indexOf(patch.search, firstIndex + patch.search.length) >= 0) {
      throw new Error(`Cannot apply patch: search text is ambiguous in ${patch.name}.`);
    }
    updated.set(patch.name, {
      ...file,
      content: `${file.content.slice(0, firstIndex)}${patch.replace}${file.content.slice(firstIndex + patch.search.length)}`,
    });
  }
  return Array.from(updated.values());
}

export const CodingWorkspaceSchema = z.object({
  id: CodingWorkspaceIdSchema,
  name: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentRevisionId: CodingRevisionIdSchema,
  revisionNumber: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
}).strict();

export type CodingWorkspace = z.infer<typeof CodingWorkspaceSchema>;

export const CodingWorkspaceRevisionSchema = z.object({
  id: CodingRevisionIdSchema,
  workspaceId: CodingWorkspaceIdSchema,
  number: z.number().int().positive(),
  parentRevisionId: CodingRevisionIdSchema.nullable(),
  createdAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(400),
  source: z.enum(["user", "agent", "import", "revert"]),
  files: z.array(CodingWorkspaceFileSchema).max(200),
  byteCount: z.number().int().nonnegative(),
}).strict();

export type CodingWorkspaceRevision = z.infer<typeof CodingWorkspaceRevisionSchema>;

export const CodingWorkspaceSnapshotSchema = z.object({
  workspace: CodingWorkspaceSchema,
  revision: CodingWorkspaceRevisionSchema,
}).strict();

export type CodingWorkspaceSnapshot = z.infer<typeof CodingWorkspaceSnapshotSchema>;

export const CodingWorkspaceSummarySchema = CodingWorkspaceSchema;
export type CodingWorkspaceSummary = CodingWorkspace;

export const CreateCodingWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80).default("Nexus Code Workspace"),
  files: z.array(CodingWorkspaceFileSchema).max(200).default([]),
}).strict().superRefine((value, context) => {
  if (codingWorkspaceByteCount(value.files) > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "Workspace files are too large. Keep the total under 4 million bytes.",
    });
  }
});

export type CreateCodingWorkspace = z.infer<typeof CreateCodingWorkspaceSchema>;

export const SaveCodingRevisionSchema = z.object({
  baseRevisionId: CodingRevisionIdSchema.nullable(),
  files: z.array(CodingWorkspaceFileSchema).max(200),
  reason: z.string().trim().min(1).max(400),
  source: z.enum(["user", "agent", "import", "revert"]).default("user"),
}).strict().superRefine((value, context) => {
  const byteCount = codingWorkspaceByteCount(value.files);
  if (byteCount > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "Workspace files are too large. Keep the total under 4 million bytes.",
    });
  }
});

export type SaveCodingRevision = z.infer<typeof SaveCodingRevisionSchema>;

export const RevertCodingWorkspaceSchema = z.object({
  revisionId: CodingRevisionIdSchema,
}).strict();

export const CodingRunRequestSchema = z.object({
  command: z.string().trim().min(1).max(500),
  revisionId: CodingRevisionIdSchema,
  network: z.boolean().default(false),
}).strict();

export type CodingRunRequest = z.infer<typeof CodingRunRequestSchema>;

export const CodingRunSchema = z.object({
  id: z.string().min(1).max(120),
  workspaceId: CodingWorkspaceIdSchema,
  revisionId: CodingRevisionIdSchema,
  command: z.string().trim().min(1).max(500),
  status: z.enum(["queued", "running", "completed", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  previewUrl: z.string().url().nullable(),
}).strict();

export type CodingRun = z.infer<typeof CodingRunSchema>;

const CodingAgentEventBaseSchema = z.object({
  runId: z.string().min(1).max(120),
  workspaceId: CodingWorkspaceIdSchema,
  createdAt: z.string().datetime(),
}).strict();

export const CodingAgentEventSchema = z.discriminatedUnion("type", [
  CodingAgentEventBaseSchema.extend({
    type: z.literal("run.started"),
    mode: z.enum(["ask", "plan", "code"]),
    agent: z.enum(["deepseek-chat", "deepseek-reasoner"]),
  }),
  CodingAgentEventBaseSchema.extend({
    type: z.literal("files.proposed"),
    files: z.array(CodingWorkspaceFileSchema).max(200),
    reason: z.string().trim().min(1).max(400),
  }),
  CodingAgentEventBaseSchema.extend({
    type: z.literal("run.completed"),
    revisionId: CodingRevisionIdSchema.nullable(),
    outputCharacters: z.number().int().nonnegative(),
  }),
  CodingAgentEventBaseSchema.extend({
    type: z.literal("run.failed"),
    message: z.string().trim().min(1).max(500),
  }),
]);

export type CodingAgentEvent = z.infer<typeof CodingAgentEventSchema>;

export function makeCodingWorkspaceId(): string {
  return `cw-${crypto.randomUUID()}`;
}

export function makeCodingRevisionId(): string {
  return `cr-${crypto.randomUUID()}`;
}

export function codingWorkspaceByteCount(files: CodingWorkspaceFile[]): number {
  return files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0);
}
