export type NexusLMChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type NexusLMChatArchive = {
  id: string;
  messages: NexusLMChatMessage[];
  updatedAt: string;
};

const DB_NAME = "nexuslm-chat-history";
const STORE = "archives";

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

export async function getNexusLMChat(id: string): Promise<NexusLMChatArchive | null> {
  if (typeof window === "undefined" || !id) return null;
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as NexusLMChatArchive | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function saveNexusLMChat(id: string, messages: NexusLMChatMessage[]): Promise<void> {
  if (typeof window === "undefined" || !id) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ id, messages, updatedAt: new Date().toISOString() } satisfies NexusLMChatArchive);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteNexusLMChat(id: string): Promise<void> {
  if (typeof window === "undefined" || !id) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
