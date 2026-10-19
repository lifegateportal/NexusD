import { z } from "zod";
import {
  CodingChatArchiveSchema,
  CodingChatHistorySchema,
  CodingChatThreadSchema,
  CodingStoredMessageSchema,
  type CodingChatHistory,
  type CodingChatThread,
  type CodingStoredMessage,
} from "@/lib/coding-chat";
import { CodingWorkspaceIdSchema } from "@/lib/coding-workspace";

const HISTORY_KEY_PREFIX = "nexus-coding-chat-history:";
const LEGACY_HISTORY_KEY = "nexus-coding-chat";
const LEGACY_MIGRATED_KEY = "nexus-coding-chat-history:migrated";
const CodingLegacyMigrationMarkerSchema = z.literal("1");

function getStorage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Coding chat history is available only in a browser.");
  }
  try {
    return window.localStorage;
  } catch {
    throw new Error("This browser could not access local storage for chat history.");
  }
}

function historyKey(workspaceId: string): string {
  const parsedId = CodingWorkspaceIdSchema.safeParse(workspaceId);
  if (!parsedId.success) throw new Error("The project id for chat history is invalid.");
  return `${HISTORY_KEY_PREFIX}${parsedId.data}`;
}

function createThreadId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return `chat-${randomId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function codingChatThreadTitle(messages: CodingStoredMessage[]): string {
  const prompts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s*/gm, "")
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
      .replace(/^\s*\|.*\|\s*$/gm, " ")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:task|request|goal|context|requirements?|prompt)\s*[:.-]?\s*/i, ""))
    .filter((prompt) => prompt && !/^(?:hi|hello|hey|good morning|good afternoon|good evening)[!.? ]*$/i.test(prompt));
  const prompt = prompts[0];
  if (!prompt) return "New chat";
  const firstSentence = prompt.split(/(?<=[.!?])\s+/u, 1)[0] || prompt;
  if (firstSentence.length <= 80) return firstSentence;
  const shortened = firstSentence.slice(0, 77).replace(/\s+\S*$/, "").trim();
  return `${shortened || firstSentence.slice(0, 77).trimEnd()}...`;
}

export function createCodingChatThread(
  messages: CodingStoredMessage[],
  title = codingChatThreadTitle(messages),
  now = new Date().toISOString(),
): CodingChatThread {
  return CodingChatThreadSchema.parse({
    id: createThreadId(),
    title,
    messages: messages.slice(-80),
    createdAt: now,
    updatedAt: now,
  });
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(message);
  }
}

export function loadCodingChatHistory(
  workspaceId: string,
  initialMessage: CodingStoredMessage,
): CodingChatHistory {
  const storage = getStorage();
  const key = historyKey(workspaceId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    throw new Error("Chat history could not be read from this browser.");
  }
  if (raw !== null) {
    const parsed = CodingChatHistorySchema.safeParse(
      parseJson(raw, "Saved chat history for this project is invalid."),
    );
    if (!parsed.success) throw new Error("Saved chat history for this project is invalid.");
    const titledThreads = parsed.data.threads.map((thread) => ({
      ...thread,
      title: codingChatThreadTitle(thread.messages),
    }));
    const history = CodingChatHistorySchema.parse({
      ...parsed.data,
      threads: titledThreads,
    });
    return history;
  }

  const now = new Date().toISOString();
  const activeThread = createCodingChatThread(
    [CodingStoredMessageSchema.parse(initialMessage)],
    "New chat",
    now,
  );
  const threads: CodingChatThread[] = [activeThread];
  let legacyRaw: string | null = null;
  try {
    const marker = storage.getItem(LEGACY_MIGRATED_KEY);
    const markerParsed = marker === null ? null : CodingLegacyMigrationMarkerSchema.safeParse(marker);
    if (marker !== null && !markerParsed?.success) {
      throw new Error("Saved chat-history migration state is invalid.");
    }
    if (marker === null) legacyRaw = storage.getItem(LEGACY_HISTORY_KEY);
  } catch (historyError) {
    throw historyError instanceof Error
      ? historyError
      : new Error("Previous chat history could not be read.");
  }

  if (legacyRaw !== null) {
    const legacy = CodingChatArchiveSchema.safeParse(
      parseJson(legacyRaw, "Previous chat history is invalid."),
    );
    if (!legacy.success) throw new Error("Previous chat history is invalid.");
    if (legacy.data.messages.some((message) => message.role !== "system")) {
      threads.push(createCodingChatThread(
        legacy.data.messages,
        "Previous conversation",
        legacy.data.updatedAt || now,
      ));
    }
  }

  const history = CodingChatHistorySchema.parse({
    version: 1,
    activeThreadId: activeThread.id,
    threads,
    updatedAt: now,
  });
  saveCodingChatHistory(workspaceId, history);
  if (legacyRaw !== null) {
    try {
      storage.removeItem(LEGACY_HISTORY_KEY);
      storage.setItem(LEGACY_MIGRATED_KEY, "1");
    } catch {
      throw new Error("Chat history was saved, but old conversation data could not be migrated cleanly.");
    }
  }
  return history;
}

export function saveCodingChatHistory(workspaceId: string, rawHistory: unknown): void {
  const parsed = CodingChatHistorySchema.safeParse(rawHistory);
  if (!parsed.success) throw new Error("Chat history could not be validated before saving.");
  try {
    getStorage().setItem(historyKey(workspaceId), JSON.stringify(parsed.data));
  } catch {
    throw new Error("Chat history could not be saved in this browser. Check available local storage.");
  }
}

export function deleteCodingChatHistory(workspaceId: string): void {
  try {
    getStorage().removeItem(historyKey(workspaceId));
  } catch {
    throw new Error("Chat history could not be removed from this browser.");
  }
}
