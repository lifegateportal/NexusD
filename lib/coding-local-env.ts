import { z } from "zod";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";

const STORAGE_PREFIX = "nexus-coding-local-env:";
const CodingLocalEnvironmentRecordSchema = z.object({
  version: z.literal(1),
  content: z.string().max(500_000),
}).strict();

function getBrowserStorage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Device-local .env.local is available only in a browser.");
  }
  try {
    return window.localStorage;
  } catch {
    throw new Error("This browser could not access local storage for .env.local.");
  }
}

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}${CodingWorkspaceIdSchema.parse(workspaceId)}`;
}

export function loadCodingLocalEnvironment(workspaceId: string): string | null {
  let raw: string | null;
  try {
    raw = getBrowserStorage().getItem(storageKey(workspaceId));
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("The project id for local .env.local is invalid.");
    if (error instanceof Error && error.message.includes("local storage")) throw error;
    throw new Error("Device-local .env.local could not be read from this browser.");
  }
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Saved device-local .env.local data is invalid. Remove it and recreate the file.");
  }
  const parsed = CodingLocalEnvironmentRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Saved device-local .env.local data is invalid. Remove it and recreate the file.");
  }
  return parsed.data.content;
}

export function saveCodingLocalEnvironment(workspaceId: string, content: string): void {
  const parsed = CodingLocalEnvironmentRecordSchema.safeParse({ version: 1, content });
  if (!parsed.success) {
    throw new Error("Keep device-local .env.local under 500 KB.");
  }
  try {
    getBrowserStorage().setItem(storageKey(workspaceId), JSON.stringify(parsed.data));
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("The project id for local .env.local is invalid.");
    throw new Error("Device-local .env.local could not be saved in this browser. Check available storage.");
  }
}

export function deleteCodingLocalEnvironment(workspaceId: string): void {
  try {
    getBrowserStorage().removeItem(storageKey(workspaceId));
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("The project id for local .env.local is invalid.");
    throw new Error("Device-local .env.local could not be removed from this browser.");
  }
}
