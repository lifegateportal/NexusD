"use client";

import { useEffect, useRef, useState } from "react";
import { ChapterDraftSchema, EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest } from "@/lib/schemas/ebook";
import type { ChapterDraft } from "@/lib/schemas/ebook";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import { deleteNexusLMChat, getNexusLMChat, saveNexusLMChat } from "@/lib/nexuslm-chat-store";
import { NEXUSLM_WRITING_STYLES, type NexusLMWritingStyle } from "@/lib/nexuslm-writing-styles";
import { NEXUSLM_AGENTS, type NexusLMAgent } from "@/lib/nexuslm-agents";
import { NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText, type NexusLMResponseLength } from "@/lib/nexuslm-response";

type NexusLMPanelProps = {
  conversationKey: string;
  manifest: EbookManifest | null;
  pipelineSnapshot: EbookPipelineSnapshot | null;
  transcripts: Array<{ label: string; text: string }>;
  onManifestChange: (manifest: EbookManifest, summary: string) => void;
  onOpenManuscript: () => void;
};

type Mode = "ask" | "socratic" | "plan" | "draft" | "edit";
type Persona = "editorial-coach" | "skeptical-reviewer" | "socratic-teacher" | "voice-guardian";
type Message = { role: "user" | "assistant" | "system"; content: string };
type Source = { id: string; label: string; excerpt: string };
type PendingEdit = { instruction: string; summary: string; confidence?: "high" | "medium" | "low"; scope: "chapter" | "focused"; transcriptLabel?: string };

function cleanAssistantLine(line: string): string {
  return sanitizeNexusLMText(line);
}

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
  plan: { label: "Plan Whole Book", prompt: "Design the whole book before drafting. Use every transcript slot to build a source-grounded architecture, chapter progression, and writing plan." },
  draft: { label: "Draft Chapter", prompt: "Write a complete chapter from the manuscript and transcript sources, then show the full draft for review." },
  edit: { label: "Edit / Enrich", prompt: "Propose precise manuscript improvements and apply only the requested changes." },
};

function inferMode(instruction: string, selectedMode: Mode): Mode {
  const text = instruction.toLowerCase();
  if (/\b(plan|outline|architect|roadmap|structure|whole book|entire book|book arc)\b/.test(text)) return "plan";
  if (/\b(write|draft|compose|create)\b.*\bchapter\b|\bchapter\b.*\b(write|draft|compose|create)\b/.test(text)) return "draft";
  if (/\b(vet|challenge|question|assumption|contradiction|weak|gap|skeptic|critique)\b/.test(text)) return "socratic";
  if (/\b(edit|rewrite|revise|enrich|expand|shorten|tighten|change|improve|fix)\b/.test(text)) return "edit";
  return selectedMode === "ask" ? "ask" : selectedMode;
}

function isChapterWideEdit(instruction: string): boolean {
  return /\b(?:rewrite|edit|revise|fix|improve|correct|clean|polish|enrich|apply)\b[\s\S]{0,100}\bchapter\s+\d+\b|\bchapter\s+\d+\b[\s\S]{0,100}\b(?:rewrite|edit|revise|fix|improve|correct|clean|polish|enrich|apply)\b/i.test(instruction)
    && !/\bsection\s+\d+[.\s-]+\d+\b/i.test(instruction);
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

function extractResponseTitle(content: string, chapterNumber: number): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^#{1,3}\s+(.+)$/)?.[1] ?? line.match(/^chapter\s+\d+\s*[:.-]\s*(.+)$/i)?.[1])
    .find((value): value is string => Boolean(value?.trim()));
  return sanitizeNexusLMText(heading?.trim() ?? `Chapter ${chapterNumber}`).slice(0, 300) || `Chapter ${chapterNumber}`;
}

function createEmptyManifest(conversationKey: string, pipelineSnapshot: EbookPipelineSnapshot | null): EbookManifest {
  return {
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
}

function formatChapterDraft(chapter: ChapterDraft): string {
  const sections = chapter.sections
    .map((section) => `${section.heading ? `${sanitizeNexusLMText(section.heading)}\n\n` : ""}${sanitizeNexusLMText(section.body)}`)
    .join("\n\n");
  return sanitizeNexusLMText(`CHAPTER ${chapter.number}: ${sanitizeNexusLMText(chapter.title)}\n\n${chapter.intro ? `${sanitizeNexusLMText(chapter.intro)}\n\n` : ""}${sections}${chapter.forwardQuestion ? `\n\nForward question: ${sanitizeNexusLMText(chapter.forwardQuestion)}` : ""}`);
}

function renderAssistantContent(content: string) {
  return content.split("\n").map((line, index) => {
    const raw = line.trim();
    if (!raw) return <div key={`space-${index}`} className="h-3" aria-hidden="true" />;

    const heading = raw.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const text = cleanAssistantLine(heading[1]);
      return text ? <h3 key={`heading-${index}`} className="mt-5 text-base font-semibold tracking-tight text-slate-100 first:mt-0">{text}</h3> : null;
    }

    const cleaned = cleanAssistantLine(raw.replace(/^>\s?/, ""));
    if (!cleaned) return null;
    if (raw.startsWith("> ")) {
      return <blockquote key={`quote-${index}`} className="my-3 border-l-2 border-cyan-400/60 pl-4 text-slate-300">{cleaned}</blockquote>;
    }

    const listItem = cleaned.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    return (
      <p key={`paragraph-${index}`} className={`leading-7 text-slate-300 ${listItem ? "pl-4" : ""}`}>
        {listItem ? `• ${listItem[1]}` : cleaned}
      </p>
    );
  });
}

export function NexusLMPanel({ conversationKey, manifest, pipelineSnapshot, transcripts, onManifestChange, onOpenManuscript }: NexusLMPanelProps) {
  const [messages, setMessages] = useState<Message[]>([initialMessage(manifest)]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("ask");
  const [persona, setPersona] = useState<Persona>("editorial-coach");
  const [agent, setAgent] = useState<NexusLMAgent>("NexusChat");
  const [writingStyle, setWritingStyle] = useState<NexusLMWritingStyle>("book-prose");
  const [responseLength, setResponseLength] = useState<NexusLMResponseLength>("default");
  const [nexusLMTemperature, setNexusLMTemperature] = useState(0.3);
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

  function downloadLatestResponse(extension: "md" | "txt" | "html") {
    const answer = messages.slice().reverse().find((message) => message.role === "assistant")?.content;
    if (!answer) return;
    const cleanAnswer = sanitizeNexusLMText(answer);
    const title = (manifest?.bookTitle ?? pipelineSnapshot?.bookTitle ?? "nexuslm-response")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "nexuslm-response";
    const escapeHtml = (value: string) => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
    const html = cleanAnswer.split(/\n\s*\n/).map((block) => {
      const escaped = escapeHtml(block).replace(/\n/g, "<br>");
      if (escaped.startsWith("### ")) return `<h3>${escaped.slice(4)}</h3>`;
      if (escaped.startsWith("## ")) return `<h2>${escaped.slice(3)}</h2>`;
      if (escaped.startsWith("# ")) return `<h1>${escaped.slice(2)}</h1>`;
      if (escaped.startsWith("&gt; ")) return `<blockquote>${escaped.slice(5)}</blockquote>`;
      return `<p>${escaped}</p>`;
    }).join("\n");
    const content = extension === "html"
      ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(manifest?.bookTitle ?? "NexusLM response")}</title><style>body{max-width:760px;margin:48px auto;padding:0 24px;font:18px/1.7 Georgia,serif;color:#172033}h1,h2,h3{line-height:1.2}blockquote{border-left:3px solid #0891b2;padding-left:16px;color:#475569}</style></head><body>${html}</body></html>`
      : cleanAnswer;
    const blob = new Blob([content], { type: extension === "html" ? "text/html" : extension === "md" ? "text/markdown" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title}-nexuslm.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  async function send(requestText?: string, requestMode?: Mode, draftTranscriptScope: "all" | "selected" = "all") {
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
            agent,
            writingStyle,
            responseLength,
            llmTemperature: nexusLMTemperature,
            book: {
              title: manifest?.bookTitle ?? pipelineSnapshot?.bookTitle ?? "Untitled book",
              chapters: manifest?.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })) ?? [],
              manuscriptChapter: manifest?.chapters.find((chapter) => chapter.number === chapterNumber) ?? null,
            },
            transcripts: draftTranscriptScope === "selected" && selectedTranscript ? [selectedTranscript] : transcripts,
            transcriptScope: draftTranscriptScope,
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
            agent,
            writingStyle,
            responseLength,
            llmTemperature: nexusLMTemperature,
            book: { title: manifest?.bookTitle ?? pipelineSnapshot?.bookTitle ?? "Untitled book", chapters: manifest?.chapters.map((chapter) => ({ number: chapter.number, title: chapter.title })) ?? [] },
            manuscript: manifest ? { frontMatter: manifest.frontMatter, chapters: manifest.chapters } : null,
            transcripts,
            history: compactHistory(nextMessages),
          }),
        });
        const json = await res.json() as { answer?: string; sources?: Source[]; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
        setSources(json.sources ?? []);
        const answer = sanitizeNexusLMText(json.answer ?? "NexusLM returned no answer.");
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
          responseLength,
          llmTemperature: nexusLMTemperature,
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          transcriptSources: transcripts,
          selectedTranscriptLabel: selectedTranscript?.label,
          dryRun: requestMode !== "edit",
        }),
      });
      const json = await res.json() as { manifest?: unknown; patch?: unknown; summary?: string; confidence?: "high" | "medium" | "low"; error?: string; clarificationNeeded?: string; needsClarification?: boolean; noChanges?: boolean; manifestVersion?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      if (json.needsClarification && json.clarificationNeeded) {
      setMessages((current) => [...current, { role: "assistant", content: sanitizeNexusLMText(json.clarificationNeeded!) }]);
        return;
      }

      if (activeMode === "edit") {
        if (!json.patch || !json.summary) throw new Error("NexusLM returned no editable proposal.");
        setPendingEdit({
          instruction,
          summary: json.summary,
          confidence: json.confidence,
          scope: isChapterWideEdit(instruction) ? "chapter" : "focused",
          transcriptLabel: selectedTranscript?.label,
        });
        setMessages((current) => [...current, { role: "assistant", content: sanitizeNexusLMText(`Proposal ready for review: ${json.summary}`) }]);
        return;
      }

      setMessages((current) => [...current, {
        role: "assistant",
        content: sanitizeNexusLMText(json.summary ?? (json.noChanges ? "No manuscript changes were applied." : "NexusLM completed the request.")),
      }]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: readableError(error) }]);
    } finally {
      setLoading(false);
    }
  }

  function addResponseAsChapter(content: string): void {
    const body = content.trim();
    if (!body) return;

    const baseManifest = manifest ?? createEmptyManifest(conversationKey, pipelineSnapshot);
    const number = baseManifest.chapters.reduce((highest, chapter) => Math.max(highest, chapter.number), 0) + 1;
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const chapter: ChapterDraft = {
      number,
      title: extractResponseTitle(body, number),
      intro: "",
      epigraph: "",
      sections: [{
        chapterNumber: number,
        sectionNumber: 1,
        heading: "",
        body,
        wordCount,
        status: "complete",
      }],
      forwardQuestion: "",
      keyTakeaways: [],
      reflectionQuestions: [],
      totalWordCount: wordCount,
      status: "complete",
    };
    const chapters = [...baseManifest.chapters, chapter].sort((left, right) => left.number - right.number);
    const nextManifest = {
      ...baseManifest,
      chapters,
      totalWordCount: chapters.reduce((total, item) => total + (item.totalWordCount ?? 0), 0),
      generatedAt: new Date().toISOString(),
    };
    const parsed = EbookManifestSchema.safeParse(nextManifest);
    if (!parsed.success) {
      setMessages((current) => [...current, { role: "assistant", content: "The response could not be added to Ebook Studio because the chapter data was invalid." }]);
      return;
    }
    onManifestChange(parsed.data, `Chapter ${number} moved into Ebook Studio.`);
    onOpenManuscript();
  }

  function addPendingDraft() {
    if (!pendingDraft) return;
    const baseManifest = manifest ?? createEmptyManifest(conversationKey, pipelineSnapshot);
    const chapters: EbookManifest["chapters"] = baseManifest.chapters.some((chapter) => chapter.number === pendingDraft.number)
      ? baseManifest.chapters.map((chapter) => chapter.number === pendingDraft.number ? pendingDraft : chapter)
      : [...baseManifest.chapters, pendingDraft].sort((a, b) => a.number - b.number);
    const totalWordCount = chapters.reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0);
    onManifestChange({ ...baseManifest, chapters, totalWordCount }, `Chapter ${pendingDraft.number} added to the manuscript.`);
    setMessages((current) => [...current, { role: "assistant", content: `Chapter ${pendingDraft.number} added to the manuscript.` }]);
    setPendingDraft(null);
    onOpenManuscript();
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
          responseLength,
          llmTemperature: nexusLMTemperature,
          pipeline: pipelineSnapshot ?? undefined,
          manifestVersion: (manifest as Record<string, unknown>).__version as string | undefined,
          transcriptSources: transcripts,
          selectedTranscriptLabel: pendingEdit.transcriptLabel,
          dryRun: false,
        }),
      });
      const json = await res.json() as { manifest?: unknown; summary?: string; error?: string; manifestVersion?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      const parsed = EbookManifestSchema.safeParse(json.manifest);
      if (!parsed.success) throw new Error("NexusLM returned an invalid manuscript.");
      const nextManifest = json.manifestVersion ? { ...parsed.data, __version: json.manifestVersion } : parsed.data;
      onManifestChange(nextManifest as EbookManifest, json.summary ?? "Manuscript updated.");
      setMessages((current) => [...current, { role: "assistant", content: sanitizeNexusLMText(json.summary ?? "Approved manuscript changes applied.") }]);
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
                {message.role === "assistant" ? (
                  <>
                    {renderAssistantContent(message.content)}
                    {message.content.trim() && (
                      <div className="mt-4 flex justify-end">
                        <button
                          type="button"
                          onClick={() => addResponseAsChapter(message.content)}
                          disabled={loading}
                          className="min-h-12 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 text-xs font-bold text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Add as chapter to Ebook Studio
                        </button>
                      </div>
                    )}
                  </>
                ) : message.content}
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
                  <button type="button" onClick={() => void applyPendingEdit()} disabled={loading} className="min-h-12 rounded-xl bg-amber-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-40">
                    {pendingEdit.scope === "chapter" ? "Apply all chapter fixes" : "Apply change"}
                  </button>
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

        <label className="mt-6 block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-agent">Agent</label>
        <select id="nexuslm-agent" value={agent} onChange={(event) => setAgent(event.target.value as NexusLMAgent)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(NEXUSLM_AGENTS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-500">{NEXUSLM_AGENTS[agent].description}</p>

        <label className="mt-6 block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-writing-style">Writing form</label>
        <select id="nexuslm-writing-style" value={writingStyle} onChange={(event) => setWritingStyle(event.target.value as NexusLMWritingStyle)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(NEXUSLM_WRITING_STYLES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-500">{NEXUSLM_WRITING_STYLES[writingStyle].description}</p>

        <label className="mt-6 block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-response-length">Response length</label>
        <select id="nexuslm-response-length" value={responseLength} onChange={(event) => setResponseLength(event.target.value as NexusLMResponseLength)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(NEXUSLM_RESPONSE_LENGTHS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-500">{NEXUSLM_RESPONSE_LENGTHS[responseLength].description}</p>

        <label className="mt-6 block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-temperature">NexusLM temperature</label>
        <input
          id="nexuslm-temperature"
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={nexusLMTemperature}
          onChange={(event) => {
            const next = Number.parseFloat(event.target.value);
            if (Number.isNaN(next)) return;
            const bounded = Math.min(1, Math.max(0, next));
            setNexusLMTemperature(Number(bounded.toFixed(2)));
          }}
          className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200"
        />
        <p className="mt-2 text-xs leading-5 text-slate-500">Controls NexusLM generation randomness. Range: 0.00 to 1.00.</p>

        <div className="mt-6 border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Download latest response</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">Save the most recent NexusLM answer without opening Book Studio.</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["md", "txt", "html"] as const).map((extension) => (
              <button key={extension} type="button" onClick={() => downloadLatestResponse(extension)} disabled={!messages.some((message) => message.role === "assistant")} className="min-h-12 rounded-xl border border-slate-700 px-2 text-xs font-semibold text-slate-300 disabled:cursor-not-allowed disabled:opacity-40">
                {extension === "md" ? "Markdown" : extension.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-slate-500">Mode</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.entries(MODES).map(([value, item]) => (
            <button key={value} type="button" onClick={() => setMode(value as Mode)} className={`min-h-12 rounded-xl border px-2 text-xs font-semibold ${mode === value ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300" : "border-slate-700 text-slate-400"}`}>{item.label}</button>
          ))}
        </div>

        <div className="mt-6 border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Connected context</p>
          <p className="mt-2 text-sm text-slate-200">{manifest?.bookTitle ?? "No book loaded"}</p>
          {manifest && <p className="mt-1 text-xs text-slate-500">{manifest.chapters.length} chapters · {manifest.totalWordCount.toLocaleString()} words</p>}
          <p className="mt-3 text-xs text-slate-500">Pipeline: <span className="text-slate-300">{pipelineSnapshot?.stage ?? "not started"}</span></p>
          <p className="mt-3 text-xs text-slate-500">Manuscript: <span className="text-slate-300">{manifest ? `${manifest.chapters.length} written chapter${manifest.chapters.length === 1 ? "" : "s"}` : "not loaded"}</span></p>
          <p className="mt-1 text-xs text-slate-500">Transcript sources: <span className="text-slate-300">{transcripts.length}</span></p>
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
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => { setMode("draft"); void send(`Write a complete chapter from ${selectedTranscript.label} only. Shape the introduction and body freely from this slot's material.`, "draft", "selected"); }}
                      disabled={loading}
                      className="min-h-12 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 text-sm font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Draft from {selectedTranscript.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMode("draft"); void send("Write a complete chapter using all available transcript slots and the existing manuscript context. Choose the strongest material and shape the chapter freely.", "draft", "all"); }}
                      disabled={loading}
                      className="min-h-12 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 text-sm font-semibold text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Draft from all slots
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="border-t border-slate-800 pt-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Sources consulted</p>
          {sources.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-slate-600">Ask a question to see the manuscript and transcript excerpts NexusLM used.</p>
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
