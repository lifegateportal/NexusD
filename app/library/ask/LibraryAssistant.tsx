"use client";

import { FormEvent, useState } from "react";
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

type Source = z.infer<typeof SourceSchema>;
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export default function LibraryAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = question.trim();
    if (!query || busy) return;

    setQuestion("");
    setError("");
    setMessages((current) => [...current, { role: "user", content: query }]);
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
      setMessages((current) => [...current, {
        role: "assistant",
        content: parsed.data.answer,
        sources: parsed.data.sources,
      }]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The library assistant could not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
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
            <p className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              message.role === "user"
                ? "bg-amber-500 text-slate-950"
                : "border border-slate-800 bg-slate-900/70 text-slate-200"
            }`}>
              {message.content}
            </p>
            {message.sources && message.sources.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Sources</p>
                {message.sources.map((source) => (
                  <a
                    key={source.ref}
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
            disabled={busy || question.trim().length < 2}
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
