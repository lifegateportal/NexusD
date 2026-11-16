"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

const SourceSchema = z.object({
  ref: z.string(),
  kind: z.enum(["book", "video"]),
  title: z.string(),
  excerpt: z.string(),
  href: z.string().optional(),
  startSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
}).strict();

const AnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(SourceSchema),
}).strict();

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  sources: z.array(SourceSchema).optional(),
}).strict();

const ConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  updatedAt: z.string().datetime(),
  messages: z.array(MessageSchema).max(1000),
}).strict();

const ConversationsSchema = z.array(ConversationSchema).max(100);
const STORAGE_KEY = "nexus-library-ask-conversations-v1";
const ACTIVE_CHAT_KEY = "nexus-library-ask-active-chat-v1";

type Source = z.infer<typeof SourceSchema>;
type Message = z.infer<typeof MessageSchema>;
type Conversation = z.infer<typeof ConversationSchema>;

function makeConversation(): Conversation {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "New chat",
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function renderInlineMarkdown(text: string, keyPrefix: string, sourcePrefix: string): ReactNode[] {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[(S\d+)\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) nodes.push(<strong key={key} className="font-semibold text-slate-100">{match[1]}</strong>);
    else if (match[2]) nodes.push(<em key={key}>{match[2]}</em>);
    else if (match[3]) nodes.push(<code key={key} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[0.9em] text-amber-200">{match[3]}</code>);
    else if (match[4]) {
      nodes.push(
        <a
          key={key}
          href={`#source-${sourcePrefix}-${match[4]}`}
          className="whitespace-nowrap font-semibold text-amber-300 underline decoration-amber-500/40 underline-offset-2"
          aria-label={`Jump to source ${match[4]}`}
        >
          [{match[4]}]
        </a>,
      );
    } else if (match[5] && match[6]) {
      nodes.push(
        <a key={key} href={match[6]} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-2">
          {match[5]}
        </a>,
      );
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MarkdownMessage({ content, sourcePrefix }: { content: string; sourcePrefix: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
      ?? line.match(/^\*\*([^*]+)\*\*$/);
    if (heading) {
      const text = heading[2] ?? heading[1];
      blocks.push(
        <h3 key={`heading-${index}`} className="mb-2 mt-5 text-sm font-bold tracking-wide text-white first:mt-0">
          {renderInlineMarkdown(text, `heading-${index}`, sourcePrefix)}
        </h3>,
      );
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        const item = lines[index].trim().replace(/^[-*]\s+/, "");
        items.push(
          <li key={`list-${index}`} className="pl-1">
            {renderInlineMarkdown(item, `list-${index}`, sourcePrefix)}
          </li>,
        );
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="my-2 list-disc space-y-1.5 pl-5 marker:text-amber-500">
          {items}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        const item = lines[index].trim().replace(/^\d+[.)]\s+/, "");
        items.push(
          <li key={`ordered-${index}`} className="pl-1">
            {renderInlineMarkdown(item, `ordered-${index}`, sourcePrefix)}
          </li>,
        );
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="my-2 list-decimal space-y-1.5 pl-5 marker:text-amber-500">
          {items}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index].trim();
      if (paragraph.length > 0 && (
        /^#{1,3}\s+/.test(next)
        || /^\*\*([^*]+)\*\*$/.test(next)
        || /^[-*]\s+/.test(next)
        || /^\d+[.)]\s+/.test(next)
      )) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="my-2 first:mt-0 last:mb-0">
        {renderInlineMarkdown(paragraph.join(" "), `paragraph-${index}`, sourcePrefix)}
      </p>,
    );
  }

  return <div className="leading-7">{blocks}</div>;
}

export default function LibraryAssistant() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  );
  const messages = activeConversation?.messages ?? [];

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = ConversationsSchema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) {
          setConversations(parsed.data);
          const savedActiveId = window.localStorage.getItem(ACTIVE_CHAT_KEY);
          setActiveId(
            parsed.data.some((conversation) => conversation.id === savedActiveId)
              ? savedActiveId
              : parsed.data[0]?.id ?? null,
          );
        } else {
          setStorageError("Saved library chats were invalid and could not be restored.");
        }
      }
    } catch {
      setStorageError("Browser storage is unavailable. Chats may not persist after you leave this page.");
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
      if (activeId) window.localStorage.setItem(ACTIVE_CHAT_KEY, activeId);
      else window.localStorage.removeItem(ACTIVE_CHAT_KEY);
      setStorageError("");
    } catch {
      setStorageError("Could not save chats in this browser. Free up browser storage and try again.");
    }
  }, [activeId, conversations, storageReady]);

  function updateConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations((current) => current.map((conversation) =>
      conversation.id === id ? update(conversation) : conversation,
    ));
  }

  function createNewChat() {
    if (busy) return;
    const conversation = makeConversation();
    setConversations((current) => [conversation, ...current].slice(0, 100));
    setActiveId(conversation.id);
    setQuestion("");
    setError("");
    setHistoryOpen(false);
  }

  function refreshSavedChats() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = ConversationsSchema.safeParse(raw ? JSON.parse(raw) as unknown : []);
      if (!parsed.success) throw new Error("The saved chat list is invalid.");
      setConversations(parsed.data);
      const savedActiveId = window.localStorage.getItem(ACTIVE_CHAT_KEY);
      setActiveId(
        parsed.data.some((conversation) => conversation.id === savedActiveId)
          ? savedActiveId
          : parsed.data[0]?.id ?? null,
      );
      setStorageError("");
      setError("");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not reload saved chats.");
    }
  }

  function deleteConversation(id: string) {
    if (busy || !window.confirm("Delete this saved chat from this browser?")) return;
    const remaining = conversations.filter((conversation) => conversation.id !== id);
    setConversations(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? null);
    setError("");
  }

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = question.trim();
    if (!query || busy || !storageReady) return;

    setQuestion("");
    setError("");
    const conversation = activeConversation ?? makeConversation();
    if (!activeConversation) {
      setConversations((current) => [conversation, ...current].slice(0, 100));
      setActiveId(conversation.id);
    }
    updateConversation(conversation.id, (current) => ({
      ...current,
      title: current.messages.length === 0
        ? query.slice(0, 72) + (query.length > 72 ? "…" : "")
        : current.title,
      updatedAt: new Date().toISOString(),
      messages: [...current.messages, { role: "user", content: query }],
    }));
    setBusy(true);
    try {
      const response = await fetch("/api/library/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsedError = z.object({ error: z.string() }).safeParse(body);
        throw new Error(parsedError.success ? parsedError.data.error : "The library assistant request failed.");
      }
      const parsed = AnswerSchema.safeParse(body);
      if (!parsed.success) throw new Error("The library assistant returned an invalid response.");
      updateConversation(conversation.id, (current) => ({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [...current.messages, {
        role: "assistant",
        content: parsed.data.answer,
        sources: parsed.data.sources,
        }],
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The library assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="shrink-0 border-b border-slate-800/70 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={createNewChat}
            disabled={busy}
            className="min-h-12 rounded-xl bg-amber-500 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            + New chat
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200"
            aria-expanded={historyOpen}
          >
            Saved chats ({conversations.length})
          </button>
          <button
            type="button"
            onClick={refreshSavedChats}
            className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300"
            aria-label="Refresh saved chats from this browser"
          >
            Refresh
          </button>
          <span className="ml-auto text-xs text-emerald-400" role="status">
            {storageReady && !storageError ? "Saved locally" : storageReady ? "Not saved" : "Loading chats…"}
          </span>
        </div>
        {historyOpen && (
          <div className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/40 p-2">
            {conversations.length === 0 ? (
              <p className="p-3 text-sm text-slate-500">No saved chats yet. Your questions and answers are saved in this browser automatically.</p>
            ) : conversations.map((conversation) => (
              <div key={conversation.id} className={`flex min-h-12 items-center gap-2 rounded-lg px-2 ${
                conversation.id === activeId ? "bg-slate-800" : ""
              }`}>
                <button
                  type="button"
                  onClick={() => {
                    if (busy) return;
                    setActiveId(conversation.id);
                    setQuestion("");
                    setError("");
                    setHistoryOpen(false);
                  }}
                  className="min-h-12 min-w-0 flex-1 truncate text-left text-sm text-slate-200"
                >
                  <span className="block truncate">{conversation.title}</span>
                  <span className="block text-[10px] text-slate-500">
                    {conversation.messages.length} messages · {new Date(conversation.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(conversation.id)}
                  disabled={busy}
                  className="min-h-12 min-w-12 rounded-lg px-3 text-sm font-semibold text-rose-300 disabled:opacity-50"
                  aria-label={`Delete ${conversation.title}`}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
        {storageError && <p role="alert" className="mt-2 text-xs text-rose-300">{storageError}</p>}
      </div>
      <section
        aria-live="polite"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto py-6"
      >
        {messages.length === 0 && (
          <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-slate-800 bg-slate-900/50 p-6 sm:mt-16">
            <p className="mb-2 text-lg font-semibold text-white">Questions, answered from the source.</p>
            <p className="text-sm leading-relaxed text-slate-400">
              Ask about an idea, story, or teaching. The assistant will only use your published books and video transcripts, and will link you to supporting passages or video timestamps.
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <article key={`${message.role}-${index}`} className={`max-w-3xl ${message.role === "user" ? "ml-auto" : ""}`}>
            <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              message.role === "user"
                ? "bg-amber-500 text-slate-950"
                : "border border-slate-800 bg-slate-900/70 text-slate-200"
            }`}>
              {message.role === "assistant"
                ? <MarkdownMessage content={message.content} sourcePrefix={String(index)} />
                : <p className="whitespace-pre-wrap">{message.content}</p>}
            </div>
            {message.sources && message.sources.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Sources</p>
                {message.sources.map((source) => (
                  <a
                    key={source.ref}
                    id={`source-${index}-${source.ref}`}
                    href={source.href}
                    target={source.kind === "video" ? "_blank" : undefined}
                    rel={source.kind === "video" ? "noreferrer" : undefined}
                    className="block min-h-12 rounded-xl border border-slate-800 bg-slate-900/40 p-3 transition hover:border-slate-600"
                  >
                    <span className="text-xs font-semibold text-amber-300">
                      [{source.ref}] {source.kind === "video" ? "Video" : "Book"} · {source.title}
                      {source.startSeconds !== undefined && ` · ${formatTime(source.startSeconds)}${source.endSeconds !== undefined ? `–${formatTime(source.endSeconds)}` : ""}`}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-slate-400">{source.excerpt}</span>
                    {source.href && <span className="mt-2 block text-xs font-semibold text-slate-300">Open source ↗</span>}
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
        {busy && <p className="text-sm text-slate-500" role="status">Searching your books and transcripts…</p>}
        {error && <p className="rounded-xl border border-rose-900/70 bg-rose-950/40 p-3 text-sm text-rose-200" role="alert">{error}</p>}
      </section>

      <form onSubmit={submitQuestion} className="shrink-0 border-t border-slate-800/70 bg-slate-950 py-3">
        <label htmlFor="library-question" className="sr-only">Ask a question about the books and videos</label>
        <div className="flex gap-2">
          <input
            id="library-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a question about the library…"
            maxLength={2000}
            className="min-h-12 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-4 text-base text-white outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={busy || !storageReady || question.trim().length < 2}
            className="min-h-12 min-w-12 rounded-xl bg-amber-500 px-5 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Ask
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-slate-600">No outside sources are used.</p>
      </form>
    </>
  );
}
