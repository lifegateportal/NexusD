import JSZip from "jszip";
import { z } from "zod";
import {
  CodingWorkspaceFileSchema,
  codingWorkspaceByteCount,
  codingLanguageFromName,
} from "@/lib/coding-workspace";
import { isCodingEnvironmentFile } from "@/lib/coding-static-policy";

const MAX_ZIP_IMPORT_SIZE = 25_000_000;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_WORKSPACE_FILES = 200;
const MAX_WORKSPACE_BYTES = 4_000_000;
const MAX_FILE_BYTES = 500_000;

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

function isIgnoredProjectPath(path: string): boolean {
  return path.split("/").some((segment) => [
    ".git",
    ".next",
    ".turbo",
    ".cache",
    "node_modules",
    "coverage",
    "dist",
    "build",
  ].includes(segment));
}

function validateArchivePath(entry: JSZip.JSZipObject): string {
  const original = entry.unsafeOriginalName ?? entry.name;
  const path = original.replaceAll("\\", "/");
  const normalized = entry.dir ? path.replace(/\/+$/, "") : path;
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-zA-Z]:/.test(normalized)
    || /[\u0000-\u001f]/.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name)
  ) {
    throw new Error("The ZIP contains an unsafe or non-normalized project path.");
  }
  return normalized;
}

function archiveEntrySize(entry: JSZip.JSZipObject): number {
  const data = (entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: number };
  })._data;
  if (!data || !Number.isSafeInteger(data.uncompressedSize) || data.uncompressedSize! < 0) {
    throw new Error(`The ZIP entry "${entry.name}" has no verifiable uncompressed size.`);
  }
  return data.uncompressedSize!;
}

export async function readCodingWorkspaceZip(file: File): Promise<{
  files: z.infer<typeof CodingWorkspaceFileSchema>[];
  localEnvironment: string | null;
}> {
  if (file.size > MAX_ZIP_IMPORT_SIZE) {
    throw new Error("Choose a project ZIP smaller than 25 MB.");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("The selected project is not a readable ZIP archive.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`The ZIP contains more than ${MAX_ZIP_ENTRIES} entries.`);
  }

  const candidates = entries
    .map((entry) => {
      const path = validateArchivePath(entry);
      const mode = typeof entry.unixPermissions === "number"
        ? entry.unixPermissions
        : Number.parseInt(entry.unixPermissions ?? "0", 8);
      if (!Number.isSafeInteger(mode) || mode < 0) {
        throw new Error(`The ZIP contains invalid permissions for ${path}.`);
      }
      const fileType = mode & 0o170000;
      const supportedType = fileType === 0
        || (entry.dir ? fileType === 0o040000 : fileType === 0o100000);
      if (fileType === 0o120000 || !supportedType) {
        throw new Error(`The ZIP contains an unsupported file type: ${path}`);
      }
      return { entry, path };
    })
    .filter(({ entry, path }) => !entry.dir && !isIgnoredProjectPath(path));

  const paths = candidates.map(({ path }) => path);
  const rootNames = new Set(paths.map((path) => path.split("/")[0]));
  const hasRootFiles = paths.some((path) => !path.includes("/"));
  const stripRoot = !hasRootFiles && rootNames.size === 1
    && paths.every((path) => path.includes("/"));
  const rootName = stripRoot ? paths[0]?.split("/")[0] : undefined;
  const files: z.infer<typeof CodingWorkspaceFileSchema>[] = [];
  const seen = new Set<string>();
  let localEnvironment: string | null = null;
  let totalWorkspaceBytes = 0;

  for (const { entry, path } of candidates) {
    const name = stripRoot && rootName ? path.slice(rootName.length + 1) : path;
    const baseName = name.split("/").at(-1) ?? name;
    const isLocalEnvironment = name === ".env.local";
    if (isCodingEnvironmentFile(baseName) && !isLocalEnvironment) {
      throw new Error(`Remove ${name} from the ZIP. Only .env.local can be imported as a device-local file.`);
    }
    if (isLocalEnvironment && localEnvironment !== null) {
      throw new Error("The ZIP contains more than one root .env.local file.");
    }
    if (!isLocalEnvironment && files.length >= MAX_WORKSPACE_FILES) {
      throw new Error(`The project has more than ${MAX_WORKSPACE_FILES} source files.`);
    }

    const uncompressedSize = archiveEntrySize(entry);
    if (uncompressedSize > MAX_FILE_BYTES) {
      throw new Error(`${name} exceeds the 500 KB per-file limit.`);
    }
    if (isLocalEnvironment) {
      if (name !== ".env.local") {
        throw new Error("Only a root .env.local file can be imported as device-local data.");
      }
    } else {
      totalWorkspaceBytes += uncompressedSize;
      if (totalWorkspaceBytes > MAX_WORKSPACE_BYTES) {
        throw new Error("The project ZIP expands beyond the 4 MB workspace limit.");
      }
    }
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength !== uncompressedSize) {
      throw new Error(`The ZIP entry "${name}" did not match its declared size.`);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${name} is not UTF-8 text. Binary assets are not supported by this workspace importer.`);
    }

    if (isLocalEnvironment) {
      localEnvironment = content;
      continue;
    }

    if (seen.has(name)) throw new Error(`The ZIP contains a duplicate project path: ${name}`);
    seen.add(name);
    const parsed = CodingWorkspaceFileSchema.safeParse({
      name,
      content,
      language: codingLanguageFromName(name),
    });
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? `The ZIP entry "${name}" is invalid.`);
    }
    files.push(parsed.data);
  }

  if (files.length === 0) throw new Error("The ZIP does not contain any supported project source files.");
  if (codingWorkspaceByteCount(files) > MAX_WORKSPACE_BYTES) {
    throw new Error("The project ZIP expands beyond the 4 MB workspace limit.");
  }

  const fileNames = new Set(files.map((file) => file.name));
  for (const name of fileNames) {
    const segments = name.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (fileNames.has(segments.slice(0, index).join("/"))) {
        throw new Error(`The ZIP has a file/folder path conflict at ${name}.`);
      }
    }
    if (Array.from(fileNames).some((other) => other.startsWith(`${name}/`))) {
      throw new Error(`The ZIP has a file/folder path conflict at ${name}.`);
    }
  }

  return { files, localEnvironment };
}
