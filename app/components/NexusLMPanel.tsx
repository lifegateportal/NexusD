"use client";

import { useEffect, useRef, useState } from "react";
import { ChapterDraftSchema, EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest } from "@/lib/schemas/ebook";
import type { ChapterDraft } from "@/lib/schemas/ebook";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";

type NexusLMPanelProps = {
  manifest: EbookManifest | null;
  pipelineSnapshot: EbookPipelineSnapshot | null;
  transcripts: Array<{ label: string; text: string }>;
  onManifestChange: (manifest: EbookManifest, summary: string) => void;
};

type Mode = "ask" | "socratic" | "draft" | "edit";
type Persona = "editorial-coach" | "skeptical-reviewer" | "socratic-teacher" | "voice-guardian";
type Message = { role: "user" | "assistant" | "system"; content: string };
type Source = { id: string; label: string; excerpt: string };
type PendingEdit = { instruction: string; summary: string; confidence?: "high" | "medium" | "low" };

const PERSONAS: Record<Persona, { label: string; description: string }> = {
  "editorial-coach": { label: "Editorial Coach", description: "Shape the strongest version of the book." },
  "skeptical-reviewer": { label: "Skeptical Reviewer", description: "Challenge claims, evidence, and structure." },
  "socratic-teacher": { label: "Socratic Teacher", description: "Ask questions that deepen the author's thinking." },
  "voice-guardian": { label: "Voice Guardian", description: "Protect the established voice and style." },
};

const MODES: Record<Mode, { label: string; prompt: string }> = {
  ask: { label: "Ask", prompt: "Answer using the loaded manuscript. State uncertainty clearly." },
  socratic: { label: "Socratic Vetting", prompt: "Do not rush to rewrite. Surface assumptions, gaps, contradictions, and probing questions." },
  draft: { label: "Draft Chapter", prompt: "Write a complete chapter from the manuscript and transcript sources, then show the full draft for review." },
  edit: { label: "Edit / Enrich", prompt: "Propose precise manuscript improvements and apply only the requested changes." },
};

function initialMessage(manifest: EbookManifest | null): Message {
  return manifest
    ? { role: "system", content: `NexusLM is connected to “${manifest.bookTitle}”. Ask about the manuscript, challenge its thinking, or request a focused edit.` }
    : { role: "system", content: "Complete or load a book project to start a NexusLM conversation." };
}

function formatChapterDraft(chapter: ChapterDraft): string {
  const sections = chapter.sections
    .map((section) => `${section.heading ? `${section.heading}\n\n` : ""}${section.body}`)
    .join("\n\n");
  return `CHAPTER ${chapter.number}: ${chapter.title}\n\n${chapter.intro ? `${chapter.intro}\n\n` : ""}${sections}${chapter.forwardQuestion ? `\n\nForward question: ${chapter.forwardQuestion}` : ""}`;
}

export function NexusLMPanel({ manifest, pipelineSnapshot, transcripts, onManifestChange }: NexusLMPanelProps) {
  const [messages, setMessages] = useState<Message[]>([initialMessage(manifest)]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("ask");
  const [persona, setPersona] = useState<Persona>("editorial-coach");
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ChapterDraft | null>(null);
  const [selectedTranscriptLabel, setSelectedTranscriptLabel] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedTranscript = transcripts.find((transcript) => transcript.label === selectedTranscriptLabel) ?? transcripts[0] ?? null;

  useEffect(() => {
    setMessages([initialMessage(manifest)]);
  }, [manifest?.jobId]);

  useEffect(() => {
    if (selectedTranscriptLabel && transcripts.some((transcript) => transcript.label === selectedTranscriptLabel)) return;
    setSelectedTranscriptLabel(transcripts[0]?.label ?? "");
  }, [selectedTranscriptLabel, transcripts]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send(requestText?: string, requestMode: Mode = mode) {
    const instruction = (requestText ?? input).trim();
    if (!instruction || loading) return;
    if (!manifest) {
      setMessages((current) => [...current, { role: "assistant", content: "Load a book project before starting a NexusLM conversation." }]);
      return;
    }

    const userMessage = `${instruction}\n\n[Mode: ${MODES[requestMode].label}] [Persona: ${PERSONAS[persona].label}]`;
    const nextMessages = [...messages, { role: "user" as const, content: instruction }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      if (requestMode === "draft") {
        const chapterMatch = instruction.match(/\bchapter\s+(\d+)\b/i);
        const chapterNumber = chapterMatch ? Number(chapterMatch[1]) : 0;
        if (!chapterNumber) {
          setMessages((current) => [...current, { role: "assistant", content: "Tell me which chapter number to draft, for example: Write chapter 4 from the manuscript." }]);
          return;
        }
        const res = await fetch("/api/ebook/nexuslm/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction,
            chapterNumber,
            persona: PERSONAS[persona].label,
            book: {
              title: manifest.bookTitle,
              chapters: manifest.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })),
              manuscriptChapter: manifest.chapters.find((chapter) => chapter.number === chapterNumber) ?? null,
            },
            transcripts,
          }),
        });
        const json = await res.json() as { chapter?: unknown; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
        const parsed = ChapterDraftSchema.safeParse(json.chapter);
        if (!parsed.success) throw new Error("NexusLM returned an invalid chapter draft.");
        setPendingDraft(parsed.data);
        setMessages((current) => [...current, { role: "assistant", content: formatChapterDraft(parsed.data) }]);
        return;
      }

      if (requestMode !== "edit") {
        const res = await fetch("/api/ebook/nexuslm/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: instruction,
            mode: requestMode,
            persona: PERSONAS[persona].label,
            book: { title: manifest.bookTitle, chapters: manifest.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })) },
            transcripts,
            history: nextMessages.filter((message) => message.role !== "system").slice(-14),
          }),
        });
        const json = await res.json() as { answer?: string; sources?: Source[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
        setSources(json.sources ?? []);
        setMessages((current) => [...current, { role: "assistant", content: json.answer ?? "NexusLM returned no answer." }]);
        return;
      }

      const res = await fetch("/api/ebook/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest,
          instruction: `${MODES[requestMode].prompt}\nPersona: ${PERSONAS[persona].description}\n\nUser request:\n${userMessage}`,
          history: nextMessages.filter((message) => message.role !== "system").slice(-14),
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          dryRun: requestMode !== "edit",
        }),
      });
      const json = await res.json() as { manifest?: unknown; patch?: unknown; summary?: string; confidence?: "high" | "medium" | "low"; error?: string; clarificationNeeded?: string; needsClarification?: boolean; noChanges?: boolean; manifestVersion?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      if (json.needsClarification && json.clarificationNeeded) {
        setMessages((current) => [...current, { role: "assistant", content: json.clarificationNeeded! }]);
        return;
      }

      if (requestMode === "edit") {
        if (!json.patch || !json.summary) throw new Error("NexusLM returned no editable proposal.");
        setPendingEdit({ instruction, summary: json.summary, confidence: json.confidence });
        setMessages((current) => [...current, { role: "assistant", content: `Proposal ready for review: ${json.summary}` }]);
        return;
      }

      setMessages((current) => [...current, {
        role: "assistant",
        content: json.summary ?? (json.noChanges ? "No manuscript changes were applied." : "NexusLM completed the request."),
      }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "NexusLM could not complete the request." }]);
    } finally {
      setLoading(false);
    }
  }

  function addPendingDraft() {
    if (!manifest || !pendingDraft) return;
    const chapters = manifest.chapters.some((chapter) => chapter.number === pendingDraft.number)
      ? manifest.chapters.map((chapter) => chapter.number === pendingDraft.number ? pendingDraft : chapter)
      : [...manifest.chapters, pendingDraft].sort((a, b) => a.number - b.number);
    const totalWordCount = chapters.reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0);
    onManifestChange({ ...manifest, chapters, totalWordCount }, `Chapter ${pendingDraft.number} added to the manuscript.`);
    setMessages((current) => [...current, { role: "assistant", content: `Chapter ${pendingDraft.number} added to the manuscript.` }]);
    setPendingDraft(null);
  }

  async function applyPendingEdit() {
    if (!manifest || !pendingEdit || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/ebook/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest,
          instruction: pendingEdit.instruction,
          history: messages.filter((message) => message.role !== "system").slice(-14),
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          dryRun: false,
        }),
      });
      const json = await res.json() as { manifest?: unknown; summary?: string; error?: string; manifestVersion?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      const parsed = EbookManifestSchema.safeParse(json.manifest);
      if (!parsed.success) throw new Error("NexusLM returned an invalid manuscript.");
      const nextManifest = json.manifestVersion ? { ...parsed.data, __version: json.manifestVersion } : parsed.data;
      onManifestChange(nextManifest as EbookManifest, json.summary ?? "Manuscript updated.");
      setMessages((current) => [...current, { role: "assistant", content: json.summary ?? "Approved manuscript changes applied." }]);
      setPendingEdit(null);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error instanceof Error ? error.message : "NexusLM could not apply the proposal." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-shell-950 lg:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-slate-800 lg:border-b-0 lg:border-r" aria-label="NexusLM conversation">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`max-w-[92%] whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm leading-6 ${message.role === "user" ? "self-end border-cyan-500/30 bg-cyan-500/10 text-cyan-50" : "border-slate-800 bg-slate-900/70 text-slate-300"}`}>
                {message.content}
              </div>
            ))}
            {loading && <div className="text-sm text-slate-500">NexusLM is thinking...</div>}
          </div>
        </div>

        <div className="border-t border-slate-800 bg-slate-950/80 p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] lg:p-5">
          <div className="mx-auto max-w-3xl">
            {pendingDraft && (
              <div className="mb-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-cyan-300">Chapter draft ready</p>
                <p className="mt-2 text-sm leading-6 text-cyan-50">Chapter {pendingDraft.number}: {pendingDraft.title}</p>
                <p className="mt-1 text-xs text-cyan-200/70">Review the complete draft in the conversation, then choose whether to add this exact version.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={addPendingDraft} disabled={loading} className="min-h-12 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-40">Add to manuscript</button>
                  <button type="button" onClick={() => setPendingDraft(null)} disabled={loading} className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300 disabled:opacity-40">Discard draft</button>
                </div>
              </div>
            )}
            {pendingEdit && (
              <div className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-amber-300">Edit proposal</p>
                <p className="mt-2 text-sm leading-6 text-amber-50">{pendingEdit.summary}</p>
                <p className="mt-2 text-xs text-amber-200/70">Confidence: {pendingEdit.confidence ?? "high"}. Review the request before applying it.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void applyPendingEdit()} disabled={loading} className="min-h-12 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-40">Apply change</button>
                  <button type="button" onClick={() => setPendingEdit(null)} disabled={loading} className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300 disabled:opacity-40">Discard</button>
                </div>
              </div>
            )}
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder={manifest ? "Ask NexusLM about your book..." : "Load a book project to begin..."}
              disabled={!manifest || loading}
              rows={3}
              className="w-full resize-none rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/60"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500">Enter to send · Shift+Enter for a new line</p>
              <button type="button" onClick={() => void send()} disabled={!manifest || !input.trim() || loading} className="min-h-12 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">Send</button>
            </div>
          </div>
        </div>
      </section>

      <aside className="max-h-[42dvh] w-full shrink-0 overflow-y-auto border-t border-slate-800 bg-slate-950/70 p-4 lg:max-h-none lg:w-80 lg:border-t-0 lg:p-6">
        <div className="mb-6">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-300">NexusLM</p>
          <h2 className="mt-2 text-lg font-semibold text-slate-100">Your book, in conversation</h2>
          <p className="mt-2 text-xs leading-5 text-slate-500">Ask questions, test the thinking, or make a focused edit.</p>
        </div>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-persona">Persona</label>
        <select id="nexuslm-persona" value={persona} onChange={(event) => setPersona(event.target.value as Persona)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(PERSONAS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>

        <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-500">Mode</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(MODES).map(([value, item]) => (
            <button key={value} type="button" onClick={() => setMode(value as Mode)} className={`min-h-12 rounded-xl border px-2 text-xs font-semibold ${mode === value ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300" : "border-slate-700 text-slate-400"}`}>{item.label}</button>
          ))}
        </div>

        <div className="mt-6 border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Connected context</p>
          <p className="mt-2 text-sm text-slate-200">{manifest?.bookTitle ?? "No book loaded"}</p>
          {manifest && <p className="mt-1 text-xs text-slate-500">{manifest.chapters.length} chapters · {manifest.totalWordCount.toLocaleString()} words</p>}
          <p className="mt-3 text-xs text-slate-500">Pipeline: <span className="text-slate-300">{pipelineSnapshot?.stage ?? "not started"}</span></p>
          <p className="mt-1 text-xs text-slate-500">Sources: <span className="text-slate-300">{transcripts.length} transcript{transcripts.length === 1 ? "" : "s"}</span></p>
        </div>

        <div className="mt-6 border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Transcript slots</p>
          {transcripts.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-slate-600">No uploaded transcripts are available yet.</p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {transcripts.map((transcript) => (
                  <button
                    key={transcript.label}
                    type="button"
                    onClick={() => setSelectedTranscriptLabel(transcript.label)}
                    className={`min-h-12 rounded-xl border px-3 text-left text-xs font-semibold ${selectedTranscript?.label === transcript.label ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300" : "border-slate-700 text-slate-400"}`}
                  >
                    {transcript.label}
                    <span className="mt-1 block font-normal text-slate-500">{transcript.text.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words</span>
                  </button>
                ))}
              </div>
              {selectedTranscript && (
                <>
                  <textarea readOnly value={selectedTranscript.text} aria-label={`${selectedTranscript.label} transcript`} className="mt-3 h-48 w-full resize-y rounded-xl border border-slate-800 bg-slate-900 p-3 text-base leading-5 text-slate-400" />
                  <button
                    type="button"
                    onClick={() => { setMode("draft"); void send(`Write a complete chapter from ${selectedTranscript.label}. Use only this slot's transcript and the existing manuscript context.`, "draft"); }}
                    disabled={!manifest || loading}
                    className="mt-3 min-h-12 w-full rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 text-sm font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Draft chapter from {selectedTranscript.label}
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Sources consulted</p>
          {sources.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-slate-600">Ask a question to see the transcript excerpts NexusLM used.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {sources.map((source) => (
                <article key={source.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <p className="text-xs font-semibold text-cyan-300">[{source.id}] {source.label}</p>
                  <p className="mt-1 line-clamp-5 text-xs leading-5 text-slate-400">{source.excerpt}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
