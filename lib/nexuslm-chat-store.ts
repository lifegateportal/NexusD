import { z } from "zod";
import { BookTemplateEnum } from "@/lib/schemas/ebook";

export type NexusLMChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  format?: "plain" | "markdown";
  attachments?: Array<{ id: string; name: string }>;
};

export type NexusLMChatAttachment = {
  id: string;
  name: string;
  content: string;
  size: number;
  kind: "text" | "html" | "pdf";
  mimeType?: string;
  previewDataUrl?: string;
};

export type NexusLMManuscriptChapter = {
  id: string;
  number: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type NexusLMManuscript = {
  title: string;
  subtitle: string;
  authorName: string;
  template: z.infer<typeof BookTemplateEnum>;
  htmlTemplate?: string;
  chapters: NexusLMManuscriptChapter[];
};

export type NexusLMChatArchive = {
  id: string;
  scope: string;
  title: string;
  messages: NexusLMChatMessage[];
  attachments: NexusLMChatAttachment[];
  manuscript?: NexusLMManuscript;
  createdAt: string;
  updatedAt: string;
};

export type NexusLMChatSummary = Pick<NexusLMChatArchive, "id" | "scope" | "title" | "createdAt" | "updatedAt"> & {
  messageCount: number;
};

const DB_NAME = "nexuslm-chat-history";
const STORE = "archives";

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  format: z.enum(["plain", "markdown"]).optional(),
  attachments: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  })).optional(),
}).strict();

const ChatAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  content: z.string(),
  size: z.number().nonnegative(),
  kind: z.enum(["text", "html", "pdf"]),
  mimeType: z.string().optional(),
  previewDataUrl: z.string().optional(),
}).strict();

const ManuscriptChapterSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().max(200),
  title: z.string().trim().min(1).max(300),
  content: z.string().min(1).max(600_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const ManuscriptSchema = z.object({
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500),
  authorName: z.string().trim().min(1).max(200),
  template: BookTemplateEnum,
  htmlTemplate: z.string().max(2_000_000).optional(),
  chapters: z.array(ManuscriptChapterSchema).max(200),
}).strict();

const ChatArchiveSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  title: z.string().min(1),
  messages: z.array(ChatMessageSchema),
  attachments: z.array(ChatAttachmentSchema),
  manuscript: ManuscriptSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function titleFromMessages(messages: NexusLMChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim());
  const title = firstUserMessage?.content.trim().replace(/\s+/g, " ");
  if (!title) return "New chat";
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function normalizeArchive(value: unknown): NexusLMChatArchive | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = rawMessages
    .map((message) => ChatMessageSchema.safeParse(message))
    .filter((parsed): parsed is { success: true; data: NexusLMChatMessage } => parsed.success)
    .map((parsed) => parsed.data);
  const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
  const attachments = rawAttachments
    .map((attachment) => ChatAttachmentSchema.safeParse(attachment))
    .filter((parsed): parsed is { success: true; data: NexusLMChatAttachment } => parsed.success)
    .map((parsed) => parsed.data);
  const id = typeof record.id === "string" && record.id.trim() ? record.id : "";
  if (!id) return null;
  const createdAt = validDate(record.createdAt)
    ? record.createdAt
    : validDate(record.updatedAt)
      ? record.updatedAt
      : new Date().toISOString();
  const updatedAt = validDate(record.updatedAt) ? record.updatedAt : createdAt;
  const scope = typeof record.scope === "string" && record.scope.trim()
    ? record.scope
    : id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  const title = typeof record.title === "string" && record.title.trim()
    ? record.title
    : titleFromMessages(messages);
  const normalized = {
    id,
    scope,
    title,
    messages,
    attachments,
    manuscript: ManuscriptSchema.safeParse(record.manuscript).success
      ? ManuscriptSchema.parse(record.manuscript)
      : undefined,
    createdAt,
    updatedAt,
  };
  const parsed = ChatArchiveSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export async function getNexusLMChat(id: string): Promise<NexusLMChatArchive | null> {
  if (typeof window === "undefined" || !id) return null;
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    request.onsuccess = () => resolve(normalizeArchive(request.result));
    request.onerror = () => reject(request.error);
  });
}

export async function listNexusLMChats(scope?: string): Promise<NexusLMChatSummary[]> {
  if (typeof window === "undefined") return [];
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => {
      const summaries = (request.result as unknown[])
        .map(normalizeArchive)
        .filter((archive): archive is NexusLMChatArchive => archive !== null)
        .filter((archive) => !scope || archive.scope === scope || archive.id === scope)
        .map((archive) => ({
          id: archive.id,
          scope: archive.scope,
          title: archive.title,
          createdAt: archive.createdAt,
          updatedAt: archive.updatedAt,
          messageCount: archive.messages.filter((message) => message.role !== "system").length,
        }))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      resolve(summaries);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveNexusLMChat(
  id: string,
  messages: NexusLMChatMessage[],
  options: {
    scope?: string;
    title?: string;
    attachments?: NexusLMChatAttachment[];
    manuscript?: NexusLMManuscript;
    touchUpdatedAt?: boolean;
  } = {},
): Promise<void> {
  if (typeof window === "undefined" || !id) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const existingRequest = store.get(id);
    existingRequest.onsuccess = () => {
      const existing = normalizeArchive(existingRequest.result);
      const now = new Date().toISOString();
      const derivedTitle = titleFromMessages(messages);
      const archive: NexusLMChatArchive = {
        id,
        scope: options.scope ?? existing?.scope ?? id,
        title: options.title?.trim() || (existing?.title && existing.title !== "New chat" ? existing.title : derivedTitle),
        messages,
        attachments: options.attachments ?? existing?.attachments ?? [],
        manuscript: options.manuscript ?? existing?.manuscript,
        createdAt: existing?.createdAt ?? now,
        updatedAt: options.touchUpdatedAt === false ? existing?.updatedAt ?? now : now,
      };
      store.put(ChatArchiveSchema.parse(archive));
    };
    existingRequest.onerror = () => reject(existingRequest.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function createNexusLMChat(scope: string): Promise<string> {
  const id = `${scope}:${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  await saveNexusLMChat(id, [], { scope, title: "New chat" });
  return id;
}

export async function renameNexusLMChat(id: string, title: string): Promise<void> {
  const archive = await getNexusLMChat(id);
  if (!archive) return;
  await saveNexusLMChat(id, archive.messages, {
    scope: archive.scope,
    title: title.trim() || "New chat",
    attachments: archive.attachments,
    manuscript: archive.manuscript,
    touchUpdatedAt: false,
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
