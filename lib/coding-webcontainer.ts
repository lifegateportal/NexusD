import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import { z } from "zod";
import { CodingWorkspaceFileSchema } from "@/lib/coding-workspace";

const CodingWebContainerFilesSchema = z.array(CodingWorkspaceFileSchema).max(200).superRefine((files, context) => {
  const names = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    if (names.has(file.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "name"],
        message: `Duplicate coding file: ${file.name}`,
      });
    }
    names.add(file.name);
    totalBytes += new TextEncoder().encode(file.content).byteLength;
    if (totalBytes > 4_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "content"],
        message: "Workspace files are too large. Keep the total under 4 million bytes.",
      });
      return;
    }
  }
});

export const CodingWebContainerStatusSchema = z.enum([
  "stopped",
  "starting",
  "installing",
  "running",
  "failed",
]);

export const CodingPreviewRuntimeSchema = z.enum(["webcontainer", "runner"]);

export const CodingWebContainerCommandSchema = z.string().trim().min(1).max(500).refine(
  (command) => !command.includes("\0"),
  "Commands cannot contain null characters.",
);

export const CodingWebContainerReadySchema = z.object({
  port: z.number().int().min(1).max(65535),
  url: z.string().url().refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Preview URLs must use HTTP or HTTPS.",
  ),
}).strict();

export const CodingWebContainerOutputSchema = z.string().max(100_000);

export type CodingWebContainerStatus = z.infer<typeof CodingWebContainerStatusSchema>;

let webContainerPromise: Promise<WebContainer> | null = null;

export function createCodingWebContainerFileTree(input: unknown): FileSystemTree {
  const files = CodingWebContainerFilesSchema.parse(input);
  const tree: FileSystemTree = Object.create(null) as FileSystemTree;

  for (const file of files) {
    const segments = file.name.replaceAll("\\", "/").split("/");
    let directory = tree;
    for (const segment of segments.slice(0, -1)) {
      const existing = directory[segment];
      if (existing && !("directory" in existing)) {
        throw new Error(`A file conflicts with the folder path ${segment}.`);
      }
      if (!existing) {
        Object.defineProperty(directory, segment, {
          value: { directory: Object.create(null) as FileSystemTree },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      const node = directory[segment];
      if (!node || !("directory" in node)) {
        throw new Error(`Could not create the folder path ${segment}.`);
      }
      directory = node.directory;
    }

    const fileName = segments.at(-1);
    if (!fileName || Object.hasOwn(directory, fileName)) {
      throw new Error(`Duplicate or conflicting coding file: ${file.name}`);
    }
    Object.defineProperty(directory, fileName, {
      value: { file: { contents: file.content } },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return tree;
}

export async function bootCodingWebContainer(): Promise<WebContainer> {
  if (!webContainerPromise) {
    webContainerPromise = import("@webcontainer/api")
      .then(({ WebContainer: WebContainerRuntime }) => WebContainerRuntime.boot({ coep: "require-corp" }))
      .catch((error: unknown) => {
        webContainerPromise = null;
        throw error;
      });
  }
  return webContainerPromise;
}

export async function teardownCodingWebContainer(): Promise<void> {
  const current = webContainerPromise;
  webContainerPromise = null;
  if (!current) return;
  const runtime = await current;
  runtime.teardown();
}
