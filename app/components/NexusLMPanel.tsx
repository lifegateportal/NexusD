"use client";

import { useEffect, useRef, useState } from "react";
import { ChapterDraftSchema, EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest } from "@/lib/schemas/ebook";
import type { ChapterDraft } from "@/lib/schemas/ebook";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import { deleteNexusLMChat, getNexusLMChat, saveNexusLMChat } from "@/lib/nexuslm-chat-store";

type NexusLMPanelProps = {
  conversationKey: string;
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

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "NexusLM could not complete the request.";
  try {
    const issues = JSON.parse(message) as Array<{ path?: string[]; message?: string }>;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((issue) => `${issue.path?.join(".") || "request"}: ${issue.message || "invalid value"}`).join("; ");
    }
  } catch {
    // Use the original message when it is not a serialized validation error.
  }
  return message;
}

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

function inferMode(instruction: string, selectedMode: Mode): Mode {
  const text = instruction.toLowerCase();
  if (/\b(write|draft|compose|create)\b.*\bchapter\b|\bchapter\b.*\b(write|draft|compose|create)\b/.test(text)) return "draft";
  if (/\b(vet|challenge|question|assumption|contradiction|weak|gap|skeptic|critique)\b/.test(text)) return "socratic";
  if (/\b(edit|rewrite|revise|enrich|expand|shorten|tighten|change|improve|fix)\b/.test(text)) return "edit";
  return selectedMode === "ask" ? "ask" : selectedMode;
}

function compactHistory(history: Message[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((message): message is Message & { role: "user" | "assistant" } => message.role !== "system")
    .slice(-14)
    .map((message) => ({
      role: message.role,
      content: message.content.length > 6000
        ? `${message.content.slice(0, 5600)}\n\n[Earlier response truncated from conversation history.]\n\n${message.content.slice(-300)}`
        : message.content,
    }));
}

function initialMessage(manifest: EbookManifest | null): Message {
  return manifest
    ? { role: "system", content: `NexusLM is connected to “${manifest.bookTitle}”. Ask about the manuscript, challenge its thinking, or request a focused edit.` }
    : { role: "system", content: "NexusLM is ready. Upload a transcript in the Pipeline tab, then ask questions or draft a chapter before running the full pipeline." };
}

function formatChapterDraft(chapter: ChapterDraft): string {
  const sections = chapter.sections
    .map((section) => `${section.heading ? `${section.heading}\n\n` : ""}${section.body}`)
    .join("\n\n");
  return `CHAPTER ${chapter.number}: ${chapter.title}\n\n${chapter.intro ? `${chapter.intro}\n\n` : ""}${sections}${chapter.forwardQuestion ? `\n\nForward question: ${chapter.forwardQuestion}` : ""}`;
}

function renderAssistantContent(content: string) {
  return content.split("\n").map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={`space-${index}`} className="h-3" aria-hidden="true" />;

    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      return <h3 key={`heading-${index}`} className="mt-5 text-base font-semibold tracking-tight text-slate-100 first:mt-0">{heading[1]}</h3>;
    }

    if (trimmed.startsWith("> ")) {
      return <blockquote key={`quote-${index}`} className="my-3 border-l-2 border-cyan-400/60 pl-4 text-slate-300">{trimmed.slice(2)}</blockquote>;
    }

    const parts = line.split(/(\[Slot-[^\]]+\])/g);
    return (
      <p key={`paragraph-${index}`} className="leading-7 text-slate-300">
        {parts.map((part, partIndex) => part.match(/^\[Slot-[^\]]+\]$/)
          ? <span key={`citation-${partIndex}`} className="mx-1 inline-flex rounded-md border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 align-baseline text-[11px] font-semibold text-cyan-300">{part}</span>
          : part)}
      </p>
    );
  });
}

export function NexusLMPanel({ conversationKey, manifest, pipelineSnapshot, transcripts, onManifestChange }: NexusLMPanelProps) {
  const [messages, setMessages] = useState<Message[]>([initialMessage(manifest)]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("ask");
  const [persona, setPersona] = useState<Persona>("editorial-coach");
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ChapterDraft | null>(null);
  const [selectedTranscriptLabel, setSelectedTranscriptLabel] = useState("");
  const [showMobileContext, setShowMobileContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyLoadedRef = useRef(false);

  const selectedTranscript = transcripts.find((transcript) => transcript.label === selectedTranscriptLabel) ?? transcripts[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    historyLoadedRef.current = false;
    void getNexusLMChat(conversationKey).then((archive) => {
      if (cancelled) return;
      setMessages(archive?.messages?.length ? archive.messages : [initialMessage(manifest)]);
      historyLoadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, [conversationKey]);

  useEffect(() => {
    if (!historyLoadedRef.current || !conversationKey) return;
    void saveNexusLMChat(conversationKey, messages);
  }, [conversationKey, messages]);

  useEffect(() => {
    if (selectedTranscriptLabel && transcripts.some((transcript) => transcript.label === selectedTranscriptLabel)) return;
    setSelectedTranscriptLabel(transcripts[0]?.label ?? "");
  }, [selectedTranscriptLabel, transcripts]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function clearConversation() {
    await deleteNexusLMChat(conversationKey);
    setMessages([initialMessage(manifest)]);
  }

  async function send(requestText?: string, requestMode?: Mode) {
    const instruction = (requestText ?? input).trim();
    if (!instruction || loading) return;
    const activeMode = requestMode ?? inferMode(instruction, mode);
    if (!manifest && transcripts.length === 0) {
      setMessages((current) => [...current, { role: "assistant", content: "Upload at least one transcript before starting a NexusLM conversation." }]);
      return;
    }
    if (activeMode === "edit" && !manifest) {
      setMessages((current) => [...current, { role: "assistant", content: "Load or finish a manuscript before requesting an edit." }]);
      return;
    }

    const userMessage = `${instruction}\n\n[Mode: ${MODES[activeMode].label}] [Persona: ${PERSONAS[persona].label}]`;
    const nextMessages = [...messages, { role: "user" as const, content: instruction }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      if (activeMode === "draft") {
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
              title: manifest?.bookTitle ?? pipelineSnapshot?.bookTitle ?? "Untitled book",
              chapters: manifest?.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })) ?? [],
              manuscriptChapter: manifest?.chapters.find((chapter) => chapter.number === chapterNumber) ?? null,
            },
            transcripts,
            vettingGuidance: messages
              .slice()
              .reverse()
              .find((message) => message.role === "assistant")?.content,
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

      if (activeMode !== "edit") {
        const res = await fetch("/api/ebook/nexuslm/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: instruction,
            mode: activeMode,
            persona: PERSONAS[persona].label,
            book: { title: manifest?.bookTitle ?? pipelineSnapshot?.bookTitle ?? "Untitled book", chapters: manifest?.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })) ?? [] },
            transcripts,
            history: compactHistory(nextMessages),
          }),
        });
        const json = await res.json() as { answer?: string; sources?: Source[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
        setSources(json.sources ?? []);
        const answer = json.answer ?? "NexusLM returned no answer.";
        setMessages((current) => [...current, { role: "assistant", content: answer }]);
        return;
      }

      const res = await fetch("/api/ebook/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest,
          instruction: `${MODES[activeMode].prompt}\nPersona: ${PERSONAS[persona].description}\n\nUser request:\n${userMessage}`,
          history: compactHistory(nextMessages),
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          transcriptSources: transcripts,
          dryRun: requestMode !== "edit",
        }),
      });
      const json = await res.json() as { manifest?: unknown; patch?: unknown; summary?: string; confidence?: "high" | "medium" | "low"; error?: string; clarificationNeeded?: string; needsClarification?: boolean; noChanges?: boolean; manifestVersion?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      if (json.needsClarification && json.clarificationNeeded) {
        setMessages((current) => [...current, { role: "assistant", content: json.clarificationNeeded! }]);
        return;
      }

      if (activeMode === "edit") {
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
      setMessages((current) => [...current, { role: "assistant", content: readableError(error) }]);
    } finally {
      setLoading(false);
    }
  }

  function addPendingDraft() {
    if (!pendingDraft) return;
    const baseManifest: EbookManifest = manifest ?? {
      jobId: conversationKey,
      bookTitle: pipelineSnapshot?.bookTitle ?? "Untitled book",
      subtitle: "",
      authorName: "the Author",
      frontMatter: {
        preface: "",
        introduction: "",
        conclusion: "",
        aboutAuthor: null,
        resourcesList: [],
        scriptureIndex: [],
      },
      chapters: [],
      totalWordCount: 0,
      allQuotes: [],
      generatedAt: new Date().toISOString(),
      selectedTemplate: "devotional",
      printSpec: {
        trimSize: "6x9",
        runningHeaders: true,
        bleed: false,
        cropMarks: false,
        editableProof: false,
        folioStyle: "center",
        frontMatterNumbering: "arabic",
        sectionOrnament: "rule",
        bodyTextAlign: "template",
        bodyFontFamily: "template",
        fontSizeScale: 1,
      },
    };
    const chapters: EbookManifest["chapters"] = baseManifest.chapters.some((chapter) => chapter.number === pendingDraft.number)
      ? baseManifest.chapters.map((chapter) => chapter.number === pendingDraft.number ? pendingDraft : chapter)
      : [...baseManifest.chapters, pendingDraft].sort((a, b) => a.number - b.number);
    const totalWordCount = chapters.reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0);
    onManifestChange({ ...baseManifest, chapters, totalWordCount }, `Chapter ${pendingDraft.number} added to the manuscript.`);
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
          history: compactHistory(messages),
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          transcriptSources: transcripts,
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
      setMessages((current) => [...current, { role: "assistant", content: readableError(error) }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-shell-950 lg:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-slate-800 lg:border-b-0 lg:border-r" aria-label="NexusLM conversation">
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-slate-800 px-4 lg:hidden">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">NexusLM conversation</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void clearConversation()} className="min-h-12 px-2 text-xs font-semibold text-slate-500">Clear</button>
            <button type="button" onClick={() => setShowMobileContext((current) => !current)} className="min-h-12 px-2 text-xs font-semibold text-cyan-300">
              {showMobileContext ? "Hide sources" : `Sources (${transcripts.length})`}
            </button>
          </div>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="mx-auto flex max-w-4xl flex-col gap-5">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={message.role === "user"
                ? "max-w-[88%] self-end rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm leading-6 text-cyan-50"
                : message.role === "system"
                  ? "rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-sm leading-6 text-slate-400"
                  : "rounded-xl border border-slate-800 bg-slate-950/50 px-5 py-5 text-sm leading-7 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"}>
                {message.role === "assistant" ? renderAssistantContent(message.content) : message.content}
              </div>
            ))}
            {loading && <div className="text-sm text-slate-500">NexusLM is thinking...</div>}
          </div>
        </div>

        <div className="shrink-0 bg-shell-950 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 lg:px-8 lg:pb-5 lg:pt-3">
          <div className="mx-auto max-w-4xl">
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
            <div className="rounded-2xl border border-slate-700 bg-slate-900 shadow-[0_8px_30px_rgba(0,0,0,0.22)] focus-within:border-cyan-400/60">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                placeholder={manifest || transcripts.length > 0 ? "Ask NexusLM about your book..." : "Upload a transcript to begin..."}
                disabled={(!manifest && transcripts.length === 0) || loading}
                rows={2}
                className="block w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:ring-0"
              />
              <div className="flex items-center justify-between gap-3 px-3 pb-2">
                <p className="text-[11px] text-slate-500">Enter to send · Shift+Enter for a new line</p>
                <button type="button" onClick={() => void send()} disabled={(!manifest && transcripts.length === 0) || !input.trim() || loading} className="min-h-10 rounded-xl bg-cyan-400 px-4 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">Send</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside className={`${showMobileContext ? "absolute inset-x-0 bottom-0 top-12 z-20 block" : "hidden"} max-h-[70dvh] w-full shrink-0 overflow-y-auto border-t border-slate-800 bg-shell-950 p-4 shadow-2xl lg:static lg:inset-auto lg:z-auto lg:block lg:max-h-none lg:w-[22rem] lg:border-t-0 lg:p-6 lg:shadow-none`}>
        <div className="mb-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-300">NexusLM</p>
              <h2 className="mt-2 text-lg font-semibold text-slate-100">Your book, in conversation</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">Ask questions, test the thinking, or make a focused edit.</p>
            </div>
            <button type="button" onClick={() => void clearConversation()} className="min-h-12 shrink-0 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-400">Clear history</button>
          </div>
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
                    disabled={loading}
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
