import JSZip from "jszip";
import { z } from "zod";
import {
  CodingWorkspaceFileSchema,
  codingWorkspaceByteCount,
} from "@/lib/coding-workspace";

const CodingZipFilesSchema = z.array(CodingWorkspaceFileSchema).max(200).superRefine((files, context) => {
  const paths = new Set<string>();
  for (const [index, file] of files.entries()) {
    const path = file.name.replaceAll("\\", "/");
    if (/^[a-zA-Z]:\//.test(path) || /[\u0000-\u001f]/.test(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "name"],
        message: "ZIP file paths must not contain drive prefixes or control characters.",
      });
    }
    if (paths.has(path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "name"],
        message: "ZIP file paths must be unique.",
      });
    }
    paths.add(path);
  }
  if (codingWorkspaceByteCount(files) > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The project is too large to export.",
    });
  }
});

export async function createCodingWorkspaceZip(
  rawFiles: unknown,
  projectName: string,
): Promise<{ blob: Blob; filename: string }> {
  const parsed = CodingZipFilesSchema.safeParse(rawFiles);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Project files could not be validated for ZIP export.");
  }
  if (parsed.data.length === 0) throw new Error("This project has no files to export.");

  const zip = new JSZip();
  for (const file of parsed.data) {
    zip.file(file.name.replaceAll("\\", "/"), file.content);
  }
  const filenameBase = projectName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "nexus-code-project";
  return {
    blob: await zip.generateAsync({ type: "blob", compression: "DEFLATE" }),
    filename: `${filenameBase}.zip`,
  };
}
