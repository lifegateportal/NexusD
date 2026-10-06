"use client";

import { useState, useRef, useEffect } from "react";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookPipelineSnapshot } from "@/app/components/EbookPipeline";
import type { AcademyPackage } from "@/lib/schemas/academy";
import type { SiteConfig } from "@/lib/schemas/site-config";
import type { EbookManifest } from "@/lib/schemas/ebook";
import type { ChatMessage } from "@/lib/project-store";
import {
  buildManifestChangeEntries,
  clearEbookUndoSnapshot,
  loadEbookUndoSnapshot,
  saveEbookUndoSnapshot,
} from "@/lib/ebook-change-control";
import type { EbookChangeEntry, EbookUndoSnapshot } from "@/lib/ebook-change-control";

type Message = ChatMessage;
type VersionedManifest = EbookManifest & { __version?: string };
type LibraryPatch = {
  slug: string;
  title?: string;
  subtitle?: string;
  authorName?: string;
  synopsis?: string;
  coverAccent?: string;
};

type PendingProposal = {
  instruction: string;
  summary: string;
  confidence?: "high" | "medium" | "low";
  baseManifest: EbookManifest;
  proposedManifest: EbookManifest;
  changes: EbookChangeEntry[];
  selectedPaths: string[];
  manifestVersion: string;
  libraryPatch?: LibraryPatch;
};

type AssistantPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  academy: AcademyPackage | null;
  onUpdate: (academy: AcademyPackage, summary: string) => void;
  siteConfig: SiteConfig;
  onSiteUpdate: (config: SiteConfig, summary: string) => void;
  /** Ebook manifest — when present, enables book production control */
  ebookManifest?: EbookManifest | null;
  onEbookUpdate?: (manifest: EbookManifest, summary: string) => void;
  ebookPipelineSnapshot?: EbookPipelineSnapshot | null;
  /** When a project is loaded, pass its saved messages + a new loadKey to restore chat */
  loadedHistory?: Message[];
  loadKey?: string;
  onChatChange?: (msgs: Message[]) => void;
};

const IDLE_HINT = "No content loaded yet. Run the pipeline first, then I can help you make changes.";

// ── Audit report types (mirrored from /api/ebook/audit) ──────────────────────
type AuditConceptDuplicate = {
  type: string; title: string; description: string; severity: "minor" | "major";
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

// ── Intent detectors ─────────────────────────────────────────────────────────
function isAuditIntent(text: string): boolean {
  return /\b(audit|full[\s-]?audit|review\s+the\s+book|analyse|analyze|repetit|duplicat|overused\s+words?|similar\s+sections?|quality\s+check|book\s+report|what.{0,12}issues|flag\s+issues|check\s+(?:the\s+)?book|run\s+(?:a\s+)?(?:full\s+)?audit|what.{0,12}(wrong|problem|broken|needs.{0,8}fix)|find\s+(issues|problems|errors|duplicates?)|scripture.{0,12}repeat|same\s+(verse|scripture|passage).{0,16}twice|sounds?\s+redundant|too\s+repetitive|check\s+for\s+(duplicates?|repetition|issues|problems))\b/i.test(text);
}

function isViewIntent(text: string): boolean {
  return /\b(show\s+(?:me\s+)?(?:the\s+)?(?:book|chapters?|contents?|toc|table\s+of\s+contents?|overview|summary|outline|structure|sections?|layout)|view\s+(?:book|chapters?|contents?|structure|outline)|list\s+(?:chapters?|sections?|contents?)|how\s+many\s+(chapters?|sections?)|what.{0,10}(chapters?|sections?|in\s+the\s+book)|book\s+(outline|structure|layout|contents?)|what.{0,10}book\s+look|table\s+of\s+contents?)\b/i.test(text);
}

// ── Client-side book table of contents ───────────────────────────────────────
function buildBookToc(manifest: EbookManifest): string {
  const lines: string[] = [
    `\u{1F4DA}  "${manifest.bookTitle}"`,
    `    by ${manifest.authorName}`,
    `    ${manifest.chapters.length} chapters \u00b7 ${manifest.totalWordCount.toLocaleString()} words`,
    "",
  ];
  const fm = manifest.frontMatter;
  const fmParts: Array<[string, string | null | undefined]> = [
    ["Preface", fm.preface],
    ["Introduction", fm.introduction],
  ];
  if (fmParts.some(([, t]) => (t ?? "").trim())) {
    lines.push("FRONT MATTER");
    for (const [label, text] of fmParts) {
      if ((text ?? "").trim()) lines.push(`  ${label} (${text!.trim().split(/\s+/).length.toLocaleString()} words)`);
    }
    lines.push("");
  }
  lines.push("CHAPTERS");
  for (const ch of manifest.chapters) {
    lines.push(`  Chapter ${ch.number}: ${ch.title}  (${(ch.totalWordCount ?? 0).toLocaleString()} words)`);
    for (const s of ch.sections) {
      lines.push(`    ${ch.number}.${s.sectionNumber}  ${s.heading}  [${(s.wordCount ?? 0).toLocaleString()} w]`);
    }
  }
  const backParts: Array<[string, string | null | undefined]> = [
    ["Conclusion", fm.conclusion],
    ["About the Author", fm.aboutAuthor],
    ["Resources", fm.resourcesList],
  ];
  if (backParts.some(([, t]) => (t ?? "").trim())) {
    lines.push("");
    lines.push("BACK MATTER");
    for (const [label, text] of backParts) {
      if ((text ?? "").trim()) lines.push(`  ${label} (${text!.trim().split(/\s+/).length.toLocaleString()} words)`);
    }
  }
  if (manifest.backMatter) {
    const bm = manifest.backMatter;
    lines.push("");
    lines.push("GENERATED BACK MATTER");
    if ((bm.glossary?.length ?? 0) > 0) lines.push(`  Glossary — ${bm.glossary.length} terms`);
    if ((bm.readingGroupGuide?.length ?? 0) > 0) lines.push(`  Reading Group Guide — ${bm.readingGroupGuide.length} chapters`);
    if ((bm.scriptureIndex?.length ?? 0) > 0) lines.push(`  Scripture Index — ${bm.scriptureIndex.length} references`);
    if ((bm.recommendedResources?.length ?? 0) > 0) lines.push(`  Recommended Resources — ${bm.recommendedResources.length} items`);
  }
  return lines.join("\n");
}

// ── Audit report formatter ────────────────────────────────────────────────────
function formatAuditReport(r: BookAuditReport): string {
  const total = r.totalConceptDuplicates + r.totalSimilarPairs + r.totalRepetitionPhrases;
  const lines: string[] = [
    `\u{1F4CA}  BOOK AUDIT COMPLETE`,
    `    ${total === 0 ? "No significant issues found." : [
      r.totalConceptDuplicates > 0 && `${r.totalConceptDuplicates} concept duplicate${r.totalConceptDuplicates !== 1 ? "s" : ""}`,
      r.totalSimilarPairs > 0 && `${r.totalSimilarPairs} similar pair${r.totalSimilarPairs !== 1 ? "s" : ""}`,
      r.totalRepetitionPhrases > 0 && `${r.totalRepetitionPhrases} repeated phrase${r.totalRepetitionPhrases !== 1 ? "s" : ""}`,
    ].filter(Boolean).join(", ") + " flagged."}`,
    "",
  ];
  if (r.conceptDuplicates?.length > 0) {
    lines.push(`\u{1F504}  CONCEPT DUPLICATES (${r.conceptDuplicates.length})`);
    lines.push("─".repeat(46));
    for (const d of r.conceptDuplicates) {
      lines.push(`\u25B8 [${d.severity.toUpperCase()}] ${d.title}`);
      for (const loc of d.locations) lines.push(`  \u2192 ${loc.location}`);
      lines.push(`  Issue: ${d.description}`);
      lines.push(`  Fix:   ${d.recommendation}`);
      lines.push("");
    }
  }
  if (r.similarPairs?.length > 0) {
    lines.push(`\u{1F4CC}  STRUCTURALLY SIMILAR SECTIONS (${r.similarPairs.length})`);
    lines.push("─".repeat(46));
    for (const p of r.similarPairs.slice(0, 8)) {
      lines.push(`  ${p.locationA}  \u2194  ${p.locationB}  (${Math.round(p.similarity * 100)}% similar)`);
    }
    lines.push("");
  }
  if (r.repetitions?.length > 0) {
    lines.push(`\u{1F501}  REPEATED PHRASES (top ${Math.min(r.repetitions.length, 10)})`);
    lines.push("─".repeat(46));
    for (const rep of r.repetitions.slice(0, 10)) {
      lines.push(`  "${rep.phrase}"  \u00d7${rep.count}`);
      if (rep.reason) lines.push(`    \u2192 ${rep.reason}`);
      if (rep.alternatives?.length) lines.push(`    Alt: ${rep.alternatives.join(", ")}`);
    }
    lines.push("");
  }
  if (r.overusedWords?.length > 0) {
    lines.push(`\u{1F4DD}  OVERUSED WORDS (${r.overusedWords.length})`);
    lines.push("─".repeat(46));
    for (const w of r.overusedWords.slice(0, 8)) {
      const alts = w.alternatives?.length ? `  \u2192  ${w.alternatives.join(", ")}` : "";
      lines.push(`  "${w.word}"  ${w.count}\u00d7 (${w.frequency})${alts}`);
    }
    lines.push("");
  }
  if (total === 0) {
    lines.push("\u2705  The book passed the audit with no significant flags.");
  } else {
    lines.push(`\u{1F4A1}  Fix issues by asking me: "Rewrite section 2.1" or "Fix repetition in chapter 3".`);
  }
  return lines.join("\n");
}

export function AssistantPanel({ isOpen, onClose, academy, onUpdate, siteConfig, onSiteUpdate, ebookManifest, onEbookUpdate, ebookPipelineSnapshot, loadedHistory, loadKey, onChatChange }: AssistantPanelProps) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "system", content: IDLE_HINT },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showChips, setShowChips] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);
  const [auditReport, setAuditReport] = useState<BookAuditReport | null>(null);
  const [showProposalDiff, setShowProposalDiff] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<EbookUndoSnapshot | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPendingProposal(null);
    setShowProposalDiff(false);
    setShowHistory(false);
    setUndoSnapshot(ebookManifest?.jobId ? loadEbookUndoSnapshot(ebookManifest.jobId) : null);
  }, [ebookManifest?.jobId]);

  // Restore chat history when a project is loaded
  useEffect(() => {
    if (loadKey && loadedHistory && loadedHistory.length > 0) {
      setMessages(loadedHistory);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  // Update greeting when academy or ebook first loads (only if no project history was restored)
  useEffect(() => {
    if (loadKey) return; // project load handles its own history
    if (ebookManifest) {
      const pipelineStatus = ebookPipelineSnapshot
        ? `Pipeline: ${ebookPipelineSnapshot.stage} | Review ready: ${ebookPipelineSnapshot.reviewReady ? "yes" : "no"} | Quality: ${ebookPipelineSnapshot.qualityReport ? `${ebookPipelineSnapshot.qualityReport.score}/100` : "pending"}`
        : "Pipeline: connected";
      setMessages([{
        role: "system",
        content: `Book loaded: "${ebookManifest.bookTitle}" by ${ebookManifest.authorName} — ${ebookManifest.chapters.length} chapters, ${ebookManifest.totalWordCount.toLocaleString()} words.\n${pipelineStatus}\n\nYou can ask me to change the title, rename chapters, edit section headings, update takeaways, revise the preface, rewrite chapter sections, and make targeted book-wide edits.`,
      }]);
    } else if (academy) {
      const lessonCount = academy.curriculum.flatMap((m) => m.lessons).length;
      setMessages([{
        role: "system",
        content: `"${academy.academyName}" loaded — ${academy.curriculum.length} modules, ${lessonCount} lessons. Tell me what to change.`,
      }]);
    } else {
      setMessages([{ role: "system", content: IDLE_HINT }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!academy, !!ebookManifest]);

  // Notify parent whenever messages change so it can persist them
  useEffect(() => {
    onChatChange?.(messages);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  async function send(instructionOverride?: string) {
    const text = (instructionOverride ?? input).trim();
    if (!text || loading) return;

    const hasContent = academy || ebookManifest;
    if (!hasContent) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "Run the pipeline first so I have content to edit." },
      ]);
      setInput("");
      return;
    }

    // ── View book contents (client-side, no loading state) ──────────────────
    if (ebookManifest && isViewIntent(text)) {
      setMessages((prev) => [...prev,
        { role: "user", content: text },
        { role: "assistant", content: buildBookToc(ebookManifest) },
      ]);
      setInput("");
      return;
    }

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    if (!isAuditIntent(text)) setAuditReport(null);
    setLoading(true);

    try {
      // ── Book audit ─────────────────────────────────────────────────────────
      if (ebookManifest && isAuditIntent(text)) {
        const res = await fetch("/api/ebook/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest: ebookManifest }),
        });
        const json = await res.json() as BookAuditReport & { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        setAuditReport(json);
        setMessages((prev) => [...prev, { role: "assistant", content: formatAuditReport(json) }]);
        return;
      }

      // ── Route to ebook assistant when a book manifest is loaded ────────────
      if (ebookManifest && onEbookUpdate) {
        // Send the last 14 turns (7 exchanges) of user/assistant chat so the AI
        // understands follow-up instructions like "make it longer" or "fix that".
        const historyForApi = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-14)
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        const res = await fetch("/api/ebook/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest: ebookManifest,
            instruction: text,
            history: historyForApi,
            pipeline: ebookPipelineSnapshot ?? undefined,
            manifestVersion: (ebookManifest as Record<string, unknown>).__version as string | undefined,
            dryRun: true,
          }),
        });
        const json = await res.json() as {
          manifest?: unknown;
          patch?: unknown;
          summary?: string;
          noChanges?: boolean;
          error?: string;
          code?: string;
          needsClarification?: boolean;
          clarificationNeeded?: string;
          confidence?: "high" | "medium" | "low";
          manifestVersion?: string;
          libraryPatch?: LibraryPatch;
        };
        if (res.status === 409) {
          setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ **Edit conflict** — the book was changed in another tab. Please reload the page and try again.` }]);
          return;
        }
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (json.needsClarification && json.clarificationNeeded) {
          setMessages((prev) => [...prev, { role: "assistant", content: `❓ I need a bit more detail before I can make this change:\n\n**${json.clarificationNeeded}**` }]);
          return;
        }
        if (json.noChanges) {
          setMessages((prev) => [...prev, { role: "assistant", content: `${json.summary ?? ""}

⚠️ No manuscript changes were applied. Please rephrase your instruction more specifically — e.g. name the exact chapter or section number you want changed.` }]);
          return;
        }
        const parsed = EbookManifestSchema.safeParse(json.manifest);
        if (!parsed.success) throw new Error("Invalid ebook manifest returned from assistant");
        const changes = buildManifestChangeEntries(ebookManifest, parsed.data);
        if (changes.length === 0) {
          setMessages((prev) => [...prev, { role: "assistant", content: "The assistant generated no reviewable manuscript changes." }]);
          return;
        }
        setPendingProposal({
          instruction: text,
          summary: json.summary ?? "Book changes are ready for review.",
          confidence: json.confidence,
          baseManifest: ebookManifest,
          proposedManifest: parsed.data,
          changes,
          selectedPaths: changes.map((change) => change.path),
          manifestVersion: json.manifestVersion ?? "",
          libraryPatch: json.libraryPatch,
        });
        const confidenceNote = json.confidence === "medium" ? " Review carefully; confidence is medium." : "";
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: `Proposal ready: ${json.summary ?? "Book changes are ready for review."}\n\n${changes.length} change${changes.length === 1 ? "" : "s"} are waiting for your approval.${confidenceNote}`,
        }]);
        return;
      }

      // ── Academy assistant (existing path) ──────────────────────────────────
      if (!academy) {
        setMessages((prev) => [...prev, { role: "assistant", content: "No academy loaded." }]);
        return;
      }

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          academy,
          instruction: text,
          siteConfig,
          history: messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
          academyVersion: (academy as Record<string, unknown>).__version as string | undefined,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Read SSE stream — buffer all chunks then find the data: line.
      // Parsing chunk-by-chunk causes "Unterminated string" when JSON spans chunks.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      let json: { academy?: unknown; siteConfig?: unknown; summary?: string; error?: string; code?: string; needsClarification?: boolean; clarificationNeeded?: string; confidence?: "high" | "medium" | "low"; academyVersion?: string } | null = null;
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          json = JSON.parse(line.slice(6)) as typeof json;
          break;
        }
      }

      if (!json) throw new Error("No response from assistant");
      if (json.error && json.code === "VERSION_CONFLICT") {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ **Edit conflict** — the academy was changed in another tab. Please reload and try again.` }]);
        return;
      }
      if (json.error) throw new Error(json.error);
      if (json.needsClarification && json.clarificationNeeded) {
        setMessages((prev) => [...prev, { role: "assistant", content: `❓ I need a bit more detail:\n\n**${json.clarificationNeeded}**` }]);
        return;
      }

      let changed = false;

      if (json.academy !== undefined) {
        const parsed = AcademyPackageSchema.safeParse(json.academy);
        if (!parsed.success) throw new Error("Invalid academy returned from assistant");
        onUpdate(parsed.data, json.summary ?? "Changes applied.");
        changed = true;
      }

      if (json.siteConfig !== undefined) {
        const parsed = SiteConfigSchema.safeParse(json.siteConfig);
        if (!parsed.success) throw new Error("Invalid site config returned from assistant");
        onSiteUpdate(parsed.data, json.summary ?? "Site updated.");
        changed = true;
      }

      if (!changed) throw new Error("Assistant returned no changes");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: json!.summary ?? "Done." },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  function toggleProposalPath(path: string): void {
    setPendingProposal((current) => {
      if (!current) return current;
      const selectedPaths = current.selectedPaths.includes(path)
        ? current.selectedPaths.filter((selectedPath) => selectedPath !== path)
        : [...current.selectedPaths, path];
      return { ...current, selectedPaths };
    });
  }

  async function applyProposal(paths: string[]): Promise<void> {
    if (!pendingProposal || !ebookManifest || !onEbookUpdate || paths.length === 0 || loading) return;
    if (buildManifestChangeEntries(pendingProposal.baseManifest, ebookManifest).length > 0) {
      setPendingProposal(null);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: "⚠️ **Edit conflict** — the manuscript changed while this proposal was open. Generate a fresh preview before applying it.",
      }]);
      return;
    }
    setLoading(true);

    try {
      const appliedSummary = `Applied ${paths.length} of ${pendingProposal.changes.length} approved changes: ${pendingProposal.summary}`;
      const res = await fetch("/api/ebook/changes/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest: ebookManifest,
          proposedManifest: pendingProposal.proposedManifest,
          selectedPaths: paths,
          manifestVersion: pendingProposal.manifestVersion,
          instruction: pendingProposal.instruction,
          summary: appliedSummary,
        }),
      });
      const json = await res.json() as {
        manifest?: unknown;
        summary?: string;
        manifestVersion?: string;
        error?: string;
      };
      if (res.status === 409) {
        setMessages((prev) => [...prev, {
          role: "assistant",
          content: "⚠️ **Edit conflict** — the book changed while this proposal was open. Generate a fresh preview before applying it.",
        }]);
        setPendingProposal(null);
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);

      const parsed = EbookManifestSchema.safeParse(json.manifest);
      if (!parsed.success) throw new Error("Invalid manuscript returned from change approval");

      const snapshotSaved = saveEbookUndoSnapshot(ebookManifest.jobId, {
        timestamp: new Date().toISOString(),
        instruction: pendingProposal.instruction,
        summary: appliedSummary,
        manifest: pendingProposal.baseManifest,
      });
      const manifestWithVersion: VersionedManifest = json.manifestVersion
        ? { ...parsed.data, __version: json.manifestVersion }
        : parsed.data;
      onEbookUpdate(manifestWithVersion, json.summary ?? appliedSummary);
      setUndoSnapshot(snapshotSaved ? {
        timestamp: new Date().toISOString(),
        instruction: pendingProposal.instruction,
        summary: appliedSummary,
        manifest: pendingProposal.baseManifest,
      } : null);

      let catalogWarning = "";
      if (pendingProposal.libraryPatch) {
        const catalogRes = await fetch("/api/ebook/publish", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingProposal.libraryPatch),
        });
        if (!catalogRes.ok) {
          catalogWarning = " The manuscript was updated, but published catalog metadata could not be synced.";
        }
      }

      setPendingProposal(null);
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `${json.summary ?? appliedSummary}${catalogWarning}`,
      }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to apply the approved changes";
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  function rejectProposal(): void {
    if (!pendingProposal) return;
    setPendingProposal(null);
    setShowProposalDiff(false);
    setMessages((prev) => [...prev, { role: "assistant", content: "Proposal rejected. No manuscript changes were applied." }]);
  }

  function undoLastChange(): void {
    if (!ebookManifest || !undoSnapshot || !onEbookUpdate) return;
    onEbookUpdate(undoSnapshot.manifest, `Undid: ${undoSnapshot.summary}`);
    clearEbookUndoSnapshot(ebookManifest.jobId);
    setUndoSnapshot(null);
    setMessages((prev) => [...prev, { role: "assistant", content: `↩️ Undid the last approved change: ${undoSnapshot.summary}` }]);
  }

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/60 backdrop-blur-sm"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer — full-width on mobile, max-w-sm on tablet/desktop */}
      <div
        className={`fixed inset-y-0 right-0 z-[60] flex w-full max-w-full flex-col border-l border-slate-700/60 bg-slate-900 shadow-2xl transition-transform duration-300 sm:max-w-sm ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-label="Director AI assistant"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-800 px-4 py-4">
          <div>
            <p className="text-sm font-bold text-slate-100">Nexus Director AI</p>
            <p className="text-[11px] text-slate-500">
              {ebookManifest
                ? "Edit your book with natural language"
                : "Edit your academy with natural language"}
            </p>
            {ebookManifest && ebookPipelineSnapshot && (
              <p className="mt-1 text-[10px] text-cyan-300/90">
                {ebookPipelineSnapshot.reviewReady ? "Review ready" : "Pipeline active"} • Stage: {ebookPipelineSnapshot.stage} • Quality {ebookPipelineSnapshot.qualityReport ? `${ebookPipelineSnapshot.qualityReport.score}/100` : "pending"}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {ebookManifest?.changeLog && ebookManifest.changeLog.length > 0 && (
              <button
                type="button"
                onClick={() => setShowHistory((current) => !current)}
                className={`flex min-h-12 items-center rounded-xl border px-3 text-[11px] font-semibold ${showHistory ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300" : "border-slate-700 text-slate-400"}`}
              >
                History
              </button>
            )}
            {undoSnapshot && (
              <button
                type="button"
                onClick={undoLastChange}
                className="flex min-h-12 items-center rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 text-[11px] font-semibold text-amber-300"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assistant"
              className="flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-slate-700 text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            >
              ✕
            </button>
          </div>
        </div>

        {showHistory && ebookManifest?.changeLog && (
          <div className="max-h-48 flex-shrink-0 overflow-y-auto border-b border-slate-800 bg-slate-950/40 px-4 py-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Change history</p>
            <div className="space-y-2">
              {[...ebookManifest.changeLog].reverse().map((entry, index) => (
                <div key={`${entry.timestamp}-${index}`} className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <p className="text-xs text-slate-200">{entry.summary}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    {new Date(entry.timestamp).toLocaleString()} · {entry.model.toUpperCase()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick-action chips — collapsed by default to give chat messages room */}
        {(ebookManifest || (academy && !ebookManifest)) && (
          <div className="flex-shrink-0 border-b border-slate-800">
            <button
              type="button"
              onClick={() => setShowChips((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-500 hover:text-slate-300 transition-colors"
            >
              <span>Quick actions</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`h-3.5 w-3.5 transition-transform ${showChips ? "rotate-180" : ""}`}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showChips && (
              <div className="overflow-y-auto px-3 pb-3 max-h-56">
                {ebookManifest && (
                  <>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Audit &amp; Review</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {([
                        ["Full audit", "Audit the book"],
                        ["View contents", "Show me the table of contents"],
                        ["Repetition check", "Check for concept duplicates and repeated content"],
                        ["Overused words", "Show overused words in the book"],
                        ["Similar sections", "Show structurally similar sections"],
                      ] as [string, string][]).map(([label, prompt]) => (
                        <button key={label} type="button" onClick={() => { setInput(prompt); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-1.5 text-[11px] text-emerald-400 transition hover:border-emerald-500/60 hover:text-emerald-300">{label}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Metadata</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Change the book title","Update the subtitle","Revise the preface","Rewrite the introduction","Update the conclusion"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-cyan-500/40 hover:text-cyan-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Chapters &amp; Sections</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Rename chapter 1","Rewrite the intro of chapter 1","Replace the reflection questions in chapter 1","Add takeaways to all chapters","Rewrite section 1.1","Fix live-audience language in section 1.1"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-violet-500/40 hover:text-violet-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Book-Wide Fixes</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Fix all live-audience language","Remove all greeting phrases","Standardise all section headings"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-amber-500/40 hover:text-amber-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Format &amp; Layout</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Format the entire book","Bold all key terms throughout","Make scripture passages block quotes","Use the devotional template","Use the premium literary template","Use the classic academic layout","Use the modern business style","Use the popular nonfiction layout"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-teal-500/40 hover:text-teal-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Structure</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Move section 1.2 to chapter 2","Reorder sections in chapter 1","Merge sections 2.1 and 2.2","Move chapter 1 to position 3","Split chapter 1 into two chapters"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-purple-500/40 hover:text-purple-300">{chip}</button>
                      ))}
                    </div>
                  </>
                )}
                {academy && !ebookManifest && (
                  <>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Content</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Add key takeaways to all lessons","Add action items to every lesson","Rewrite notes with proper headings","Add quiz questions to all lessons","Add learning objectives to all modules","Expand the glossary for all modules","Make the notes more detailed and analytical"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-cyan-500/40 hover:text-cyan-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Visual &amp; Theme</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Change theme to amber","Change theme to emerald","Change theme to violet","Change theme to rose","Change theme to solar (light mode)","Use a split hero layout","Use a minimal layout","Use a centered layout"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-violet-500/40 hover:text-violet-300">{chip}</button>
                      ))}
                    </div>
                    <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">Landing Page</p>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {["Add testimonials from students","Add a FAQ section","Add an instructor bio","Add an announcement banner","Change the CTA button text","Add social media links"].map((chip) => (
                        <button key={chip} type="button" onClick={() => { setInput(chip); inputRef.current?.focus(); }} className="flex-shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-sky-500/40 hover:text-sky-300">{chip}</button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {auditReport && (
          <section className="max-h-[48dvh] flex-shrink-0 overflow-y-auto border-b border-emerald-500/25 bg-emerald-950/10 px-3 py-3" aria-label="Interactive audit findings">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">Audit findings</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {auditReport.totalConceptDuplicates + auditReport.totalSimilarPairs + auditReport.totalRepetitionPhrases + auditReport.totalOverusedWords} flagged item{auditReport.totalConceptDuplicates + auditReport.totalSimilarPairs + auditReport.totalRepetitionPhrases + auditReport.totalOverusedWords === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAuditReport(null)}
                className="min-h-12 rounded-xl border border-slate-700 px-3 text-[11px] font-semibold text-slate-400"
              >
                Dismiss
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {auditReport.conceptDuplicates.slice(0, 6).map((duplicate, index) => (
                <div key={`duplicate-${index}`} className="rounded-xl border border-rose-500/25 bg-rose-950/20 p-3">
                  <p className="text-xs font-semibold text-rose-200">{duplicate.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    {duplicate.locations.map((location) => location.location).join(" · ")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void send(`Fix the concept duplicate "${duplicate.title}" in ${duplicate.locations.map((location) => location.location).join(" and ")}. Preserve each section's unique teaching.`)}
                      className="min-h-12 rounded-xl bg-rose-400/15 px-3 text-[11px] font-bold text-rose-200"
                    >
                      Fix automatically
                    </button>
                    <button
                      type="button"
                      onClick={() => void send(`Show me the duplicated sections for "${duplicate.title}" and explain what should remain unique.`)}
                      className="min-h-12 rounded-xl border border-slate-700 px-3 text-[11px] font-semibold text-slate-400"
                    >
                      Review sections
                    </button>
                  </div>
                </div>
              ))}

              {auditReport.similarPairs.slice(0, 4).map((pair, index) => (
                <div key={`similar-${index}`} className="rounded-xl border border-amber-500/25 bg-amber-950/20 p-3">
                  <p className="text-xs font-semibold text-amber-200">Similar sections · {Math.round(pair.similarity * 100)}%</p>
                  <p className="mt-1 text-[11px] text-slate-400">{pair.locationA} · {pair.locationB}</p>
                  <button
                    type="button"
                    onClick={() => void send(`Rewrite ${pair.locationA} and ${pair.locationB} to remove structural similarity while preserving their distinct teaching.`)}
                    className="mt-2 min-h-12 rounded-xl bg-amber-400/15 px-3 text-[11px] font-bold text-amber-200"
                  >
                    Fix automatically
                  </button>
                </div>
              ))}

              {auditReport.repetitions.slice(0, 5).map((repetition, index) => (
                <div key={`repetition-${index}`} className="rounded-xl border border-cyan-500/25 bg-cyan-950/20 p-3">
                  <p className="text-xs font-semibold text-cyan-200">Repeated phrase · “{repetition.phrase}” ×{repetition.count}</p>
                  <button
                    type="button"
                    onClick={() => void send(`Reduce unnecessary repetition of the phrase "${repetition.phrase}" throughout the book. Keep intentional uses and vary the rest.`)}
                    className="mt-2 min-h-12 rounded-xl bg-cyan-400/15 px-3 text-[11px] font-bold text-cyan-200"
                  >
                    Fix automatically
                  </button>
                </div>
              ))}

              {auditReport.overusedWords.slice(0, 5).map((word, index) => (
                <div key={`word-${index}`} className="rounded-xl border border-violet-500/25 bg-violet-950/20 p-3">
                  <p className="text-xs font-semibold text-violet-200">Overused word · “{word.word}” ×{word.count}</p>
                  <button
                    type="button"
                    onClick={() => void send(`Review the overused word "${word.word}" across the book and replace unnecessary repetitions with context-appropriate alternatives.`)}
                    className="mt-2 min-h-12 rounded-xl bg-violet-400/15 px-3 text-[11px] font-bold text-violet-200"
                  >
                    Fix automatically
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {pendingProposal && (
          <section className="max-h-[48dvh] flex-shrink-0 overflow-y-auto border-b border-cyan-500/25 bg-cyan-950/10 px-3 py-3" aria-label="Proposed manuscript changes">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-cyan-300">Change preview</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">{pendingProposal.summary}</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {pendingProposal.changes.length} change{pendingProposal.changes.length === 1 ? "" : "s"} · {pendingProposal.confidence ?? "high"} confidence
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowProposalDiff((current) => !current)}
                className="min-h-12 flex-shrink-0 rounded-xl border border-slate-700 px-3 text-[11px] font-semibold text-slate-300"
              >
                {showProposalDiff ? "Hide diff" : "View diff"}
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {pendingProposal.changes.map((change) => {
                const selected = pendingProposal.selectedPaths.includes(change.path);
                return (
                  <label
                    key={change.path}
                    className={`block min-h-12 rounded-xl border px-3 py-2 ${selected ? "border-cyan-500/40 bg-slate-900/80" : "border-slate-800 bg-slate-950/40 opacity-70"}`}
                  >
                    <span className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleProposalPath(change.path)}
                        className="mt-1 h-6 w-6 flex-shrink-0 accent-cyan-400"
                      />
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
              <button
                type="button"
                onClick={() => void applyProposal(pendingProposal.selectedPaths)}
                disabled={loading || pendingProposal.selectedPaths.length === 0}
                className="min-h-12 rounded-xl bg-cyan-400 px-4 text-xs font-bold text-slate-950 disabled:bg-slate-700 disabled:text-slate-500"
              >
                Apply selected ({pendingProposal.selectedPaths.length})
              </button>
              <button
                type="button"
                onClick={() => void applyProposal(pendingProposal.changes.map((change) => change.path))}
                disabled={loading}
                className="min-h-12 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-xs font-bold text-emerald-300 disabled:opacity-50"
              >
                Apply all
              </button>
              <button
                type="button"
                onClick={rejectProposal}
                disabled={loading}
                className="min-h-12 rounded-xl border border-slate-700 px-4 text-xs font-semibold text-slate-400 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </section>
        )}

        {/* Message history */}
        <div
          ref={scrollRef}
          className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4"
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-cyan-500/20 text-cyan-100"
                    : msg.role === "system"
                    ? "bg-slate-800/60 text-slate-400 italic"
                    : "bg-slate-800 text-slate-200 whitespace-pre-wrap"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-slate-800 px-4 py-3">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Input — bottom padding accounts for mobile bottom nav */}
        <div
          className="flex-shrink-0 border-t border-slate-800 p-3"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
        >
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={loading}
              placeholder={
                academy
                  ? 'e.g. "Rename module 2 to Week 2: Practice"'
                  : "Run the pipeline first…"
              }
              rows={2}
              className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5 text-base text-slate-100 placeholder:text-slate-600 focus:border-cyan-500/60 focus:outline-none disabled:opacity-40"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || loading}
              aria-label="Send"
              className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-cyan-500 text-slate-950 transition hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
                <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-600">⌘ Return to send · changes save to preview automatically</p>
        </div>
      </div>
    </>
  );
}
