"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChapterDraftSchema, EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest } from "@/lib/schemas/ebook";
import type { ChapterDraft } from "@/lib/schemas/ebook";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import {
  createNexusLMChat,
  deleteNexusLMChat,
  getNexusLMChat,
  listNexusLMChats,
  renameNexusLMChat,
  saveNexusLMChat,
  type NexusLMChatAttachment,
  type NexusLMChatSummary,
} from "@/lib/nexuslm-chat-store";
import { NEXUSLM_WRITING_STYLES, type NexusLMWritingStyle } from "@/lib/nexuslm-writing-styles";
import { NEXUSLM_AGENTS, type NexusLMAgent } from "@/lib/nexuslm-agents";
import { NEXUSLM_RESPONSE_LENGTHS, sanitizeNexusLMText, type NexusLMResponseLength } from "@/lib/nexuslm-response";
import {
  buildManifestChangeEntries,
  clearEbookUndoSnapshot,
  loadEbookUndoSnapshot,
  saveEbookUndoSnapshot,
} from "@/lib/ebook-change-control";
import type { EbookChangeEntry, EbookUndoSnapshot } from "@/lib/ebook-change-control";

type NexusLMPanelProps = {
  conversationKey: string;
  manifest: EbookManifest | null;
  pipelineSnapshot: EbookPipelineSnapshot | null;
  transcripts: Array<{ label: string; text: string }>;
  onManifestChange: (manifest: EbookManifest, summary: string) => void;
};

type Mode = "ask" | "socratic" | "plan" | "draft" | "edit";
type ContextMode = "auto" | "general" | "book";
type Persona = "editorial-coach" | "skeptical-reviewer" | "socratic-teacher" | "voice-guardian";
type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  format?: "plain" | "markdown";
  attachments?: Array<{ id: string; name: string }>;
};
type Source = { id: string; label: string; excerpt: string };
type ChatAttachment = NexusLMChatAttachment;
type GeneralRequest = {
  instruction: string;
  mode: "ask" | "socratic" | "plan";
  attachments: ChatAttachment[];
  processEntireDocument: boolean;
};
type LibraryPatch = {
  slug: string;
  title?: string;
  subtitle?: string;
  authorName?: string;
  synopsis?: string;
  coverAccent?: string;
};
type PendingEdit = {
  instruction: string;
  summary: string;
  confidence?: "high" | "medium" | "low";
  scope: "chapter" | "focused";
  transcriptLabel?: string;
  baseManifest: EbookManifest;
  proposedManifest: EbookManifest;
  changes: EbookChangeEntry[];
  selectedPaths: string[];
  manifestVersion: string;
  libraryPatch?: LibraryPatch;
};
type AuditConceptDuplicate = {
  type: string;
  title: string;
  description: string;
  severity: "minor" | "major";
  locations: Array<{ location: string; excerpt: string }>;
  recommendation: string;
};
type AuditSimilarPair = { locationA: string; locationB: string; similarity: number };
type AuditRepetition = { phrase: string; count: number; reason: string | null; alternatives: string[] };
type AuditOverusedWord = { word: string; count: number; frequency: string; alternatives: string[] };
type BookAuditReport = {
  conceptDuplicates: AuditConceptDuplicate[];
  similarPairs: AuditSimilarPair[];
  repetitions: AuditRepetition[];
  overusedWords: AuditOverusedWord[];
  totalConceptDuplicates: number;
  totalSimilarPairs: number;
  totalRepetitionPhrases: number;
  totalOverusedWords: number;
};

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

function isAuditIntent(text: string): boolean {
  return /\b(audit|full[\s-]?audit|review\s+the\s+book|analyse|analyze|repetit|duplicat|overused\s+words?|similar\s+sections?|quality\s+check|book\s+report|flag\s+issues|check\s+(?:the\s+)?book|find\s+(issues|problems|errors|duplicates?)|sounds?\s+redundant|too\s+repetitive|check\s+for\s+(duplicates?|repetition|issues|problems))\b/i.test(text);
}

function formatAuditReport(report: BookAuditReport): string {
  const total = report.totalConceptDuplicates + report.totalSimilarPairs + report.totalRepetitionPhrases;
  const lines = [
    "BOOK AUDIT COMPLETE",
    total === 0 ? "No significant issues found." : `${total} significant issue${total === 1 ? "" : "s"} flagged.`,
  ];
  if (report.conceptDuplicates.length > 0) {
    lines.push("", `CONCEPT DUPLICATES (${report.conceptDuplicates.length})`);
    for (const duplicate of report.conceptDuplicates.slice(0, 8)) {
      lines.push(`• ${duplicate.title} [${duplicate.severity}]`);
      lines.push(`  ${duplicate.locations.map((location) => location.location).join(" · ")}`);
    }
  }
  if (report.similarPairs.length > 0) {
    lines.push("", `SIMILAR SECTIONS (${report.similarPairs.length})`);
    for (const pair of report.similarPairs.slice(0, 8)) {
      lines.push(`• ${pair.locationA} ↔ ${pair.locationB} (${Math.round(pair.similarity * 100)}%)`);
    }
  }
  if (report.repetitions.length > 0) {
    lines.push("", `REPEATED PHRASES (${report.repetitions.length})`);
    for (const repetition of report.repetitions.slice(0, 8)) {
      lines.push(`• "${repetition.phrase}" ×${repetition.count}`);
    }
  }
  if (report.overusedWords.length > 0) {
    lines.push("", `OVERUSED WORDS (${report.overusedWords.length})`);
    for (const word of report.overusedWords.slice(0, 8)) {
      lines.push(`• "${word.word}" ×${word.count} (${word.frequency})`);
    }
  }
  return lines.join("\n");
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
    : { role: "system", content: "NexusLM is ready for general conversation. Ask anything, attach a text, HTML, or PDF document, or connect a book when you want source-grounded manuscript help." };
}

function formatChapterDraft(chapter: ChapterDraft): string {
  const sections = chapter.sections
    .map((section) => `${section.heading ? `${sanitizeNexusLMText(section.heading)}\n\n` : ""}${sanitizeNexusLMText(section.body)}`)
    .join("\n\n");
  return sanitizeNexusLMText(`CHAPTER ${chapter.number}: ${sanitizeNexusLMText(chapter.title)}\n\n${chapter.intro ? `${sanitizeNexusLMText(chapter.intro)}\n\n` : ""}${sections}${chapter.forwardQuestion ? `\n\nForward question: ${sanitizeNexusLMText(chapter.forwardQuestion)}` : ""}`);
}

function CopyMessageButton({ content }: { content: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1600);
    } catch {
      setStatus("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="min-h-12 rounded-lg border border-slate-700 px-3 text-[11px] font-semibold text-slate-400"
      aria-label="Copy response"
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

function renderInlineMarkdown(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`inline-code-${index}`} className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-200">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`bold-${index}`} className="font-semibold text-slate-100">{part.slice(2, -2)}</strong>;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return <a key={`link-${index}`} href={link[2]} target="_blank" rel="noreferrer" className="text-cyan-300 underline underline-offset-2">{link[1]}</a>;
    }
    return part;
  });
}

function renderAssistantContent(content: string, markdown = false) {
  const lines = content.split("\n");
  const rendered: ReactNode[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const pushCodeBlock = (key: string) => {
    const code = codeLines.join("\n");
    rendered.push(
      <div key={key} className="my-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Code</span>
          <CopyMessageButton content={code} />
        </div>
        <pre className="overflow-x-auto p-4 text-xs leading-6 text-slate-200"><code>{code}</code></pre>
      </div>,
    );
    codeLines = [];
  };

  lines.forEach((line, index) => {
    const raw = line.trim();
    if (markdown && raw.startsWith("```")) {
      if (inCodeBlock) {
        pushCodeBlock(`code-${index}`);
      }
      inCodeBlock = !inCodeBlock;
      return;
    }
    if (markdown && inCodeBlock) {
      codeLines.push(line);
      return;
    }
    if (!raw) {
      rendered.push(<div key={`space-${index}`} className="h-3" aria-hidden="true" />);
      return;
    }

    const heading = raw.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const text = markdown ? heading[1] : cleanAssistantLine(heading[1]);
      rendered.push(text ? <h3 key={`heading-${index}`} className="mt-5 text-base font-semibold tracking-tight text-slate-100 first:mt-0">{markdown ? renderInlineMarkdown(text) : text}</h3> : null);
      return;
    }

    const cleaned = markdown ? raw.replace(/^>\s?/, "") : cleanAssistantLine(raw.replace(/^>\s?/, ""));
    if (!cleaned) return;
    if (raw.startsWith("> ")) {
      rendered.push(<blockquote key={`quote-${index}`} className="my-3 border-l-2 border-cyan-400/60 pl-4 text-slate-300">{markdown ? renderInlineMarkdown(cleaned) : cleaned}</blockquote>);
      return;
    }

    const listItem = cleaned.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    rendered.push(
      <p key={`paragraph-${index}`} className={`leading-7 text-slate-300 ${listItem ? "pl-4" : ""}`}>
        {listItem ? `• ${markdown ? renderInlineMarkdown(listItem[1]) : listItem[1]}` : markdown ? renderInlineMarkdown(cleaned) : cleaned}
      </p>,
    );
  });

  if (inCodeBlock) pushCodeBlock("code-open");
  return rendered;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not create a preview for ${file.name}.`));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function looksLikeHtmlDocument(content: string): boolean {
  const start = content.replace(/^\uFEFF/, "").trimStart().slice(0, 4000);
  return /^<!doctype\s+html\b/i.test(start)
    || /^<html(?:\s[^>]*)?>/i.test(start)
    || (/<head(?:\s[^>]*)?>/i.test(start) && /<body(?:\s[^>]*)?>/i.test(content));
}

function attachmentKind(attachment: ChatAttachment): ChatAttachment["kind"] {
  return attachment.kind === "text" && looksLikeHtmlDocument(attachment.content)
    ? "html"
    : attachment.kind;
}

function DocumentPreview({ attachment }: { attachment: ChatAttachment }) {
  const kind = attachmentKind(attachment);

  if (kind === "pdf") {
    return attachment.previewDataUrl ? (
      <iframe
        title={attachment.name}
        src={attachment.previewDataUrl}
        className="h-[52dvh] min-h-[22rem] w-full rounded-xl border border-slate-800 bg-white"
      />
    ) : (
      <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
        A preview is not available for this PDF in the current chat session.
      </p>
    );
  }

  if (kind === "html") {
    return (
      <iframe
        title={attachment.name}
        srcDoc={attachment.content}
        sandbox=""
        className="h-[52dvh] min-h-[22rem] w-full rounded-xl border border-slate-800 bg-white"
      />
    );
  }

  return (
    <pre className="h-[52dvh] min-h-[22rem] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-6 text-slate-300">
      {attachment.content}
    </pre>
  );
}

export function NexusLMPanel({ conversationKey, manifest, pipelineSnapshot, transcripts, onManifestChange }: NexusLMPanelProps) {
  const [messages, setMessages] = useState<Message[]>([initialMessage(manifest)]);
  const [activeConversationKey, setActiveConversationKey] = useState(conversationKey);
  const [chatHistory, setChatHistory] = useState<NexusLMChatSummary[]>([]);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [input, setInput] = useState("");
  const [contextMode, setContextMode] = useState<ContextMode>("auto");
  const [mode, setMode] = useState<Mode>("ask");
  const [persona, setPersona] = useState<Persona>("editorial-coach");
  const [agent, setAgent] = useState<NexusLMAgent>("NexusChat");
  const [writingStyle, setWritingStyle] = useState<NexusLMWritingStyle>("book-prose");
  const [responseLength, setResponseLength] = useState<NexusLMResponseLength>("default");
  const [nexusLMTemperature, setNexusLMTemperature] = useState(0.3);
  const [loading, setLoading] = useState(false);
  const [canAbort, setCanAbort] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [processEntireDocument, setProcessEntireDocument] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [lastGeneralRequest, setLastGeneralRequest] = useState<GeneralRequest | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [showDocumentPreview, setShowDocumentPreview] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [pendingDraft, setPendingDraft] = useState<ChapterDraft | null>(null);
  const [auditReport, setAuditReport] = useState<BookAuditReport | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<EbookUndoSnapshot | null>(null);
  const [showProposalDiff, setShowProposalDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedTranscriptLabel, setSelectedTranscriptLabel] = useState("");
  const [showMobileContext, setShowMobileContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeScopeRef = useRef(conversationKey);
  const historyLoadedRef = useRef(false);
  const hasBookContext = Boolean(manifest || transcripts.length > 0);
  const useBookContext = contextMode === "book" || (contextMode === "auto" && hasBookContext);

  useEffect(() => {
    try {
      setActiveConversationKey(window.localStorage.getItem(`nexuslm-active-chat:${conversationKey}`) ?? conversationKey);
    } catch {
      setActiveConversationKey(conversationKey);
    }
  }, [conversationKey]);

  useEffect(() => {
    if (activeScopeRef.current !== conversationKey) {
      activeScopeRef.current = conversationKey;
      return;
    }
    if (activeConversationKey === conversationKey) return;
    try {
      window.localStorage.setItem(`nexuslm-active-chat:${conversationKey}`, activeConversationKey);
    } catch (error) {
      setAttachmentError(`Active chat could not be remembered: ${readableError(error)}`);
    }
  }, [activeConversationKey, conversationKey]);

  useEffect(() => {
    setUndoSnapshot(manifest?.jobId ? loadEbookUndoSnapshot(manifest.jobId) : null);
    setShowHistory(false);
  }, [manifest?.jobId]);

  const selectedTranscript = transcripts.find((transcript) => transcript.label === selectedTranscriptLabel) ?? transcripts[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    historyLoadedRef.current = false;
    void getNexusLMChat(activeConversationKey)
      .then((archive) => {
        if (cancelled) return;
        setMessages(archive?.messages?.length ? archive.messages : [initialMessage(manifest)]);
        setAttachments(archive?.attachments ?? []);
        setProcessEntireDocument(false);
        setSelectedAttachmentId(archive?.attachments?.[0]?.id ?? null);
        setShowDocumentPreview(false);
        setLastGeneralRequest(null);
        historyLoadedRef.current = true;
      })
      .catch((error) => {
        if (cancelled) return;
        historyLoadedRef.current = true;
        setAttachmentError(`Chat history could not be loaded: ${readableError(error)}`);
      });
    return () => { cancelled = true; };
  }, [activeConversationKey]);

  useEffect(() => {
    if (!historyLoadedRef.current || !activeConversationKey) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveNexusLMChat(activeConversationKey, messages, {
        scope: conversationKey,
        attachments,
      })
        .then(() => listNexusLMChats(conversationKey).then(setChatHistory))
        .catch((error) => setAttachmentError(`Chat history could not be saved: ${readableError(error)}`));
    }, 300);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeConversationKey, attachments, conversationKey, messages]);

  useEffect(() => {
    void listNexusLMChats(conversationKey)
      .then(setChatHistory)
      .catch((error) => setAttachmentError(`Chat history could not be listed: ${readableError(error)}`));
  }, [conversationKey]);

  useEffect(() => {
    if (selectedTranscriptLabel && transcripts.some((transcript) => transcript.label === selectedTranscriptLabel)) return;
    setSelectedTranscriptLabel(transcripts[0]?.label ?? "");
  }, [selectedTranscriptLabel, transcripts]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function startNewConversation(): Promise<void> {
    if (loading) return;
    try {
      const id = await createNexusLMChat(conversationKey);
      historyLoadedRef.current = false;
      setActiveConversationKey(id);
      setMessages([initialMessage(manifest)]);
      setAttachments([]);
      setProcessEntireDocument(false);
      setSelectedAttachmentId(null);
      setLastGeneralRequest(null);
      setAttachmentError(null);
      setShowDocumentPreview(false);
      setShowChatHistory(false);
    } catch (error) {
      setAttachmentError(`New chat could not be created: ${readableError(error)}`);
    }
  }

  function openSavedConversation(id: string): void {
    if (loading || id === activeConversationKey) {
      setShowChatHistory(false);
      return;
    }
    historyLoadedRef.current = false;
    setActiveConversationKey(id);
    setShowDocumentPreview(false);
    setShowChatHistory(false);
  }

  async function removeSavedConversation(id: string): Promise<void> {
    if (loading) return;
    try {
      await deleteNexusLMChat(id);
      if (id === activeConversationKey) {
        await startNewConversation();
        return;
      }
      setChatHistory(await listNexusLMChats(conversationKey));
    } catch (error) {
      setAttachmentError(`Chat could not be deleted: ${readableError(error)}`);
    }
  }

  async function renameSavedConversation(chat: NexusLMChatSummary): Promise<void> {
    if (loading) return;
    const nextTitle = window.prompt("Name this chat", chat.title)?.trim();
    if (!nextTitle || nextTitle === chat.title) return;
    try {
      await renameNexusLMChat(chat.id, nextTitle);
      setChatHistory(await listNexusLMChats(conversationKey));
    } catch (error) {
      setAttachmentError(`Chat could not be renamed: ${readableError(error)}`);
    }
  }

  async function addFiles(fileList: FileList | File[]): Promise<void> {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    if (attachments.length + files.length > 8) {
      setAttachmentError("You can keep up to 8 documents in a chat.");
      return;
    }

    const accepted: ChatAttachment[] = [];
    for (const file of files) {
      const extension = file.name.toLowerCase().split(".").pop() ?? "";
      const isPdf = extension === "pdf" || file.type === "application/pdf";
      const isHtmlFilename = /\.(?:html?|xhtml)(?:\.txt)?$/i.test(file.name);
      const isHtml = isHtmlFilename || file.type === "text/html";
      const isText = file.type.startsWith("text/")
        || ["csv", "css", "json", "js", "jsx", "md", "tsx", "ts", "xml", "yaml", "yml", "srt", "log"].includes(extension);
      if (!isText && !isHtml && !isPdf) {
        setAttachmentError(`${file.name} is not supported yet. Use text, HTML, Markdown, or PDF documents.`);
        continue;
      }
      if ((!isPdf && file.size > 6_000_000) || (isPdf && file.size > 20_000_000)) {
        setAttachmentError(`${file.name} is too large. Text/HTML files may be up to 6 MB; PDFs may be up to 20 MB.`);
        continue;
      }
      try {
        let content = "";
        let previewDataUrl: string | undefined;
        if (isPdf) {
          const formData = new FormData();
          formData.append("file", file);
          const response = await fetch("/api/nexuslm/attachment", { method: "POST", body: formData });
          const payload = await response.json() as { text?: string; error?: string };
          if (!response.ok || !payload.text) {
            throw new Error(payload.error ?? `Could not extract text from ${file.name}.`);
          }
          content = payload.text;
          previewDataUrl = await readDataUrl(file);
        } else {
          content = await file.text();
        }
        if (!content.trim()) {
          setAttachmentError(`${file.name} is empty.`);
          continue;
        }
        const detectedKind = isPdf || !looksLikeHtmlDocument(content) ? (isPdf ? "pdf" : "text") : "html";
        accepted.push({
          id: `${file.name}-${file.lastModified}-${accepted.length}`,
          name: file.name,
          content,
          size: file.size,
          kind: isPdf ? "pdf" : isHtml || detectedKind === "html" ? "html" : "text",
          mimeType: file.type || (isPdf ? "application/pdf" : isHtml || detectedKind === "html" ? "text/html" : "text/plain"),
          previewDataUrl,
        });
      } catch (error) {
        setAttachmentError(`${file.name} could not be read: ${readableError(error)}`);
      }
    }

    if (accepted.length > 0) {
      const totalCharacters = [...attachments, ...accepted].reduce((total, attachment) => total + attachment.content.length, 0);
      if (totalCharacters > 12_000_000) {
        setAttachmentError("Attached document text is too large for one request. Keep the combined text at or below 12 MB.");
        return;
      }
      setAttachments((current) => [...current, ...accepted]);
      setSelectedAttachmentId((current) => current ?? accepted[0].id);
      setAttachmentError(null);
    }
  }

  function stopGenerating(): void {
    abortControllerRef.current?.abort();
  }

  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null;

  async function streamGeneralResponse(
    instruction: string,
    activeMode: "ask" | "socratic" | "plan",
    nextMessages: Message[],
    requestAttachments: ChatAttachment[],
    shouldProcessEntireDocument: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setCanAbort(true);
    setMessages([...nextMessages, { role: "assistant", content: "", format: "markdown" }]);
    let answer = "";

    const updateAnswer = (content: string) => {
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant" && last.format === "markdown") {
          return [...current.slice(0, -1), { ...last, content }];
        }
        return [...current, { role: "assistant", content, format: "markdown" }];
      });
    };

    try {
      const response = await fetch("/api/nexuslm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          query: instruction,
          mode: activeMode,
          persona: PERSONAS[persona].label,
          agent,
          writingStyle,
          responseLength,
          llmTemperature: nexusLMTemperature,
          processEntireDocument: shouldProcessEntireDocument,
          attachments: requestAttachments.map(({ name, content, kind, mimeType }) => ({ name, content, kind, mimeType })),
          history: compactHistory(nextMessages),
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("NexusLM returned no response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        updateAnswer(answer);
      }
      answer += decoder.decode();
      updateAnswer(answer);
      if (!answer.trim()) throw new Error("NexusLM returned an empty response.");
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      updateAnswer(stopped ? "Response stopped." : readableError(error));
    } finally {
      abortControllerRef.current = null;
      setCanAbort(false);
    }
  }

  async function clearConversation() {
    try {
      await deleteNexusLMChat(activeConversationKey);
      await startNewConversation();
    } catch (error) {
      setAttachmentError(`Chat history could not be cleared: ${readableError(error)}`);
    }
  }

  function downloadLatestResponse(extension: "md" | "txt" | "html") {
    const latest = messages.slice().reverse().find((message) => message.role === "assistant");
    if (!latest?.content) return;
    const cleanAnswer = latest.format === "markdown" ? latest.content.trim() : sanitizeNexusLMText(latest.content);
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

  function retryLastResponse(): void {
    if (!lastGeneralRequest || loading) return;
    void send(lastGeneralRequest.instruction, lastGeneralRequest.mode, "all", {
      retry: true,
      forceGeneral: true,
      requestAttachments: lastGeneralRequest.attachments,
      processEntireDocument: lastGeneralRequest.processEntireDocument,
    });
  }

  async function send(
    requestText?: string,
    requestMode?: Mode,
    draftTranscriptScope: "all" | "selected" = "all",
    options?: { retry?: boolean; forceGeneral?: boolean; requestAttachments?: ChatAttachment[]; processEntireDocument?: boolean },
  ) {
    const instruction = (requestText ?? input).trim();
    if (!instruction || loading) return;
    const activeMode = requestMode ?? inferMode(instruction, mode);
    const requestUsesBook = options?.forceGeneral ? false : useBookContext;
    if (contextMode === "book" && !options?.forceGeneral && !hasBookContext) {
      setMessages((current) => [...current,
        { role: "user", content: instruction },
        { role: "assistant", content: "Book context is not connected. Switch Context to General, or load a manuscript/transcript first." },
      ]);
      return;
    }
    if ((activeMode === "edit" || activeMode === "draft") && !requestUsesBook) {
      setMessages((current) => [...current,
        { role: "user", content: instruction },
        { role: "assistant", content: "This is a book action. Switch Context to Book and load a manuscript or transcript before using it." },
      ]);
      return;
    }
    if (activeMode === "edit" && !manifest) {
      setMessages((current) => [...current,
        { role: "user", content: instruction },
        { role: "assistant", content: "Load or finish a manuscript before requesting an edit." },
      ]);
      return;
    }
    if (requestUsesBook && attachments.length > 0 && !options?.forceGeneral) {
      setMessages((current) => [...current,
        { role: "user", content: instruction },
        { role: "assistant", content: "These attached documents are ready for general chat. Switch Context to General to process them, or remove the attachments to continue with the book." },
      ]);
      return;
    }

    const userMessage = `${instruction}\n\n[Mode: ${MODES[activeMode].label}] [Persona: ${PERSONAS[persona].label}]`;
    const retryBase = options?.retry && messages[messages.length - 1]?.role === "assistant"
      ? messages.slice(0, -1)
      : messages;
    const requestAttachments = options?.requestAttachments ?? attachments;
    const shouldProcessEntireDocument = options?.processEntireDocument ?? processEntireDocument;
    const nextMessages = options?.retry
      ? retryBase
      : [...messages, {
        role: "user" as const,
        content: instruction,
        attachments: requestUsesBook ? undefined : requestAttachments.map(({ id, name }) => ({ id, name })),
      }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      if (requestUsesBook && manifest && isAuditIntent(instruction)) {
        const res = await fetch("/api/ebook/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest }),
        });
        const json = await res.json() as BookAuditReport & { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
        setAuditReport(json);
        setMessages((current) => [...current, { role: "assistant", content: formatAuditReport(json) }]);
        return;
      }

      if (!requestUsesBook) {
        const generalMode = activeMode === "socratic" || activeMode === "plan" ? activeMode : "ask";
        const requestAttachmentsSnapshot = requestAttachments.map((attachment) => ({ ...attachment }));
        setLastGeneralRequest({
          instruction,
          mode: generalMode,
          attachments: requestAttachmentsSnapshot,
          processEntireDocument: shouldProcessEntireDocument,
        });
        setSources([]);
        setAttachmentError(null);
        await streamGeneralResponse(instruction, generalMode, nextMessages, requestAttachmentsSnapshot, shouldProcessEntireDocument);
        return;
      }

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
          dryRun: true,
        }),
      });
      const json = await res.json() as {
        manifest?: unknown;
        patch?: unknown;
        summary?: string;
        confidence?: "high" | "medium" | "low";
        error?: string;
        clarificationNeeded?: string;
        needsClarification?: boolean;
        noChanges?: boolean;
        manifestVersion?: string;
        libraryPatch?: LibraryPatch;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      if (json.needsClarification && json.clarificationNeeded) {
      setMessages((current) => [...current, { role: "assistant", content: sanitizeNexusLMText(json.clarificationNeeded!) }]);
        return;
      }

      if (activeMode === "edit") {
        const editManifest = manifest;
        if (!editManifest) throw new Error("Load a manuscript before requesting an edit.");
        if (!json.patch || !json.summary) throw new Error("NexusLM returned no editable proposal.");
        const parsed = EbookManifestSchema.safeParse(json.manifest);
        if (!parsed.success) throw new Error("NexusLM returned an invalid editable proposal.");
        const changes = buildManifestChangeEntries(editManifest, parsed.data);
        if (changes.length === 0) {
          setMessages((current) => [...current, { role: "assistant", content: "NexusLM generated no reviewable manuscript changes." }]);
          return;
        }
        setPendingEdit({
          instruction,
          summary: json.summary,
          confidence: json.confidence,
          scope: isChapterWideEdit(instruction) ? "chapter" : "focused",
          transcriptLabel: selectedTranscript?.label,
          baseManifest: editManifest,
          proposedManifest: parsed.data,
          changes,
          selectedPaths: changes.map((change) => change.path),
          manifestVersion: json.manifestVersion ?? "",
          libraryPatch: json.libraryPatch,
        });
        setMessages((current) => [...current, {
          role: "assistant",
          content: sanitizeNexusLMText(`Proposal ready for review: ${json.summary}\n\n${changes.length} change${changes.length === 1 ? "" : "s"} are waiting for your approval.`),
        }]);
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

  function togglePendingPath(path: string): void {
    setPendingEdit((current) => {
      if (!current) return current;
      const selectedPaths = current.selectedPaths.includes(path)
        ? current.selectedPaths.filter((selectedPath) => selectedPath !== path)
        : [...current.selectedPaths, path];
      return { ...current, selectedPaths };
    });
  }

  async function applyPendingEdit(paths = pendingEdit?.selectedPaths ?? []): Promise<void> {
    if (!manifest || !pendingEdit || paths.length === 0 || loading) return;
    if (buildManifestChangeEntries(pendingEdit.baseManifest, manifest).length > 0) {
      setPendingEdit(null);
      setMessages((current) => [...current, {
        role: "assistant",
        content: "Edit conflict: the manuscript changed while this proposal was open. Generate a new NexusLM preview.",
      }]);
      return;
    }
    setLoading(true);
    try {
      const summary = `Applied ${paths.length} of ${pendingEdit.changes.length} approved changes: ${pendingEdit.summary}`;
      const res = await fetch("/api/ebook/changes/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: manifest,
          proposedManifest: pendingEdit.proposedManifest,
          selectedPaths: paths,
          manifestVersion: pendingEdit.manifestVersion,
          instruction: pendingEdit.instruction,
          summary,
        }),
      });
      const json = await res.json() as { manifest?: unknown; summary?: string; error?: string; manifestVersion?: string };
      if (res.status === 409) {
        setMessages((current) => [...current, {
          role: "assistant",
          content: "Edit conflict: the manuscript changed while this proposal was open. Generate a new NexusLM preview.",
        }]);
        setPendingEdit(null);
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`);
      const parsed = EbookManifestSchema.safeParse(json.manifest);
      if (!parsed.success) throw new Error("NexusLM returned an invalid manuscript.");

      const snapshot: EbookUndoSnapshot = {
        timestamp: new Date().toISOString(),
        instruction: pendingEdit.instruction,
        summary,
        manifest: pendingEdit.baseManifest,
      };
      saveEbookUndoSnapshot(manifest.jobId, snapshot);
      const nextManifest = json.manifestVersion ? { ...parsed.data, __version: json.manifestVersion } : parsed.data;
      onManifestChange(nextManifest as EbookManifest, json.summary ?? "Manuscript updated.");
      setUndoSnapshot(snapshot);

      if (pendingEdit.libraryPatch) {
        const catalogRes = await fetch("/api/ebook/publish", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingEdit.libraryPatch),
        });
        if (!catalogRes.ok) {
          setMessages((current) => [...current, {
            role: "assistant",
            content: "The manuscript was updated, but published catalog metadata could not be synced.",
          }]);
        }
      }

      setMessages((current) => [...current, { role: "assistant", content: sanitizeNexusLMText(json.summary ?? summary) }]);
      setPendingEdit(null);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: readableError(error) }]);
    } finally {
      setLoading(false);
    }
  }

  function undoLastEdit(): void {
    if (!manifest || !undoSnapshot) return;
    onManifestChange(undoSnapshot.manifest, `Undid: ${undoSnapshot.summary}`);
    clearEbookUndoSnapshot(manifest.jobId);
    setUndoSnapshot(null);
    setMessages((current) => [...current, { role: "assistant", content: `Undid the last approved NexusLM change: ${undoSnapshot.summary}` }]);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-shell-950 lg:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-slate-800 lg:border-b-0 lg:border-r" aria-label="NexusLM conversation">
        <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-slate-800 px-4 lg:hidden">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">NexusLM conversation</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void clearConversation()} className="min-h-12 px-2 text-xs font-semibold text-slate-500">Clear</button>
            <button type="button" onClick={() => setShowMobileContext((current) => !current)} className="min-h-12 px-2 text-xs font-semibold text-cyan-300">
              {showMobileContext ? "Hide context" : useBookContext ? `Sources (${transcripts.length})` : "Context"}
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
                {message.role === "user" ? (
                  <>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        {message.attachments.map((attachment) => (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => {
                              if (!attachments.some((item) => item.id === attachment.id)) return;
                              setSelectedAttachmentId(attachment.id);
                              setShowDocumentPreview(true);
                            }}
                            className="min-h-12 max-w-full rounded-lg border border-cyan-500/30 px-3 text-[11px] font-semibold text-cyan-200"
                          >
                            {attachment.name}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setInput(message.content);
                          inputRef.current?.focus();
                        }}
                        className="min-h-12 rounded-lg border border-cyan-500/30 px-3 text-[11px] font-semibold text-cyan-200"
                      >
                        Edit
                      </button>
                    </div>
                  </>
                ) : message.role === "assistant" ? (
                  <>
                    {renderAssistantContent(message.content, message.format === "markdown")}
                    {message.content.trim() && (
                      <div className="mt-3 flex justify-end">
                        <CopyMessageButton content={message.content} />
                      </div>
                    )}
                  </>
                ) : message.content}
              </div>
            ))}
            {loading && <div className="text-sm text-slate-500">{processEntireDocument ? "NexusLM is reading every document section..." : "NexusLM is thinking..."}</div>}
          </div>
        </div>

        <div className="shrink-0 bg-shell-950 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 lg:px-8 lg:pb-5 lg:pt-3">
          <div className="mx-auto max-w-4xl">
            {undoSnapshot && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-amber-300">Last approved edit</p>
                  <p className="mt-1 text-xs leading-5 text-amber-100">{undoSnapshot.summary}</p>
                </div>
                <button type="button" onClick={undoLastEdit} disabled={loading} className="min-h-12 rounded-xl border border-amber-400/40 px-4 text-sm font-bold text-amber-200 disabled:opacity-40">
                  Undo
                </button>
              </div>
            )}
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
              <div className="mb-3 max-h-[50dvh] overflow-y-auto rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-cyan-300">NexusLM change preview</p>
                    <p className="mt-2 text-sm leading-6 text-cyan-50">{pendingEdit.summary}</p>
                    <p className="mt-2 text-xs text-cyan-200/70">
                      {pendingEdit.changes.length} change{pendingEdit.changes.length === 1 ? "" : "s"} · Confidence: {pendingEdit.confidence ?? "high"}
                    </p>
                  </div>
                  <button type="button" onClick={() => setShowProposalDiff((current) => !current)} className="min-h-12 shrink-0 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300">
                    {showProposalDiff ? "Hide diff" : "View diff"}
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {pendingEdit.changes.map((change) => {
                    const selected = pendingEdit.selectedPaths.includes(change.path);
                    return (
                      <label key={change.path} className={`block rounded-xl border px-3 py-2 ${selected ? "border-cyan-500/40 bg-slate-900/80" : "border-slate-800 bg-slate-950/40 opacity-70"}`}>
                        <span className="flex items-start gap-3">
                          <input type="checkbox" checked={selected} onChange={() => togglePendingPath(change.path)} className="mt-1 h-6 w-6 shrink-0 accent-cyan-400" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold text-slate-200">{change.label}</span>
                            {showProposalDiff && (
                              <span className="mt-2 block space-y-2">
                                <span className="block overflow-x-auto rounded-lg border border-rose-500/20 bg-rose-950/20 p-2 text-[11px] leading-relaxed text-rose-200">
                                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-rose-400">Before</span>
                                  <span className="whitespace-pre-wrap">{change.before}</span>
                                </span>
                                <span className="block overflow-x-auto rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-2 text-[11px] leading-relaxed text-emerald-200">
                                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-emerald-400">After</span>
                                  <span className="whitespace-pre-wrap">{change.after}</span>
                                </span>
                              </span>
                            )}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void applyPendingEdit()} disabled={loading || pendingEdit.selectedPaths.length === 0} className="min-h-12 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 disabled:opacity-40">
                    Apply selected ({pendingEdit.selectedPaths.length})
                  </button>
                  <button type="button" onClick={() => void applyPendingEdit(pendingEdit.changes.map((change) => change.path))} disabled={loading} className="min-h-12 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-bold text-emerald-200 disabled:opacity-40">
                    Apply all
                  </button>
                  <button type="button" onClick={() => setPendingEdit(null)} disabled={loading} className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-300 disabled:opacity-40">
                    Reject
                  </button>
                </div>
              </div>
            )}
            {auditReport && (
              <div className="mb-3 max-h-[45dvh] overflow-y-auto rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">NexusLM audit findings</p>
                    <p className="mt-1 text-xs text-emerald-100/70">Select a finding to send a focused repair request through the preview workflow.</p>
                  </div>
                  <button type="button" onClick={() => setAuditReport(null)} className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300">
                    Dismiss
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {auditReport.conceptDuplicates.slice(0, 6).map((duplicate, index) => (
                    <div key={`duplicate-${index}`} className="rounded-xl border border-rose-500/25 bg-rose-950/20 p-3">
                      <p className="text-xs font-semibold text-rose-200">{duplicate.title}</p>
                      <p className="mt-1 text-[11px] text-slate-400">{duplicate.locations.map((location) => location.location).join(" · ")}</p>
                      <button type="button" onClick={() => void send(`Fix the concept duplicate "${duplicate.title}" in ${duplicate.locations.map((location) => location.location).join(" and ")} while preserving each section's unique teaching.`, "edit")} className="mt-2 min-h-12 rounded-xl bg-rose-400/15 px-3 text-xs font-bold text-rose-200">
                        Fix automatically
                      </button>
                    </div>
                  ))}
                  {auditReport.similarPairs.slice(0, 4).map((pair, index) => (
                    <div key={`similar-${index}`} className="rounded-xl border border-amber-500/25 bg-amber-950/20 p-3">
                      <p className="text-xs font-semibold text-amber-200">Similar sections · {Math.round(pair.similarity * 100)}%</p>
                      <p className="mt-1 text-[11px] text-slate-400">{pair.locationA} · {pair.locationB}</p>
                      <button type="button" onClick={() => void send(`Rewrite ${pair.locationA} and ${pair.locationB} to remove structural similarity while preserving their distinct teaching.`, "edit")} className="mt-2 min-h-12 rounded-xl bg-amber-400/15 px-3 text-xs font-bold text-amber-200">
                        Fix automatically
                      </button>
                    </div>
                  ))}
                  {auditReport.repetitions.slice(0, 5).map((repetition, index) => (
                    <div key={`repetition-${index}`} className="rounded-xl border border-cyan-500/25 bg-cyan-950/20 p-3">
                      <p className="text-xs font-semibold text-cyan-200">Repeated phrase · “{repetition.phrase}” ×{repetition.count}</p>
                      <button type="button" onClick={() => void send(`Reduce unnecessary repetition of the phrase "${repetition.phrase}" throughout the book. Keep intentional uses and vary the rest.`, "edit")} className="mt-2 min-h-12 rounded-xl bg-cyan-400/15 px-3 text-xs font-bold text-cyan-200">
                        Fix automatically
                      </button>
                    </div>
                  ))}
                  {auditReport.overusedWords.slice(0, 5).map((word, index) => (
                    <div key={`word-${index}`} className="rounded-xl border border-violet-500/25 bg-violet-950/20 p-3">
                      <p className="text-xs font-semibold text-violet-200">Overused word · “{word.word}” ×{word.count}</p>
                      <button type="button" onClick={() => void send(`Review the overused word "${word.word}" across the book and replace unnecessary repetitions with context-appropriate alternatives.`, "edit")} className="mt-2 min-h-12 rounded-xl bg-violet-400/15 px-3 text-xs font-bold text-violet-200">
                        Fix automatically
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {lastGeneralRequest && !loading && (
              <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2">
                <p className="truncate text-xs text-slate-500">Retry the last general response</p>
                <button type="button" onClick={retryLastResponse} className="min-h-12 shrink-0 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300">
                  Retry
                </button>
              </div>
            )}
            <div
              className="rounded-2xl border border-slate-700 bg-slate-900 shadow-[0_8px_30px_rgba(0,0,0,0.22)] focus-within:border-cyan-400/60"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void addFiles(event.dataTransfer.files);
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.csv,.json,.css,.js,.jsx,.ts,.tsx,.xml,.yaml,.yml,.srt,.log,.html,.htm,.pdf,text/*,application/pdf"
                multiple
                className="hidden"
                onChange={(event) => {
                  void addFiles(event.target.files ?? []);
                  event.currentTarget.value = "";
                }}
              />
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className="flex max-w-full items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-1 text-xs text-cyan-100">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAttachmentId(attachment.id);
                          setShowDocumentPreview(true);
                        }}
                        className="min-h-12 max-w-[12rem] truncate rounded-md px-2 text-left text-cyan-100"
                        title={`Preview ${attachment.name}`}
                      >
                        {attachment.name}
                      </button>
                      <button type="button" onClick={() => {
                        setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        setSelectedAttachmentId((current) => current === attachment.id ? (attachments.find((item) => item.id !== attachment.id)?.id ?? null) : current);
                      }} className="min-h-12 min-w-12 rounded-md text-cyan-300" aria-label={`Remove ${attachment.name}`}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachments.length > 0 && (
                <div className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-300">Read every section</p>
                    <p className="mt-1 text-[11px] leading-5 text-slate-500">Use full-document processing for summaries, themes, and transcript-wide analysis.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={processEntireDocument}
                    onClick={() => setProcessEntireDocument((current) => !current)}
                    className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-bold ${processEntireDocument ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200" : "border-slate-700 text-slate-400"}`}
                  >
                    {processEntireDocument ? "On" : "Off"}
                  </button>
                </div>
              )}
              {attachmentError && (
                <p className="px-3 pt-2 text-xs text-amber-300" role="alert">{attachmentError}</p>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={(event) => {
                  if (event.clipboardData.files.length > 0) {
                    event.preventDefault();
                    void addFiles(event.clipboardData.files);
                  }
                }}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                placeholder={useBookContext ? "Ask NexusLM about your book, or switch to General..." : "Ask NexusLM anything..."}
                disabled={loading}
                rows={2}
                className="block w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 py-3 text-base leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:ring-0"
              />
              <div className="flex items-center justify-between gap-3 px-3 pb-2">
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loading} className="min-h-12 min-w-12 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300 disabled:opacity-40" aria-label="Attach a document">
                    +
                  </button>
                  <p className="truncate text-[11px] text-slate-500">Enter to send · Shift+Enter for a new line · add text, HTML, or PDF</p>
                </div>
                <button
                  type="button"
                  onClick={() => (loading ? stopGenerating() : void send())}
                  disabled={loading ? !canAbort : !input.trim()}
                  className={`min-h-12 rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 ${loading && canAbort ? "border border-rose-400/40 bg-rose-500/10 text-rose-200" : "bg-cyan-400 text-slate-950"}`}
                >
                  {loading ? (canAbort ? "Stop" : "Working...") : "Send"}
                </button>
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
              <h2 className="mt-2 text-lg font-semibold text-slate-100">Your AI workspace</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">Ask anything, work with files, or switch into book editing when you need it.</p>
            </div>
            <button type="button" onClick={() => void clearConversation()} className="min-h-12 shrink-0 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-400">Clear history</button>
          </div>
        </div>

        <div className="mb-6 border-b border-slate-800 pb-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Saved chats</p>
            <button type="button" onClick={() => void startNewConversation()} disabled={loading} className="min-h-12 rounded-xl bg-cyan-400 px-3 text-xs font-bold text-slate-950 disabled:opacity-40">
              New chat
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowChatHistory((current) => !current)}
            className="mt-2 flex min-h-12 w-full items-center justify-between rounded-xl border border-slate-700 px-3 text-left text-xs font-semibold text-slate-300"
          >
            <span>{chatHistory.length === 0 ? "No saved chats yet" : `${chatHistory.length} saved chat${chatHistory.length === 1 ? "" : "s"}`}</span>
            <span className="text-cyan-300">{showChatHistory ? "Hide" : "Show"}</span>
          </button>
          {showChatHistory && chatHistory.length > 0 && (
            <div className="mt-2 max-h-[35dvh] space-y-2 overflow-y-auto">
              {chatHistory.map((chat) => (
                <div key={chat.id} className={`rounded-xl border p-2 ${chat.id === activeConversationKey ? "border-cyan-400/50 bg-cyan-400/10" : "border-slate-800 bg-slate-900/60"}`}>
                  <button type="button" onClick={() => openSavedConversation(chat.id)} className="min-h-12 w-full truncate px-1 text-left text-sm font-semibold text-slate-200">
                    {chat.title}
                  </button>
                  <div className="flex items-center justify-between gap-2 px-1">
                    <p className="truncate text-[10px] text-slate-500">
                      {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"} · {new Date(chat.updatedAt).toLocaleDateString()}
                    </p>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => void renameSavedConversation(chat)} className="min-h-12 min-w-12 rounded-lg text-[10px] font-semibold text-slate-400" aria-label={`Rename ${chat.title}`}>Rename</button>
                      <button type="button" onClick={() => void removeSavedConversation(chat.id)} className="min-h-12 min-w-12 rounded-lg text-[10px] font-semibold text-rose-300" aria-label={`Delete ${chat.title}`}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {attachments.length > 0 && (
          <div className="mb-6 border-b border-slate-800 pb-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Documents</p>
              {selectedAttachment && (
                <button type="button" onClick={() => setShowDocumentPreview((current) => !current)} className="min-h-12 rounded-lg border border-slate-700 px-3 text-[11px] font-semibold text-cyan-300">
                  {showDocumentPreview ? "Hide preview" : "View preview"}
                </button>
              )}
            </div>
            <div className="mt-2 space-y-1">
              {attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() => {
                    setSelectedAttachmentId(attachment.id);
                    setShowDocumentPreview(true);
                  }}
                  className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border px-3 text-left text-xs ${selectedAttachmentId === attachment.id ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-slate-800 text-slate-400"}`}
                >
                  <span className="truncate">{attachment.name}</span>
                  <span className="shrink-0 uppercase text-[10px] text-slate-500">{attachmentKind(attachment)}</span>
                </button>
              ))}
            </div>
            {showDocumentPreview && selectedAttachment && (
              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-semibold text-slate-300">{selectedAttachment.name}</p>
                  <button type="button" onClick={() => setShowDocumentPreview(false)} className="min-h-12 min-w-12 rounded-lg text-slate-400" aria-label="Close document preview">×</button>
                </div>
                <DocumentPreview attachment={selectedAttachment} />
              </div>
            )}
          </div>
        )}

        <p className="block text-xs font-semibold uppercase tracking-widest text-slate-500">Context</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {([
            ["auto", "Auto"],
            ["general", "General"],
            ["book", "Book"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setContextMode(value)}
              className={`min-h-12 rounded-xl border px-2 text-xs font-semibold ${contextMode === value ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300" : "border-slate-700 text-slate-400"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {contextMode === "general"
            ? "Book and transcript context is ignored for this conversation."
            : contextMode === "book"
              ? "Ground answers in the connected manuscript and transcript sources."
              : hasBookContext
                ? "Book context is active because a manuscript or transcript is connected."
                : "No book is connected, so NexusLM is in general conversation mode."}
        </p>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-persona">Persona</label>
        <select id="nexuslm-persona" value={persona} onChange={(event) => setPersona(event.target.value as Persona)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(PERSONAS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>

        <label className="mt-6 block text-xs font-semibold uppercase tracking-widest text-slate-500" htmlFor="nexuslm-agent">Agent</label>
        <select id="nexuslm-agent" value={agent} onChange={(event) => setAgent(event.target.value as NexusLMAgent)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200">
          {Object.entries(NEXUSLM_AGENTS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
        </select>
        <p className="mt-2 text-xs leading-5 text-slate-500">{NEXUSLM_AGENTS[agent].description}</p>
        <p className="mt-1 text-[11px] font-semibold text-cyan-300/80">NexusLM models: DeepSeek Chat and DeepSeek Reasoner only.</p>

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

        {manifest?.changeLog && manifest.changeLog.length > 0 && (
          <div className="mt-6 border-t border-slate-800 pt-5">
            <button type="button" onClick={() => setShowHistory((current) => !current)} className="flex min-h-12 w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-widest text-slate-500">
              <span>NexusLM change history</span>
              <span className="text-cyan-300">{showHistory ? "Hide" : `${manifest.changeLog.length} edits`}</span>
            </button>
            {showHistory && (
              <div className="mt-3 space-y-2">
                {[...manifest.changeLog].reverse().map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`} className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <p className="text-xs leading-5 text-slate-200">{entry.summary}</p>
                    <p className="mt-1 text-[10px] text-slate-500">{new Date(entry.timestamp).toLocaleString()} · {entry.model.toUpperCase()}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
