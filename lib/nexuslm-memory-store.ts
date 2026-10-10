import { z } from "zod";

export const NexusLMMemorySchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  text: z.string().trim().min(1).max(1000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type NexusLMMemory = z.infer<typeof NexusLMMemorySchema>;

const DB_NAME = "nexuslm-memory";
const STORE = "memories";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function normalizeMemory(value: unknown): NexusLMMemory | null {
  const parsed = NexusLMMemorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listNexusLMMemories(scope: string): Promise<NexusLMMemory[]> {
  if (typeof window === "undefined" || !scope) return [];
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(
      (request.result as unknown[])
        .map(normalizeMemory)
        .filter((memory): memory is NexusLMMemory => memory !== null && memory.scope === scope)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    );
    request.onerror = () => reject(request.error);
  });
}

export async function saveNexusLMMemory(scope: string, text: string): Promise<NexusLMMemory> {
  if (typeof window === "undefined" || !scope) throw new Error("NexusLM memory is only available in the browser.");
  const uniqueId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const memory = NexusLMMemorySchema.parse({
    id: `${scope}:${uniqueId}`,
    scope,
    text,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(memory);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  return memory;
}

export async function deleteNexusLMMemory(id: string): Promise<void> {
  if (typeof window === "undefined" || !id) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
