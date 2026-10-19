"use client";

import JSZip from "jszip";
import { z } from "zod";
import {
  CodingWorkspaceFileSchema,
  type CodingWorkspaceFile,
} from "@/lib/coding-workspace";
import {
  bootCodingWebContainer,
  createCodingWebContainerFileTree,
  withCodingWebContainerTimeout,
} from "@/lib/coding-webcontainer";
import {
  isCodingStaticSensitivePath,
  MAX_CODING_STATIC_ARCHIVE_BYTES,
  MAX_CODING_STATIC_OUTPUT_BYTES,
  MAX_CODING_STATIC_ENTRY_COUNT,
  MAX_CODING_STATIC_PATH_BYTES,
  MAX_CODING_STATIC_SEGMENT_BYTES,
} from "@/lib/coding-static-policy";
import type { DirEnt, WebContainer } from "@webcontainer/api";

const StaticBuildFilesSchema = z.array(CodingWorkspaceFileSchema).max(200).superRefine((files, context) => {
  const names = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    if (names.has(file.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "name"], message: "Duplicate project file paths are not allowed." });
    }
    names.add(file.name);
    totalBytes += new TextEncoder().encode(file.content).byteLength;
    if (totalBytes > 4_000_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "content"], message: "Project source must stay under 4 MB." });
      return;
    }
  }
});

const StaticPackageSchema = z.object({
  scripts: z.object({ build: z.string().trim().min(1).optional() }).passthrough().optional(),
}).passthrough();

const DISALLOWED_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml"];
const OUTPUT_DIRECTORIES = ["dist", "build", "out", "public"];
const SKIPPED_OUTPUT_DIRECTORIES = new Set([".git", ".next", "node_modules"]);

type StaticOutputFile = { name: string; content: Uint8Array };
type StaticBuildOptions = {
  onProgress?: (message: string) => void;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
};

function isSensitiveStaticFile(name: string): boolean {
  return isCodingStaticSensitivePath(name);
}

function validateArchivePath(name: string): void {
  const segments = name.replaceAll("\\", "/").split("/");
  if (
    !name
    || name.startsWith("/")
    || name.includes("\\")
    || name.includes(":")
    || /[\u0000-\u001f\u007f]/.test(name)
    || /^[a-zA-Z]:/.test(name)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("The static build contains an unsafe output path.");
  }
  const encoder = new TextEncoder();
  if (
    encoder.encode(name).byteLength > MAX_CODING_STATIC_PATH_BYTES
    || segments.some((segment) => encoder.encode(segment).byteLength > MAX_CODING_STATIC_SEGMENT_BYTES)
  ) {
    throw new Error("The static build contains a path that is too long.");
  }
  if (isSensitiveStaticFile(name)) throw new Error("Remove credentials and private key files before deploying.");
}

async function createStaticArchive(files: StaticOutputFile[]): Promise<Blob> {
  if (files.length === 0) throw new Error("The static project contains no files to publish.");
  if (files.length > MAX_CODING_STATIC_ENTRY_COUNT) {
    throw new Error("Static output contains too many files to publish.");
  }
  const seen = new Set<string>();
  const archivePaths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    validateArchivePath(file.name);
    if (seen.has(file.name)) throw new Error("The static output contains duplicate file paths.");
    seen.add(file.name);
    const segments = file.name.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      archivePaths.add(`${segments.slice(0, index).join("/")}/`);
    }
    archivePaths.add(file.name);
    totalBytes += file.content.byteLength;
    if (totalBytes > MAX_CODING_STATIC_OUTPUT_BYTES) {
      throw new Error("Built static files must total less than 50 MB when unpacked.");
    }
  }
  if (archivePaths.size > MAX_CODING_STATIC_ENTRY_COUNT) {
    throw new Error("Static output contains too many files and folders to publish.");
  }
  if (!seen.has("index.html")) throw new Error("The static output must contain index.html at its root.");

  const archive = new JSZip();
  for (const file of files) archive.file(file.name, file.content);
  const blob = await archive.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });
  if (blob.size > MAX_CODING_STATIC_ARCHIVE_BYTES) {
    throw new Error("The built static ZIP must be smaller than 25 MB.");
  }
  return blob;
}

function selectPlainStaticFiles(files: CodingWorkspaceFile[]): StaticOutputFile[] {
  const publicIndex = files.some((file) => file.name === "public/index.html");
  const rootIndex = files.some((file) => file.name === "index.html");
  const prefix = publicIndex ? "public/" : "";
  if (!publicIndex && !rootIndex) {
    throw new Error("Static deployment needs a root index.html or a package.json build script.");
  }
  return files.flatMap((file) => {
    const path = file.name.replaceAll("\\", "/");
    if (prefix && !path.startsWith(prefix)) return [];
    const name = prefix ? path.slice(prefix.length) : path;
    if (
      !name
      || name.split("/").some((segment) => SKIPPED_OUTPUT_DIRECTORIES.has(segment))
    ) return [];
    return [{ name, content: new TextEncoder().encode(file.content) }];
  });
}

function fileExists(entries: DirEnt<string>[], name: string): boolean {
  return entries.some((entry) => entry.name === name && entry.isFile());
}

async function readOutputFiles(
  runtime: WebContainer,
  root: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<StaticOutputFile[]> {
  const files: StaticOutputFile[] = [];
  let totalBytes = 0;
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    if (signal?.aborted) throw new Error("Static deployment was cancelled.");
    const entries = await runtime.fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_OUTPUT_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateArchivePath(relativePath);
      if (entry.isDirectory()) {
        await walk(`${directory}/${entry.name}`, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error("The static build output must not contain symbolic links.");
      if (files.length >= MAX_CODING_STATIC_ENTRY_COUNT) {
        throw new Error("Static output contains too many files to publish.");
      }
      const content = await runtime.fs.readFile(`${directory}/${entry.name}`);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_CODING_STATIC_OUTPUT_BYTES) {
        throw new Error("Built static files must total less than 50 MB when unpacked.");
      }
      files.push({ name: relativePath, content });
      if (files.length % 100 === 0) onProgress(`Collected ${files.length} static files...`);
    }
  }
  await walk(root, "");
  return files;
}

async function runNpmCommand(
  runtime: WebContainer,
  cwd: string,
  args: string[],
  label: string,
  timeoutMs: number,
  options: StaticBuildOptions,
): Promise<void> {
  const process = await withCodingWebContainerTimeout(
    runtime.spawn("npm", args, { cwd }),
    30_000,
    `The ${label} command could not start within 30 seconds.`,
  );
  const outputTask = process.output.pipeTo(new WritableStream<string>({
    write(chunk) {
      options.onOutput?.(chunk);
    },
  }));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const failure = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} exceeded its time limit.`)), timeoutMs);
    if (options.signal) {
      const abort = () => reject(new Error("Static deployment was cancelled."));
      if (options.signal.aborted) abort();
      else {
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
      }
    }
  });
  try {
    const exitCode = await Promise.race([process.exit, failure]);
    await outputTask;
    if (exitCode !== 0) throw new Error(`${label} exited with code ${exitCode}.`);
  } catch (error) {
    process.kill();
    void outputTask.catch(() => undefined);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}

export async function buildCodingStaticArtifact(
  rawFiles: unknown,
  options: StaticBuildOptions = {},
): Promise<Blob> {
  const parsedFiles = StaticBuildFilesSchema.safeParse(rawFiles);
  if (!parsedFiles.success) {
    throw new Error(parsedFiles.error.issues[0]?.message ?? "Project files could not be validated for static deployment.");
  }
  const files = parsedFiles.data;
  if (files.some((file) => isSensitiveStaticFile(file.name))) {
    throw new Error("Remove credentials and private key files before deploying.");
  }
  const packageFile = files.find((file) => file.name === "package.json");
  if (!packageFile) {
    options.onProgress?.("Packaging the saved static files...");
    return createStaticArchive(selectPlainStaticFiles(files));
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(packageFile.content) as unknown;
  } catch {
    throw new Error("The project root package.json is not valid JSON.");
  }
  const manifest = StaticPackageSchema.safeParse(rawManifest);
  if (!manifest.success) throw new Error("The project root package.json has an invalid scripts section.");
  if (!manifest.data.scripts?.build) {
    options.onProgress?.("Packaging the saved static files...");
    return createStaticArchive(selectPlainStaticFiles(files));
  }
  if (files.some((file) => DISALLOWED_LOCKFILES.includes(file.name))) {
    throw new Error("Browser builds currently require npm. Remove the Yarn or pnpm lockfile and save the project again.");
  }

  options.onProgress?.("Starting the browser build runtime...");
  if (
    typeof window === "undefined"
    || !window.isSecureContext
    || !window.crossOriginIsolated
    || typeof SharedArrayBuffer === "undefined"
  ) {
    const embedded = typeof window !== "undefined" && window.self !== window.top;
    throw new Error(embedded
      ? "Browser builds need WebContainer isolation. Open Nexus Code in a top-level tab and try again."
      : "Browser builds need a secure, cross-origin-isolated tab with SharedArrayBuffer support.");
  }
  const runtime = await bootCodingWebContainer(options.onProgress);
  if (options.signal?.aborted) throw new Error("Static deployment was cancelled.");
  const mountPoint = `nexus-static-${crypto.randomUUID()}`;
  options.onProgress?.("Mounting the saved revision in an isolated build folder...");
  try {
    await withCodingWebContainerTimeout(
      runtime.mount(createCodingWebContainerFileTree(files), { mountPoint }),
      45_000,
      "Mounting the static project timed out after 45 seconds.",
    );
    const hasPackageLock = files.some((file) => file.name === "package-lock.json" || file.name === "npm-shrinkwrap.json");
    options.onProgress?.(hasPackageLock ? "Installing locked npm dependencies..." : "Installing npm dependencies...");
    await runNpmCommand(
      runtime,
      mountPoint,
      hasPackageLock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"],
      "npm install",
      8 * 60_000,
      options,
    );
    options.onProgress?.("Building the static site...");
    await runNpmCommand(runtime, mountPoint, ["run", "build"], "Static build", 5 * 60_000, options);

    const rootEntries = await runtime.fs.readdir(mountPoint, { withFileTypes: true });
    const candidates = OUTPUT_DIRECTORIES.filter((name) => (
      rootEntries.some((entry) => entry.name === name && entry.isDirectory())
    ));
    candidates.push(".");
    for (const candidate of candidates) {
      const entries = candidate === "."
        ? rootEntries
        : await runtime.fs.readdir(`${mountPoint}/${candidate}`, { withFileTypes: true });
      if (!fileExists(entries, "index.html")) continue;
      options.onProgress?.(`Collecting static files from ${candidate === "." ? "the project root" : candidate}...`);
      const path = candidate === "." ? mountPoint : `${mountPoint}/${candidate}`;
      const outputFiles = await readOutputFiles(runtime, path, options.onProgress ?? (() => undefined), options.signal);
      options.onProgress?.(`Compressing ${outputFiles.length} static files...`);
      return await createStaticArchive(outputFiles);
    }
    throw new Error("The build completed but no supported output folder contains a root index.html (dist, build, out, or public).");
  } finally {
    await runtime.fs.rm(mountPoint, { recursive: true, force: true });
  }
}
