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

export type CodingChatHistorySaveResult = {
  history: CodingChatHistory;
  prunedThreadCount: number;
  prunedMessageCount: number;
};

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
  const saved = saveCodingChatHistory(workspaceId, history);
  if (legacyRaw !== null) {
    try {
      storage.removeItem(LEGACY_HISTORY_KEY);
      storage.setItem(LEGACY_MIGRATED_KEY, "1");
    } catch {
      throw new Error("Chat history was saved, but old conversation data could not be migrated cleanly.");
    }
  }
  return saved.history;
}

function isQuotaExceeded(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014;
  }
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "QuotaExceededError";
}

function pruneOldestHistoryItem(
  history: CodingChatHistory,
): { history: CodingChatHistory; prunedThreadCount: number; prunedMessageCount: number } | null {
  const oldestInactiveThread = history.threads
    .filter((thread) => thread.id !== history.activeThreadId)
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))[0];
  if (oldestInactiveThread) {
    return {
      history: {
        ...history,
        threads: history.threads.filter((thread) => thread.id !== oldestInactiveThread.id),
      },
      prunedThreadCount: 1,
      prunedMessageCount: 0,
    };
  }

  const activeThread = history.threads.find((thread) => thread.id === history.activeThreadId);
  if (!activeThread || activeThread.messages.length <= 2) return null;
  return {
    history: {
      ...history,
      threads: history.threads.map((thread) => (
        thread.id === history.activeThreadId
          ? { ...thread, messages: thread.messages.slice(1) }
          : thread
      )),
    },
    prunedThreadCount: 0,
    prunedMessageCount: 1,
  };
}

export function saveCodingChatHistory(workspaceId: string, rawHistory: unknown): CodingChatHistorySaveResult {
  const parsed = CodingChatHistorySchema.safeParse(rawHistory);
  if (!parsed.success) throw new Error("Chat history could not be validated before saving.");
  const storage = getStorage();
  const key = historyKey(workspaceId);
  let history = parsed.data;
  let prunedThreadCount = 0;
  let prunedMessageCount = 0;
  while (true) {
    try {
      storage.setItem(key, JSON.stringify(history));
      return { history, prunedThreadCount, prunedMessageCount };
    } catch (error) {
      if (!isQuotaExceeded(error)) {
        throw new Error("Chat history could not be saved in this browser.");
      }
      const pruned = pruneOldestHistoryItem(history);
      if (!pruned) {
        throw new Error("Browser storage is full. Older chats were removed, but the active conversation still could not be saved.");
      }
      history = pruned.history;
      prunedThreadCount += pruned.prunedThreadCount;
      prunedMessageCount += pruned.prunedMessageCount;
    }
  }
}

export function deleteCodingChatHistory(workspaceId: string): void {
  try {
    getStorage().removeItem(historyKey(workspaceId));
  } catch {
    throw new Error("Chat history could not be removed from this browser.");
  }
}
