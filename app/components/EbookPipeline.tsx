"use client";

import { useState, useRef, useCallback, useId, useEffect, type ChangeEvent } from "react";
import { ProseEditor, ProseToolbarProvider, SharedProseToolbar } from "./ProseEditor";
import { EbookProgressRing } from "@/app/components/EbookProgressRing";
import { VoiceStudio } from "@/app/components/VoiceStudio";
import { TranscriptSourceMapPanel } from "@/app/components/TranscriptSourceMapPanel";
import { AudioSourceManager } from "@/app/components/AudioSourceManager";
import {
  saveEbookJob,
  getEbookJob,
  newJobId,
} from "@/lib/ebook-job-store";
import { harmonizeBookManifest } from "@/lib/editorial-style-bible";
import { BOOK_TEMPLATES, BOOK_TEMPLATE_IDS } from "@/lib/book-templates";
import type { BookTemplateId } from "@/lib/book-templates";
import type {
  VoiceDNA,
  ContentMap,
  BookArchitecture,
  SectionAssignment,
  SectionDraft,
  ChapterDraft,
  FrontBackMatter,
  BackMatter,
  EbookJobState,
  EbookManifest,
} from "@/lib/schemas/ebook";
import { SectionAssignmentSchema, EbookJobStateSchema } from "@/lib/schemas/ebook";

// ─── Types ────────────────────────────────────────────────────────────────────

type PipelineStage =
  | "idle"
  | "transcribing"
  | "filtering"
  | "analyzing"
  | "mapping"
  | "architecting"
  | "assigning"
  | "writing"
  | "polishing"
  | "frontmatter"
  | "exporting"
  | "complete"
  | "failed";

const STAGE_LABELS: Record<PipelineStage, string> = {
  idle: "Ready",
  transcribing: "Transcribing audio…",
  filtering: "Filtering signal…",
  analyzing: "Extracting voice DNA…",
  mapping: "Mapping content…",
  architecting: "Designing chapters…",
  assigning: "Assigning segments…",
  writing: "Writing sections…",
  polishing: "Polishing chapters…",
  frontmatter: "Writing front matter…",
  exporting: "Generating PDF, EPUB & Word…",
  complete: "Complete",
  failed: "Failed",
};

const STAGE_ORDER: PipelineStage[] = [
  "idle", "transcribing", "filtering", "analyzing", "mapping", "architecting",
  "assigning", "writing", "polishing", "frontmatter", "exporting", "complete",
];
type SignalFilterState = "idle" | "applied" | "skipped";
type QualityReport = { score: number; pass: boolean; issues: { severity: "warn" | "error"; message: string }[] };
type ReviewTab = "manuscript" | "source-map" | "audio-sources";
export type EbookPipelineSnapshot = {
  stage: PipelineStage;
  progress: { total: number; completed: number };
  totalWords: number;
  reviewReady: boolean;
  qualityReport: QualityReport | null;
  error: string | null;
  bookTitle: string | null;
  chapterCount: number;
  frontMatterSections: number;
};

function routeLabel(url: string): string {
  return url.split("/").filter(Boolean).slice(-2).join("/");
}

function parseSignalFilterLog(logEntries: string[]): { state: SignalFilterState; detail: string | null } {
  const relevant = [...logEntries].reverse().find(
    (entry) => entry.includes("Signal filter unavailable") || entry.includes("Signal filtered") || entry.includes("Signal filter complete")
  );
  if (!relevant) return { state: "idle", detail: null };
  const message = relevant.replace(/^\[[^\]]+\]\s*/, "");
  if (message.includes("Signal filter unavailable")) {
    return { state: "skipped", detail: message };
  }
  return { state: "applied", detail: message };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function postJson<T>(url: string, body: unknown, retries = 1): Promise<T> {
  const route = routeLabel(url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : "Unknown network failure";
      throw new Error([`Request failed: ${route}`, `Cause: ${cause}`].join("\n"));
    }
    if (!res.ok) {
      const rawText = await res.text();
      let err: { error?: string; details?: string; route?: string } = {};
      try {
        err = rawText ? JSON.parse(rawText) as { error?: string; details?: string; route?: string } : {};
      } catch {
        err = rawText ? { details: rawText } : {};
      }
      const msg = err.error || `HTTP ${res.status} error from ${route}`;
      // Do not retry client errors except 429 (Rate Limit)
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await new Promise<void>((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      // Surface a helpful message for persistent 401s
      if (res.status === 401) {
        throw new Error("Session expired or API key invalid — please refresh the page and try again");
      }
      throw new Error([
        `Request failed: ${err.route || route}`,
        `Status: ${res.status} ${res.statusText}`,
        `Error: ${msg}`,
        err.details ? `Details: ${err.details}` : "",
      ].filter(Boolean).join("\n"));
    }
    return res.json() as Promise<T>;
  }
  throw new Error(`Request failed after retries: ${route}`);
}

async function streamSection(
  assignment: SectionAssignment,
  authorConfig?: { instructions: string; targetAudience: string }
): Promise<{ body: string; claimLedger: Array<{ claim: string; excerptNumbers: number[] }>; passiveVoiceCount: number; unfullfilledHook: string | null; sequenceBreakCount: number; fallback: boolean; fallbackError: string | null }> {
  const result = await postJson<{ body: string; claimLedger?: Array<{ claim: string; excerptNumbers: number[] }>; passiveVoiceCount?: number; unfullfilledHook?: string | null; sequenceBreakCount?: number; fallback?: boolean; error?: string }>(
    "/api/ebook/write-section", { assignment, ...(authorConfig ? { authorConfig } : {}) }
  );
  return {
    body: (result.body ?? "").trim(),
    claimLedger: result.claimLedger ?? [],
    passiveVoiceCount: result.passiveVoiceCount ?? 0,
    unfullfilledHook: result.unfullfilledHook ?? null,
    sequenceBreakCount: result.sequenceBreakCount ?? 0,
    fallback: result.fallback === true,
    fallbackError: result.fallback === true ? (result.error ?? "unknown error") : null,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function toIsoOrNow(value: unknown, nowIso: string): string {
  if (typeof value !== "string") return nowIso;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : nowIso;
}

function sanitizeJobStateForPersistence(input: EbookJobState): EbookJobState {
  const nowIso = new Date().toISOString();
  const seen = new WeakSet<object>();

  let plain: unknown;
  try {
    plain = JSON.parse(JSON.stringify(input, (_key, value: unknown) => {
      if (typeof value === "function") return undefined;
      if (typeof value === "bigint") return Number(value);
      if (value && typeof value === "object") {
        if (seen.has(value as object)) return undefined;
        seen.add(value as object);
      }
      return value;
    }));
  } catch {
    plain = {};
  }

  const record = (plain && typeof plain === "object") ? (plain as Record<string, unknown>) : {};
  const normalized: Record<string, unknown> = {
    ...record,
    jobId: typeof record.jobId === "string" && record.jobId.trim().length > 0 ? record.jobId : newJobId(),
    status: typeof record.status === "string" ? record.status : "idle",
    createdAt: toIsoOrNow(record.createdAt, nowIso),
    updatedAt: toIsoOrNow(record.updatedAt, nowIso),
  };

  const parsed = EbookJobStateSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;

  return {
    jobId: String(normalized.jobId),
    status: "idle",
    audioFileNames: [],
    transcripts: [],
    masterTranscript: "",
    filteredTranscript: "",
    filterRemovedCount: 0,
    voiceDNA: null,
    contentMap: null,
    architecture: null,
    sectionAssignments: [],
    sections: [],
    chapters: [],
    frontMatter: null,
    backMatter: null,
    exportUrls: null,
    currentStage: "",
    progress: { total: 0, completed: 0 },
    errorLog: [],
    createdAt: toIsoOrNow(normalized.createdAt, nowIso),
    updatedAt: toIsoOrNow(normalized.updatedAt, nowIso),
  };
}

// ─── Upgrade 4 (writer): Illustration / story label extractor ────────────────
// Scans written prose for story-opening sentences and returns short labels
// (first 100 chars) so later sections can be told not to retell the same story.
const STORY_OPENERS = /\b(when i was|i remember|there was a|let me tell you|i once|one day|a man named|a woman named|i met a|i spoke to|i was in|years ago|i had a|the story of|he told me|she told me|they told me|i saw a|i witnessed)\b/i;

function extractIllustrationLabels(body: string): string[] {
  const labels: string[] = [];
  const sentences = body.replace(/^#{1,3} .+$/gm, "").split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    if (STORY_OPENERS.test(sentence)) {
      labels.push(sentence.replace(/[#>*_]/g, "").trim().slice(0, 100));
    }
  }
  return labels;
}

// ─── Upgrade 6: N-gram overlap dedup gate ────────────────────────────────────

function ngramTokens(text: string, n = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function ngramOverlapRatio(a: string, b: string, n = 4): number {
  const setA = ngramTokens(a, n);
  const setB = ngramTokens(b, n);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) { if (setB.has(gram)) shared++; }
  return shared / Math.min(setA.size, setB.size);
}

/** Returns sentences from newBody that overlap ≥ threshold with any sentence in corpus */
function detectDuplicateSentences(
  newBody: string,
  corpus: string,
  threshold = 0.55
): string[] {
  const corpusSentences = corpus.match(/[^.!?]+[.!?]+/g) ?? [];
  const newSentences = newBody.match(/[^.!?]+[.!?]+/g) ?? [];
  const flagged: string[] = [];
  for (const ns of newSentences) {
    if (ns.trim().split(/\s+/).length < 8) continue; // skip fragments
    const hit = corpusSentences.some((cs) => ngramOverlapRatio(ns, cs) >= threshold);
    if (hit) flagged.push(ns.trim());
  }
  return flagged;
}

// ─── Amendment 1: Coverage Ledger Builder ─────────────────────────────────────
// Returns a compact heading + one-sentence summary for every written section so
// the LLM can see what ground has been covered without re-reading full bodies.
function buildCoverageLedger(
  sections: SectionDraft[],
  assignmentLookup?: Map<string, string[]>, // key: `ch-sec`, value: keyPoints[]
): { heading: string; summary: string }[] {
  return sections.map((s) => {
    // Extract the opening claim of EVERY paragraph (up to 6), not just the first.
    // One sentence per section was too thin — the LLM couldn't tell what ground was covered.
    const paragraphs = (s.body ?? "").split(/\n\n+/).filter(Boolean);
    const openers = paragraphs
      .slice(0, 6)
      .map((p) =>
        p.replace(/^#{1,3} .+$/gm, "")
          .match(/[^.!?]+[.!?]+/)?.[0]?.trim()?.slice(0, 130) ?? ""
      )
      .filter(Boolean);
    const kps = assignmentLookup?.get(`${s.chapterNumber}-${s.sectionNumber}`) ?? [];
    const keyPointLine = kps.length > 0 ? `Key points: ${kps.slice(0, 4).join("; ")}` : "";
    const summary = [...openers, keyPointLine].filter(Boolean).join(" | ").slice(0, 500);
    return { heading: s.heading, summary };
  }).filter((e) => e.heading && e.summary.length > 10);
}

// ─── Amendment 4: Thesis Sentence Extractor ───────────────────────────────────
// The opening sentence of each paragraph is the most reliable thesis carrier.
// Raised maxPerSection 4→10 and hardCap 35→80: the old limits left most paragraph
// claims invisible to the ban list, allowing the LLM to silently restate body content.
function extractBannedRecaps(sections: SectionDraft[], maxPerSection = 10, hardCap = 80): string[] {
  const all: string[] = [];
  for (const s of sections) {
    const paras = (s.body ?? "").split(/\n\n+/).filter(Boolean);
    for (const para of paras.slice(0, maxPerSection)) {
      const opener = para.replace(/^#{1,3} .+$/gm, "")
        .match(/[^.!?]+[.!?]+/)?.[0]?.trim() ?? "";
      if (opener.split(/\s+/).length >= 8) all.push(opener.slice(0, 150));
    }
    if (all.length >= hardCap) break;
  }
  return all.slice(0, hardCap);
}

// ─── Prose Corpus Sample Builder ────────────────────────────────────────────
// Extracts full paragraph text (up to 120 words each) from the accumulated corpus.
// Previously only extracted the first sentence of each paragraph, making the
// n-gram dedup filter blind to sentences 2-5 of every written paragraph.
// Full paragraph text gives filterConsumedExcerpts a complete view of what
// has already been written, enabling it to catch semantic repetition accurately.
function buildProseCorpusSample(corpus: string, maxParagraphs = 120): string[] {
  return corpus
    .split(/\n{2,}/)
    .map((p) => {
      const cleaned = p.replace(/^[>\s#*\-]+/, "").trim();
      const words = cleaned.split(/\s+/);
      // Require at least 8 words; cap at 120 words per paragraph to bound token usage
      return words.length >= 8 ? words.slice(0, 120).join(" ") : null;
    })
    .filter((s): s is string => s !== null)
    .slice(0, maxParagraphs);
}

// ─── Amendment 6: Lexical Fingerprint Extractor ───────────────────────────────
// Counts 3-gram frequency across the written corpus and returns the top-N phrases
// the LLM should diversify away from (excluding scripture-heavy n-grams).
const STOP_WORDS = new Set([
  "the","a","an","and","but","or","of","to","in","on","at","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would","can","could",
  "should","may","might","must","shall","not","no","so","if","as","by","for","from",
  "with","that","this","it","he","she","we","they","i","you","his","her","our","their",
  "its","my","your","who","which","what","when","where","how","all","also","more","just",
  "like","about","then","there","than","up","out","only","over","after","before","since",
  "while","although","because","into","through","during","some","any","each","both",
]);

function extractOverusedPhrases(corpus: string, topN = 10): string[] {
  if (!corpus || corpus.length < 800) return [];
  const words = corpus.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const freq = new Map<string, number>();
  for (let i = 0; i <= words.length - 3; i++) {
    const [a, b, c] = [words[i], words[i + 1], words[i + 2]];
    // Skip trigrams where the first two tokens are both stop words
    if (STOP_WORDS.has(a) && STOP_WORDS.has(b)) continue;
    // Skip scripture citation patterns like "john three sixteen"
    if (/^\d+$/.test(c)) continue;
    const gram = `${a} ${b} ${c}`;
    freq.set(gram, (freq.get(gram) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .filter(([, cnt]) => cnt >= 3) // must appear ≥3 times to be worth flagging
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([gram]) => gram);
}

// ─── Seq-Amendment 3: Argument-Turn Extractor ─────────────────────────────────
// Scans excerpts for speaker pivot phrases — the moments the teacher changes
// direction or signals a key point. These mark paragraph boundaries the LLM
// must NOT merge across.
const TURN_SIGNALS = /\b(but here'?s? (?:the )?(?:thing|truth|key|point)|now watch this|let me show you|look at (?:verse|this)|here'?s? what i want you to see|here'?s? the (?:point|key|thing)|but watch|but look at this|now look|pay attention|don'?t miss this|notice this|watch this|get this|and notice|the (?:point|key|truth|secret) is|so here'?s? (?:what|where|the)|now here'?s? the|here'?s? where it gets|but this is (?:important|key|critical)|so what does (?:that|this) mean|what does that look like|now what about|and this is where|see what happened|watch what|now consider|look at what)\b/gi;

function extractSequenceTurns(excerpts: string[]): string[] {
  const turns: string[] = [];
  for (const excerpt of excerpts) {
    const sentences = excerpt.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (const sentence of sentences) {
      if (TURN_SIGNALS.test(sentence)) {
        TURN_SIGNALS.lastIndex = 0;
        const cleaned = sentence.replace(/[#>*_]/g, "").trim().slice(0, 140);
        if (!turns.includes(cleaned)) turns.push(cleaned);
      }
    }
  }
  return turns.slice(0, 20); // cap to avoid prompt bloat
}

// ─── Seq-Amendment 4: Story Setup → Payoff Extractor ─────────────────────────
// Finds story-opening sentences and the principle/payoff sentence that follows
// within 4 sentences. Passed to the writer as ordered pairs: setup must come
// before payoff — reversing them violates the speaker's teaching logic.
const PRINCIPLE_SIGNALS = /\b(the (?:lesson|point|truth|key|principle|answer|secret) (?:is|here is)|what (?:this|that) (?:teaches|shows|tells|means)|(?:and )?(?:that'?s? why|that'?s? the|this is why|this means)|so the (?:point|truth|lesson)|here'?s? the truth|the moral (?:is|of)|what god (?:was|is) saying|what (?:he|she|they) (?:was|were|is) trying to say|the takeaway|the (?:real )?question is|the (?:real )?issue (?:is|here)|so what|and so|therefore)\b/i;

function extractStoryPayoffPairs(excerpts: string[]): { setup: string; principle: string }[] {
  const pairs: { setup: string; principle: string }[] = [];
  for (const excerpt of excerpts) {
    const sentences = excerpt.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (let i = 0; i < sentences.length; i++) {
      if (!STORY_OPENERS.test(sentences[i])) continue;
      // Look forward up to 5 sentences for the payoff
      for (let j = i + 1; j < Math.min(i + 6, sentences.length); j++) {
        if (PRINCIPLE_SIGNALS.test(sentences[j])) {
          pairs.push({
            setup: sentences[i].replace(/[#>*_]/g, "").trim().slice(0, 130),
            principle: sentences[j].replace(/[#>*_]/g, "").trim().slice(0, 130),
          });
          break;
        }
      }
    }
  }
  return pairs.slice(0, 8);
}

// ─── Seq-Amendment 5: Scripture Position Extractor ───────────────────────────
// Records which excerpt index (0-based) each scripture reference first appears
// in. Passed to the LLM so it knows a verse from Excerpt 4 must not appear in
// paragraphs anchored to Excerpts 1–3.
const SCRIPTURE_REF_RE = /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|(?:1|2)\s*samuel|(?:1|2)\s*kings|(?:1|2)\s*chronicles|ezra|nehemiah|esther|job|psalm(?:s)?|proverbs|ecclesiastes|(?:song of solomon|song of songs)|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|(?:1|2)\s*corinthians|galatians|ephesians|philippians|colossians|(?:1|2)\s*thessalonians|(?:1|2)\s*timothy|titus|philemon|hebrews|james|(?:1|2|3)\s*(?:john|peter)|jude|revelation)\s+\d+:\d+/gi;

function extractScripturePositions(excerpts: string[]): { reference: string; excerptIndex: number }[] {
  const seen = new Set<string>();
  const positions: { reference: string; excerptIndex: number }[] = [];
  for (let i = 0; i < excerpts.length; i++) {
    const matches = excerpts[i].matchAll(SCRIPTURE_REF_RE);
    for (const match of matches) {
      const ref = match[0].replace(/\s+/g, " ").trim().toLowerCase();
      if (!seen.has(ref)) {
        seen.add(ref);
        positions.push({ reference: match[0].trim(), excerptIndex: i });
      }
    }
  }
  return positions;
}

// ─── Seq-Amendment 2: Server-side sequence watermark ─────────────────────────
// For each written paragraph, finds the best-matching excerpt by 4-gram overlap
// and verifies excerpt indices are non-decreasing. Returns any positions where
// the LLM jumped back to an earlier excerpt (sequence inversion).
function checkSequenceWatermark(
  paragraphs: string[],
  excerpts: string[],
  minScore = 0.06
): { paragraphIdx: number; expectedMin: number; got: number }[] {
  if (excerpts.length < 2) return [];
  const breaks: { paragraphIdx: number; expectedMin: number; got: number }[] = [];
  let lastExcerptIdx = -1;
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const ngrams = (text: string, n: number): Set<string> => {
    const w = words(text);
    const s = new Set<string>();
    for (let i = 0; i <= w.length - n; i++) s.add(w.slice(i, i + n).join(" "));
    return s;
  };
  const overlapScore = (a: string, b: string): number => {
    const sa = ngrams(a, 4);
    const sb = ngrams(b, 4);
    if (sa.size === 0) return 0;
    let shared = 0;
    for (const g of sa) { if (sb.has(g)) shared++; }
    return shared / sa.size;
  };
  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    let bestScore = minScore;
    let bestExcerptIdx = -1;
    for (let eIdx = 0; eIdx < excerpts.length; eIdx++) {
      const score = overlapScore(paragraphs[pIdx], excerpts[eIdx]);
      if (score > bestScore) { bestScore = score; bestExcerptIdx = eIdx; }
    }
    if (bestExcerptIdx >= 0) {
      if (lastExcerptIdx >= 0 && bestExcerptIdx < lastExcerptIdx) {
        breaks.push({ paragraphIdx: pIdx + 1, expectedMin: lastExcerptIdx + 1, got: bestExcerptIdx + 1 });
      }
      lastExcerptIdx = Math.max(lastExcerptIdx, bestExcerptIdx);
    }
  }
  return breaks;
}

// ─── Audio Upload Card ────────────────────────────────────────────────────────

function AudioCard({
  index,
  file,
  onFile,
  transcriptFile,
  onTranscriptFile,
  disabled,
}: {
  index: number;
  file: File | null;
  onFile: (f: File | null) => void;
  transcriptFile: File | null;
  onTranscriptFile: (f: File | null) => void;
  disabled: boolean;
}) {
  const audioInputId = useId();
  const txInputId = useId();

  const onAudioDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      // Accept audio and video containers (MP4/MOV/M4A often carry sermon audio on iOS)
      if (f) onFile(f);
    },
    [onFile]
  );

  const onTxDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) onTranscriptFile(f);
    },
    [onTranscriptFile]
  );

  const hasContent = file || transcriptFile;

  return (
    <div
      className={[
        "flex flex-col rounded-xl border-2 border-dashed overflow-hidden transition-all",
        hasContent
          ? "border-cyan-400/50 bg-cyan-500/6"
          : "border-slate-600/50 bg-slate-800/30",
        disabled ? "opacity-50 pointer-events-none" : "",
      ].join(" ")}
    >
      {/* Slot label */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          Slot {index + 1}
        </span>
        {hasContent && (
          <span className="text-[9px] text-emerald-400 font-semibold">✓ Ready</span>
        )}
      </div>

      {/* ── Audio upload ── */}
      <label
        htmlFor={audioInputId}
        onDrop={onAudioDrop}
        onDragOver={(e) => e.preventDefault()}
        className={[
          "relative flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors group",
          file ? "bg-cyan-500/10" : "hover:bg-slate-700/30",
        ].join(" ")}
      >
        <input
          id={audioInputId}
          type="file"
          accept="audio/*,video/*,.mp3,.mp4,.m4a,.m4v,.mov,.wav,.aac,.ogg,.flac,.webm"
          className="sr-only"
          disabled={disabled}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
          className={`h-5 w-5 flex-shrink-0 ${file ? "text-cyan-400" : "text-slate-500 group-hover:text-slate-300"}`}>
          <path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM21 16c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM9 10l12-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="flex-1 min-w-0">
          {file ? (
            <span className="text-xs font-medium text-cyan-300 block truncate">{file.name}</span>
          ) : (
            <span className="text-xs text-slate-500 group-hover:text-slate-300">
              Audio file <span className="text-[10px] text-slate-600">(tap or drop)</span>
            </span>
          )}
        </div>
        {file && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onFile(null); }}
            className="flex-shrink-0 h-6 w-6 rounded-full bg-slate-700/80 flex items-center justify-center text-slate-400 hover:text-red-400 text-sm leading-none"
            aria-label="Remove audio"
          >×</button>
        )}
      </label>

      {/* ── Divider ── */}
      <div className="flex items-center gap-2 px-3">
        <div className="flex-1 h-px bg-slate-700/60" />
        <span className="text-[9px] text-slate-600 font-medium">OR</span>
        <div className="flex-1 h-px bg-slate-700/60" />
      </div>

      {/* ── Transcript upload ── */}
      <label
        htmlFor={txInputId}
        onDrop={onTxDrop}
        onDragOver={(e) => e.preventDefault()}
        className={[
          "relative flex items-center gap-2.5 px-3 py-2.5 pb-3 cursor-pointer transition-colors group",
          transcriptFile ? "bg-violet-500/10" : "hover:bg-slate-700/30",
        ].join(" ")}
      >
        <input
          id={txInputId}
          type="file"
          accept=".txt,.md,.text"
          className="sr-only"
          disabled={disabled}
          onChange={(e) => onTranscriptFile(e.target.files?.[0] ?? null)}
        />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
          className={`h-5 w-5 flex-shrink-0 ${transcriptFile ? "text-violet-400" : "text-slate-500 group-hover:text-slate-300"}`}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="flex-1 min-w-0">
          {transcriptFile ? (
            <span className="text-xs font-medium text-violet-300 block truncate">{transcriptFile.name}</span>
          ) : (
            <span className="text-xs text-slate-500 group-hover:text-slate-300">
              Transcript <span className="text-[10px] text-slate-600">(.txt — tap or drop)</span>
            </span>
          )}
        </div>
        {transcriptFile && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onTranscriptFile(null); }}
            className="flex-shrink-0 h-6 w-6 rounded-full bg-slate-700/80 flex items-center justify-center text-slate-400 hover:text-red-400 text-sm leading-none"
            aria-label="Remove transcript"
          >×</button>
        )}
      </label>
    </div>
  );
}

// ─── Stage Tracker ───────────────────────────────────────────────────────────

const STAGE_STEPS: { key: PipelineStage; label: string; description: string }[] = [
  { key: "transcribing", label: "Transcribe",   description: "Converting audio to text via Deepgram nova-2" },
  { key: "filtering",    label: "Signal Filter", description: "Stripping prayers, announcements, and non-teaching content from transcript" },
  { key: "analyzing",    label: "Voice DNA",    description: "Extracting author's signature phrases, tone, and teaching style" },
  { key: "mapping",      label: "Content Map",  description: "Inventorying every teaching segment, scripture, and quote" },
  { key: "architecting", label: "Chapters",     description: "Designing chapter and section structure from the content" },
  { key: "writing",      label: "Writing",      description: "Drafting each section strictly from transcript source material" },
  { key: "polishing",    label: "Polish",       description: "Adding chapter intros, conclusions, and key takeaways" },
  { key: "frontmatter",  label: "Front Matter", description: "Writing introduction and conclusion from your words" },
  { key: "exporting",    label: "Export",       description: "Generating PDF and EPUB files for download" },
];

// Collapse adjacent stages so assigning/polishing/frontmatter light up their parent step
function resolveActiveStep(current: PipelineStage): PipelineStage {
  if (current === "assigning") return "architecting";
  if (current === "polishing") return "polishing";
  return current;
}

function EbookStageTracker({
  current,
  progress,
  signalFilterState,
  signalFilterDetail,
}: {
  current: PipelineStage;
  progress: { total: number; completed: number };
  signalFilterState: SignalFilterState;
  signalFilterDetail: string | null;
}) {
  const currentIdx = STAGE_ORDER.indexOf(current);
  const activeKey = resolveActiveStep(current);
  const activeStep = STAGE_STEPS.find((s) => s.key === activeKey);

  return (
    <div className="rounded-2xl border border-cyan-500/15 bg-slate-900/60 overflow-hidden shadow-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              current === "complete" ? "bg-emerald-400" :
              current === "failed"   ? "bg-red-500" :
              "bg-cyan-400 animate-pulse"
            }`}
            style={{
              boxShadow: current === "complete" ? "0 0 10px rgba(52,211,153,0.80)" :
                         current === "failed"   ? "0 0 10px rgba(239,68,68,0.90)" :
                         "0 0 10px rgba(6,182,212,0.95)"
            }}
          />
          <span className="text-sm font-semibold uppercase tracking-widest text-slate-200">
            {current === "complete" ? "Production Complete" : current === "failed" ? "Production Failed" : "Pipeline Active"}
          </span>
        </div>
        {current === "writing" && progress.total > 0 && (
          <span className="text-xs tabular-nums text-slate-400">
            Section {progress.completed} / {progress.total}
          </span>
        )}
      </div>

      {/* Agent step pills */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-800/60">
        {STAGE_STEPS.map((step) => {
          const idx = STAGE_ORDER.indexOf(step.key);
          const done   = idx < currentIdx || current === "complete";
          const active = step.key === activeKey && current !== "complete" && current !== "failed" && current !== "idle";
          const skipped = step.key === "filtering" && signalFilterState === "skipped";
          return (
            <div key={step.key} className="flex items-center gap-1.5">
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full transition-all ${
                  skipped ? "bg-amber-400" :
                  done   ? "bg-emerald-400" :
                  active ? "bg-cyan-400 animate-pulse" :
                           "bg-slate-700"
                }`}
                style={skipped ? { boxShadow: "0 0 6px rgba(251,191,36,0.7)" } :
                       done ? { boxShadow: "0 0 6px rgba(52,211,153,0.6)" } :
                       active ? { boxShadow: "0 0 8px rgba(6,182,212,0.9)" } : undefined}
              />
              <span className={`text-[11px] font-medium transition-colors ${
                skipped ? "text-amber-300" : active ? "text-cyan-300" : done ? "text-emerald-400" : "text-slate-600"
              }`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {signalFilterState === "skipped" && signalFilterDetail && current !== "failed" && (
        <div className="border-b border-amber-500/10 bg-amber-500/5 px-4 py-2.5">
          <p className="text-xs text-amber-300/90 leading-relaxed">
            Signal filter was skipped. Downstream steps are running on the raw transcript.
          </p>
          <p className="mt-1 text-[11px] text-amber-200/70 leading-relaxed break-words">{signalFilterDetail}</p>
        </div>
      )}

      {/* Active step description */}
      {activeStep && current !== "complete" && current !== "failed" && (
        <div className="px-4 py-2.5">
          <p className="text-xs text-slate-400 leading-relaxed">{activeStep.description}</p>
        </div>
      )}
    </div>
  );
}

// ─── Chapter Preview Card ─────────────────────────────────────────────────────

function ChapterCard({
  chapter,
  editable = false,
  onChange,
}: {
  chapter: ChapterDraft;
  editable?: boolean;
  onChange?: (next: ChapterDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const done = chapter.status === "complete";

  const patchChapter = (patch: Partial<ChapterDraft>) => {
    if (!onChange) return;
    onChange({ ...chapter, ...patch });
  };

  const patchSection = (sectionNumber: number, patch: Partial<SectionDraft>) => {
    if (!onChange) return;
    onChange({
      ...chapter,
      sections: chapter.sections.map((section) => (
        section.sectionNumber === sectionNumber ? { ...section, ...patch } : section
      )),
    });
  };

  const patchListField = (field: "keyTakeaways" | "reflectionQuestions", value: string) => {
    if (!onChange) return;
    const items = value.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    onChange({ ...chapter, [field]: items } as ChapterDraft);
  };

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left min-h-[48px]"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`flex-shrink-0 h-2 w-2 rounded-full ${done ? "bg-emerald-400" : "bg-cyan-400 animate-pulse"}`} />
          <span className="text-xs text-slate-400 flex-shrink-0">Ch {chapter.number}</span>
          <span className="text-sm font-medium text-slate-200 truncate">{chapter.title}</span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {done && (
            <span className="text-[10px] text-slate-500 tabular-nums">{chapter.totalWordCount.toLocaleString()} wds</span>
          )}
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            className={`h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-700/40 px-4 pb-4 pt-3 space-y-3">
          {editable && (
            <div className="space-y-3 rounded-xl border border-slate-700/50 bg-slate-900/50 p-3">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Chapter Title</label>
                <input
                  value={chapter.title}
                  onChange={(e) => patchChapter({ title: e.target.value })}
                  className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none ring-0 focus:border-cyan-500/40"
                />
              </div>

              <div>
                <ProseEditor
                  label="Chapter Intro"
                  value={chapter.intro ?? ""}
                  onChange={(v) => patchChapter({ intro: v })}
                  rows={4}
                  placeholder="Chapter opening paragraph…"
                />
              </div>
            </div>
          )}

          {chapter.sections.map((s, sectionIndex) => {
            const heading = s.heading?.trim() || `Section ${sectionIndex + 1}`;
            return (
            <div key={s.sectionNumber} className={editable ? "space-y-2 rounded-xl border border-slate-700/50 bg-slate-900/50 p-3" : ""}>
              {editable ? (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[220px] flex-1">
                      <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Subsection Title</label>
                      <input
                        value={s.heading}
                        onChange={(e) => patchSection(s.sectionNumber, { heading: e.target.value })}
                        placeholder={`Section ${sectionIndex + 1}`}
                        className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none ring-0 focus:border-cyan-500/40"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSection(s.sectionNumber)}
                      className="min-h-[48px] rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-200"
                    >
                      Delete Subsection
                    </button>
                  </div>
                  <ProseEditor
                    label={heading}
                    value={s.body ?? ""}
                    onChange={(v) => patchSection(s.sectionNumber, { body: v, wordCount: countWords(v) })}
                    rows={10}
                    placeholder="Write section body…"
                  />
                </>
              ) : (
                <>
                  <p className="text-xs font-semibold text-cyan-400/80 mb-1">{s.heading}</p>
                  <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">
                    {(s.body ?? "").slice(0, 220)}{(s.body ?? "").length > 220 ? "…" : ""}
                  </p>
                </>
              )}
            </div>
          );})}

          {editable ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Key Takeaways</label>
                <textarea
                  value={(chapter.keyTakeaways ?? []).join("\n")}
                  onChange={(e) => patchListField("keyTakeaways", e.target.value)}
                  rows={5}
                  className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Reflection Questions</label>
                <textarea
                  value={(chapter.reflectionQuestions ?? []).join("\n")}
                  onChange={(e) => patchListField("reflectionQuestions", e.target.value)}
                  rows={5}
                  className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>
          ) : (chapter.keyTakeaways?.length ?? 0) > 0 && (
            <div className="mt-2 rounded-lg bg-cyan-500/8 border border-cyan-500/20 p-3">
              <p className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest mb-2">Key Takeaways</p>
              {(chapter.keyTakeaways ?? []).map((t, i) => (
                <p key={i} className="text-xs text-slate-300 leading-relaxed">• {t}</p>
              ))}
            </div>
          )}

          {editable && (
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Forward Question</label>
              <textarea
                value={chapter.forwardQuestion ?? ""}
                onChange={(e) => patchChapter({ forwardQuestion: e.target.value })}
                rows={4}
                className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Print Specification Toggle ───────────────────────────────────────────────

type PrintSpecType = {
  trimSize: "6x9" | "5.5x8.5" | "5x8";
  runningHeaders: boolean;
  folioStyle?: "center" | "outside" | "none-on-openers";
  frontMatterNumbering?: "arabic" | "roman" | "none";
  sectionOrnament?: "rule" | "fleuron" | "asterism" | "dinkus" | "none";
  bodyTextAlign?: "template" | "left" | "right" | "center" | "justify";
  bodyFontFamily?: "template" | "georgia" | "times" | "garamond" | "palatino" | "helvetica";
  fontSizeScale?: number;
};

function PrintSpecPanel({
  trimSize,
  runningHeaders,
  folioStyle = "center",
  frontMatterNumbering = "arabic",
  sectionOrnament = "rule",
  bodyTextAlign = "template",
  bodyFontFamily = "template",
  fontSizeScale = 1.0,
  onChange,
}: {
  trimSize: "6x9" | "5.5x8.5" | "5x8";
  runningHeaders: boolean;
  folioStyle?: "center" | "outside" | "none-on-openers";
  frontMatterNumbering?: "arabic" | "roman" | "none";
  sectionOrnament?: "rule" | "fleuron" | "asterism" | "dinkus" | "none";
  bodyTextAlign?: "template" | "left" | "right" | "center" | "justify";
  bodyFontFamily?: "template" | "georgia" | "times" | "garamond" | "palatino" | "helvetica";
  fontSizeScale?: number;
  onChange: (spec: PrintSpecType) => void;
}) {
  const [open, setOpen] = useState(false);

  const TRIM_OPTIONS: { value: "6x9" | "5.5x8.5" | "5x8"; label: string; sub: string }[] = [
    { value: "6x9",     label: "6 × 9 in",    sub: "US Trade (Zondervan, Nelson)" },
    { value: "5.5x8.5", label: "5.5 × 8.5 in", sub: "US Digest (Charisma, Hay House)" },
    { value: "5x8",     label: "5 × 8 in",     sub: "Amazon Bestseller (CreateSpace)" },
  ];

  return (
    <div className="w-full rounded-xl border border-slate-700/50 bg-slate-900/60 overflow-hidden">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 min-h-[48px] text-left"
      >
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-cyan-400 flex-shrink-0">
            <path d="M4 5h16M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2M4 5V3m16 2V3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 10h8M8 14h5" strokeLinecap="round" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-200">Print Specifications</span>
          <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-bold text-cyan-300 uppercase tracking-widest">
            {trimSize === "6x9" ? "6×9" : trimSize === "5.5x8.5" ? "5.5×8.5" : "5×8"} · {runningHeaders ? "Headers on" : "No headers"}
          </span>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`h-4 w-4 text-slate-500 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-slate-700/40 px-4 pb-4 pt-3 space-y-4">

          {/* Trim size */}
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Trim Size</p>
            <div className="grid grid-cols-3 gap-2">
              {TRIM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize: opt.value, runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament, bodyTextAlign, bodyFontFamily, fontSizeScale })}
                  className={[
                    "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-all min-h-[52px]",
                    trimSize === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-sm font-bold tabular-nums ${trimSize === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[10px] text-slate-500 leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-slate-600 leading-relaxed">
              Chicago Manual of Style margins applied automatically. Inside (gutter) margin is wider than outside to allow for binding.
            </p>
          </div>

          {/* Running headers */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-3">
            <div>
              <p className="text-xs font-semibold text-slate-200">Running Headers &amp; Page Numbers</p>
              <p className="mt-0.5 text-[10px] text-slate-500">Book title on left pages · Chapter title on right pages · Page numbers at bottom</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={runningHeaders}
              onClick={() => onChange({ trimSize, runningHeaders: !runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament, bodyTextAlign, bodyFontFamily, fontSizeScale })}
              className={[
                "relative flex-shrink-0 h-6 w-11 rounded-full transition-colors duration-200",
                runningHeaders ? "bg-cyan-500" : "bg-slate-600",
              ].join(" ")}
            >
              <span
                style={{ left: runningHeaders ? "calc(100% - 1.375rem)" : "0.125rem" }}
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-[left] duration-200"
              />
            </button>
          </div>

          {/* Folio Style (Page Number Position) */}
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Page Number Style (Folio)</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "center" as const, label: "Center", sub: "Traditional" },
                { value: "outside" as const, label: "Outside", sub: "Penguin/Harper" },
                { value: "none-on-openers" as const, label: "No Openers", sub: "Chicago" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle: opt.value, frontMatterNumbering, sectionOrnament, bodyTextAlign, bodyFontFamily, fontSizeScale })}
                  className={[
                    "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-all min-h-[52px]",
                    folioStyle === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-xs font-semibold ${folioStyle === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[10px] text-slate-500 leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Front Matter Numbering */}
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Front Matter Numbering</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "arabic" as const, label: "1, 2, 3", sub: "Continuous" },
                { value: "roman" as const, label: "i, ii, iii", sub: "Academic" },
                { value: "none" as const, label: "None", sub: "No numbers" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle, frontMatterNumbering: opt.value, sectionOrnament, bodyTextAlign, bodyFontFamily, fontSizeScale })}
                  className={[
                    "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-all min-h-[52px]",
                    frontMatterNumbering === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-xs font-semibold tabular-nums ${frontMatterNumbering === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[10px] text-slate-500 leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Section Ornaments */}
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Section Break Ornament</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "rule" as const, label: "───", sub: "Horizontal rule" },
                { value: "fleuron" as const, label: "❦", sub: "Fleuron (literary)" },
                { value: "asterism" as const, label: "⁂", sub: "Asterism (fiction)" },
                { value: "dinkus" as const, label: "* * *", sub: "Dinkus (modern)" },
                { value: "none" as const, label: "(blank)", sub: "Space only" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament: opt.value, bodyTextAlign, bodyFontFamily, fontSizeScale })}
                  className={[
                    "flex flex-col items-center justify-center gap-1 rounded-xl border px-3 py-3 transition-all min-h-[56px]",
                    sectionOrnament === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-lg font-semibold ${sectionOrnament === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[10px] text-slate-500 text-center leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Body Text Alignment */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Body Text Alignment</label>
            <div className="grid grid-cols-5 gap-2">
              {[
                { value: "template" as const, label: "Template", sub: "Use template default", icon: "⚙️" },
                { value: "left" as const, label: "Left", sub: "Ragged right", icon: "◁" },
                { value: "justify" as const, label: "Justify", sub: "Fill page", icon: "▭" },
                { value: "center" as const, label: "Center", sub: "Poetry style", icon: "▬" },
                { value: "right" as const, label: "Right", sub: "Ragged left", icon: "▷" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament, bodyTextAlign: opt.value, bodyFontFamily, fontSizeScale })}
                  className={[
                    "flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 transition-all min-h-[72px]",
                    bodyTextAlign === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-xl ${bodyTextAlign === opt.value ? "text-cyan-300" : "text-slate-300"}`}>{opt.icon}</span>
                  <span className={`text-xs font-semibold ${bodyTextAlign === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[9px] text-slate-500 text-center leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Font Family */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Font Family</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "template" as const, label: "Template", sub: "Georgia / Times", family: "system-ui" },
                { value: "georgia" as const, label: "Georgia", sub: "Modern serif", family: "Georgia, serif" },
                { value: "times" as const, label: "Times", sub: "Classic serif", family: "Times New Roman, serif" },
                { value: "garamond" as const, label: "Garamond", sub: "Renaissance", family: "Garamond, serif" },
                { value: "palatino" as const, label: "Palatino", sub: "Calligraphic", family: "Palatino, serif" },
                { value: "helvetica" as const, label: "Helvetica", sub: "Swiss sans", family: "Helvetica, sans-serif" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament, bodyTextAlign, bodyFontFamily: opt.value, fontSizeScale })}
                  className={[
                    "flex flex-col items-center justify-center gap-1 rounded-xl border px-3 py-3 transition-all min-h-[68px]",
                    bodyFontFamily === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-base font-semibold ${bodyFontFamily === opt.value ? "text-cyan-300" : "text-slate-200"}`} style={{ fontFamily: opt.family }}>{opt.label}</span>
                  <span className="text-[9px] text-slate-500 text-center leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Font Size Scale */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">Font Size Scale</label>
            <div className="grid grid-cols-5 gap-2">
              {[
                { value: 0.8, label: "80%", sub: "Compact" },
                { value: 0.9, label: "90%", sub: "Small" },
                { value: 1.0, label: "100%", sub: "Default" },
                { value: 1.1, label: "110%", sub: "Large" },
                { value: 1.2, label: "120%", sub: "XL" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ trimSize, runningHeaders, folioStyle, frontMatterNumbering, sectionOrnament, bodyTextAlign, bodyFontFamily, fontSizeScale: opt.value })}
                  className={[
                    "flex flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 transition-all min-h-[64px]",
                    fontSizeScale === opt.value
                      ? "border-cyan-500/50 bg-cyan-500/10"
                      : "border-slate-700/50 bg-slate-800/30 hover:border-slate-600",
                  ].join(" ")}
                >
                  <span className={`text-sm font-semibold ${fontSizeScale === opt.value ? "text-cyan-300" : "text-slate-200"}`}>{opt.label}</span>
                  <span className="text-[9px] text-slate-500 text-center leading-tight">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Standards badge */}
          <div className="rounded-xl border border-slate-700/30 bg-slate-800/20 px-4 py-3 text-[10px] text-slate-500 leading-relaxed space-y-1">
            <p className="font-semibold text-slate-400">International Premium Print Standards Applied</p>
            <p>· Body text: {bodyFontFamily === "template" ? "Georgia/Times" : bodyFontFamily === "georgia" ? "Georgia" : bodyFontFamily === "times" ? "Times" : bodyFontFamily === "palatino" ? "Palatino" : bodyFontFamily === "helvetica" ? "Helvetica" : "Garamond"} at {Math.round((trimSize === "6x9" ? 11 : 10.5) * (fontSizeScale ?? 1.0))}pt ({Math.round((fontSizeScale ?? 1.0) * 100)}%) · Leading: {Math.round((trimSize === "6x9" ? 14 : 13.5) * (fontSizeScale ?? 1.0))}pt · {bodyTextAlign === "template" ? "Template alignment" : bodyTextAlign === "justify" ? "Justified" : bodyTextAlign === "left" ? "Left-aligned" : bodyTextAlign === "right" ? "Right-aligned" : "Centered"}</p>
            <p>· Scripture: full italic block · accent bar · right-aligned citation with translation badge</p>
            <p>· Non-scripture quote: roman block · em-dash attribution · no accent bar</p>
            <p>· Chapter-opening epigraph: centered · distinct from body · translation shown</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Agent Activity Log ───────────────────────────────────────────────────────

type LogTag = "INIT" | "INFO" | "DONE" | "ERR" | "STRM";

interface LogCfg { tag: LogTag; tagCls: string; msgCls: string }

const LOG_LEVELS: Record<LogTag, LogCfg> = {
  INIT: { tag: "INIT", tagCls: "border-cyan-400/30    bg-cyan-400/10    text-cyan-400",    msgCls: "text-slate-200" },
  INFO: { tag: "INFO", tagCls: "border-slate-500/30   bg-slate-500/10   text-slate-400",   msgCls: "text-slate-300" },
  DONE: { tag: "DONE", tagCls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400", msgCls: "text-slate-100" },
  ERR:  { tag: "ERR",  tagCls: "border-red-400/30     bg-red-400/10     text-red-400",     msgCls: "text-red-100"  },
  STRM: { tag: "STRM", tagCls: "border-violet-400/30  bg-violet-400/10  text-violet-400",  msgCls: "text-slate-200" },
};

function classifyLog(msg: string): LogTag {
  const m = msg.replace(/^\[[^\]]+\]\s*/, ""); // strip timestamp
  if (m.startsWith("✓") || m.startsWith("🎉")) return "DONE";
  if (m.startsWith("✗") || /error|failed/i.test(m)) return "ERR";
  if (m.includes("…") || /ing\b/.test(m)) return "STRM";
  if (/assembled|loaded|captured|ready|complete/i.test(m)) return "DONE";
  return "INFO";
}

function AgentActivityLog({ entries, isRunning }: { entries: string[]; isRunning: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useState(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); });

  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-cyan-500/15 bg-slate-900/60 shadow-panel">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-cyan-500/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${isRunning ? "animate-pulse bg-cyan-400" : "bg-emerald-400"}`}
            style={{ boxShadow: isRunning ? "0 0 10px rgba(6,182,212,0.95)" : "0 0 10px rgba(52,211,153,0.80)" }}
          />
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-200">Agent Activity</h2>
        </div>
        <span className="rounded-full border border-slate-600/60 bg-slate-800/60 px-2.5 py-1 text-xs tabular-nums text-slate-300">
          {entries.length} events
        </span>
      </header>

      <div className="max-h-64 overflow-y-auto overscroll-contain p-3 lg:max-h-80">
        <ul className="space-y-1.5">
          {entries.map((line, i) => {
            const tag = classifyLog(line);
            const cfg = LOG_LEVELS[tag];
            // Extract HH:MM:SS from "[H:MM:SS AM]" prefix
            const timeMatch = line.match(/\[(\d+:\d+:\d+(?:\s*[AP]M)?)\]/i);
            const time = timeMatch ? timeMatch[1] : "";
            const message = line.replace(/^\[[^\]]+\]\s*/, "");
            return (
              <li
                key={i}
                className="flex items-start gap-2.5 rounded-xl border border-slate-700/50 bg-slate-900/70 px-3 py-2.5"
              >
                <span className={`mt-px inline-flex flex-shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-widest ${cfg.tagCls}`}>
                  {cfg.tag}
                </span>
                <span className={`flex-1 text-xs leading-relaxed font-mono ${cfg.msgCls}`}>{message}</span>
                <span className="flex-shrink-0 text-[11px] tabular-nums text-slate-600">{time}</span>
              </li>
            );
          })}
          {isRunning && (
            <li className="flex items-center gap-2.5 rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-2.5">
              <span className="inline-flex flex-shrink-0 items-center rounded-md border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-violet-400">
                STRM
              </span>
              <span className="text-xs font-mono text-slate-400">Processing<span className="animate-pulse">…</span></span>
            </li>
          )}
        </ul>
        <div ref={endRef} />
      </div>
    </section>
  );
}

// ─── Audit Panel ─────────────────────────────────────────────────────────────

type ConceptDuplicate = {
  type: "example" | "argument" | "concept" | "story" | "illustration" | "passage";
  title: string;
  description: string;
  severity: "minor" | "major";
  locations: Array<{ location: string; excerpt: string }>;
  recommendation: string;
};

type SimilarPair = {
  locationA: string;
  locationB: string;
  similarity: number;
  excerptA: string;
  excerptB: string;
};

type RepetitionEntry = {
  phrase: string;
  count: number;
  occurrences: Array<{ chapterNumber: number; sectionNumber: number | null; location: string; context: string }>;
  reason: string | null;
  alternatives: string[];
};

type OverusedWord = {
  word: string;
  count: number;
  frequency: string;
  alternatives: string[];
};

type AuditReport = {
  conceptDuplicates: ConceptDuplicate[];
  similarPairs: SimilarPair[];
  repetitions: RepetitionEntry[];
  overusedWords: OverusedWord[];
  totalConceptDuplicates: number;
  totalSimilarPairs: number;
  totalRepetitionPhrases: number;
  totalOverusedWords: number;
};

const TYPE_LABELS: Record<ConceptDuplicate["type"], string> = {
  example: "Example",
  argument: "Argument",
  concept: "Concept",
  story: "Story",
  illustration: "Illustration",
  passage: "Passage",
};

function AuditPanel({
  report,
  onApplyToManuscript,
  applyingAudit,
}: {
  report: AuditReport;
  onApplyToManuscript?: (appliedKeys: string[]) => void;
  applyingAudit?: boolean;
}) {
  const [openConceptKey, setOpenConceptKey] = useState<string | null>(null);
  const [openPhraseKey, setOpenPhraseKey] = useState<string | null>(null);
  const [showPhrases, setShowPhrases] = useState(false);
  const [showPairs, setShowPairs] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const applyItem = (key: string) => setApplied(s => new Set([...s, key]));
  const applyAll = () => {
    const allKeys = [
      ...report.conceptDuplicates.map((_, i) => `c-${i}`),
      ...report.similarPairs.map((_, i) => `p-${i}`),
      ...report.repetitions.map((_, i) => `r-${i}`),
      ...report.overusedWords.map((_, i) => `w-${i}`),
    ].filter(k => !dismissed.has(k));
    setApplied(s => new Set([...s, ...allKeys]));
  };
  const dismissItem = (key: string) => {
    setDismissed(s => new Set([...s, key]));
    setApplied(s => { const n = new Set(s); n.delete(key); return n; });
    setOpenConceptKey(k => k === key ? null : k);
    setOpenPhraseKey(k => k === key ? null : k);
  };

  const activeConcepts = report.conceptDuplicates.map((item, i) => ({ item, k: `c-${i}` })).filter(e => !dismissed.has(e.k));
  const activePairs = report.similarPairs.map((item, i) => ({ item, k: `p-${i}` })).filter(e => !dismissed.has(e.k));
  const activeRepetitions = report.repetitions.map((item, i) => ({ item, k: `r-${i}` })).filter(e => !dismissed.has(e.k));
  const activeWords = report.overusedWords.map((item, i) => ({ item, k: `w-${i}` })).filter(e => !dismissed.has(e.k));

  const totalIssues = activeConcepts.length + activePairs.length + activeRepetitions.length + activeWords.length;

  if (totalIssues === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/6 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-300">No significant duplication found.</p>
        <p className="text-xs text-slate-400 mt-1">The manuscript has strong conceptual variety throughout.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Summary badges */}
      <div className="flex flex-wrap items-center gap-2">
        {activeConcepts.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-400/8 px-3 py-1.5 text-xs font-semibold text-red-300">
            <span className="text-sm font-bold tabular-nums">{activeConcepts.length}</span>
            concept duplicate{activeConcepts.length !== 1 ? "s" : ""}
          </span>
        )}
        {activePairs.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/30 bg-orange-400/8 px-3 py-1.5 text-xs font-semibold text-orange-300">
            <span className="text-sm font-bold tabular-nums">{activePairs.length}</span>
            similar section{activePairs.length !== 1 ? "s" : ""}
          </span>
        )}
        {activeRepetitions.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/8 px-3 py-1.5 text-xs font-semibold text-amber-300">
            <span className="text-sm font-bold tabular-nums">{activeRepetitions.length}</span>
            repeated phrase{activeRepetitions.length !== 1 ? "s" : ""}
          </span>
        )}
        {activeWords.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-500/30 bg-slate-700/40 px-3 py-1.5 text-xs font-semibold text-slate-300">
            <span className="text-sm font-bold tabular-nums">{activeWords.length}</span>
            overused word{activeWords.length !== 1 ? "s" : ""}
          </span>
        )}
        {applied.size < totalIssues && (
          <button type="button" onClick={applyAll}
            className="ml-auto min-h-[36px] px-4 rounded-lg text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:bg-emerald-500/25">
            ✓ Apply All
          </button>
        )}
        {applied.size > 0 && onApplyToManuscript && (
          <button
            type="button"
            onClick={() => onApplyToManuscript(Array.from(applied))}
            disabled={applyingAudit}
            className="min-h-[36px] px-4 rounded-lg text-[11px] font-semibold bg-violet-500/20 border border-violet-500/40 text-violet-200 active:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applyingAudit
              ? "Rewriting chapters…"
              : `Rewrite Manuscript (${applied.size} fix${applied.size !== 1 ? "es" : ""})`}
          </button>
        )}
      </div>

      {/* ── Concept duplicates (primary, most important) ───────────────────── */}
      {activeConcepts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest text-red-400/80">Concept Duplicates</p>
          {activeConcepts.map(({ item: dup, k }) => (
            <div key={k} className={`rounded-xl border overflow-hidden ${dup.severity === "major" ? "border-red-500/35 bg-red-500/5" : "border-orange-400/25 bg-orange-400/4"}`}>
              <button
                type="button"
                onClick={() => setOpenConceptKey(openConceptKey === k ? null : k)}
                className="w-full min-h-[52px] flex items-start justify-between gap-3 px-4 py-3 text-left"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md ${dup.severity === "major" ? "bg-red-500/20 text-red-300" : "bg-orange-400/15 text-orange-300"}`}>
                      {dup.severity === "major" ? "Major" : "Minor"} · {TYPE_LABELS[dup.type] ?? dup.type}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums">{dup.locations.length} location{dup.locations.length !== 1 ? "s" : ""}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-100 leading-snug">{dup.title}</p>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  className={`flex-shrink-0 h-4 w-4 mt-1 text-slate-500 transition-transform ${openConceptKey === k ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {openConceptKey === k && (
                <div className="border-t border-slate-700/40 px-4 pb-4 pt-3 space-y-3">
                  <p className="text-xs text-slate-300 leading-relaxed">{dup.description}</p>

                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Where it appears</p>
                    <div className="space-y-2">
                      {dup.locations.map((loc, li) => (
                        <div key={li} className="rounded-lg border border-slate-700/50 bg-slate-950/50 px-3 py-2.5">
                          <p className="text-xs font-semibold text-slate-300 mb-1">{loc.location}</p>
                          {loc.excerpt && (
                            <p className="text-xs text-slate-500 italic leading-relaxed">&ldquo;{loc.excerpt}&rdquo;</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/70 mb-1">Editorial recommendation</p>
                    <p className="text-xs text-emerald-200 leading-relaxed">{dup.recommendation}</p>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    {applied.has(k) ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        Applied
                      </span>
                    ) : (
                      <>
                        <button type="button" onClick={() => applyItem(k)}
                          className="min-h-[36px] px-3 rounded-lg text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:bg-emerald-500/25">
                          ✓ Apply
                        </button>
                        <button type="button" onClick={() => dismissItem(k)}
                          className="min-h-[36px] px-3 rounded-lg text-[11px] font-semibold bg-slate-700/40 border border-slate-600/40 text-slate-400 active:bg-slate-700/60">
                          Dismiss
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Algorithmically similar pairs ─────────────────────────────────── */}
      {activePairs.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowPairs((v) => !v)}
            className="flex items-center gap-2 min-h-[44px] w-full text-left"
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-orange-400/80">
              Similar Sections ({activePairs.length})
            </p>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              className={`h-3.5 w-3.5 text-slate-500 transition-transform ${showPairs ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[10px] text-slate-500">TF-IDF content overlap detection</span>
          </button>
          {showPairs && (
            <div className="space-y-2">
              {activePairs.map(({ item: pair, k }) => (
                <div key={k} className="rounded-xl border border-slate-700/50 bg-slate-900/60 px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-xs text-slate-300 font-semibold flex-wrap">
                      <span>{pair.locationA}</span>
                      <span className="text-slate-600">↔</span>
                      <span>{pair.locationB}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-md ${pair.similarity >= 0.5 ? "bg-red-500/20 text-red-300" : "bg-orange-400/15 text-orange-300"}`}>
                        {Math.round(pair.similarity * 100)}% overlap
                      </span>
                      {applied.has(k) ? (
                        <span className="text-[11px] font-semibold text-emerald-400">✓ Applied</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => applyItem(k)}
                            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:bg-emerald-500/25">
                            ✓
                          </button>
                          <button type="button" onClick={() => dismissItem(k)}
                            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[11px] font-semibold bg-slate-700/40 border border-slate-600/40 text-slate-400 active:bg-slate-700/60">
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <p className="text-[11px] text-slate-500 italic leading-relaxed border-l-2 border-slate-700 pl-2">{pair.excerptA}</p>
                    <p className="text-[11px] text-slate-500 italic leading-relaxed border-l-2 border-slate-700 pl-2">{pair.excerptB}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Repeated phrases ──────────────────────────────────────────────── */}
      {activeRepetitions.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowPhrases((v) => !v)}
            className="flex items-center gap-2 min-h-[44px] w-full text-left"
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400/80">
              Repeated Phrases ({activeRepetitions.length})
            </p>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              className={`h-3.5 w-3.5 text-slate-500 transition-transform ${showPhrases ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showPhrases && (
            <div className="space-y-2">
              {activeRepetitions.map(({ item: r, k }) => (
                <div key={k} className="rounded-xl border border-slate-700/60 bg-slate-900/70 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenPhraseKey(openPhraseKey === k ? null : k)}
                    className="w-full min-h-[48px] flex items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <span className="text-sm font-mono text-amber-200 font-medium break-all">&ldquo;{r.phrase}&rdquo;</span>
                    <span className="flex-shrink-0 flex items-center gap-2">
                      <span className="text-xs text-slate-400 tabular-nums">{r.count}×</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                        className={`h-4 w-4 text-slate-500 transition-transform ${openPhraseKey === k ? "rotate-180" : ""}`}
                      >
                        <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </button>
                  {openPhraseKey === k && (
                    <div className="border-t border-slate-700/50 px-4 pb-4 pt-3 space-y-3">
                      <ul className="space-y-1.5">
                        {r.occurrences.map((occ, oi) => (
                          <li key={oi} className="text-xs">
                            <span className="font-semibold text-slate-300">{occ.location}</span>
                            {occ.context && <span className="block mt-0.5 text-slate-500 italic leading-snug">&ldquo;…{occ.context}…&rdquo;</span>}
                          </li>
                        ))}
                      </ul>
                      {r.reason && <p className="text-xs text-slate-300 leading-relaxed">{r.reason}</p>}
                      {r.alternatives.length > 0 && (
                        <ul className="space-y-1">
                          {r.alternatives.map((alt, ai) => (
                            <li key={ai} className="flex items-start gap-2 text-xs text-emerald-300">
                              <span className="mt-0.5 text-emerald-500 flex-shrink-0">→</span>
                              <span>{alt}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        {applied.has(k) ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Applied
                          </span>
                        ) : (
                          <>
                            <button type="button" onClick={() => applyItem(k)}
                              className="min-h-[36px] px-3 rounded-lg text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:bg-emerald-500/25">
                              ✓ Apply
                            </button>
                            <button type="button" onClick={() => dismissItem(k)}
                              className="min-h-[36px] px-3 rounded-lg text-[11px] font-semibold bg-slate-700/40 border border-slate-600/40 text-slate-400 active:bg-slate-700/60">
                              Dismiss
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Overused words ────────────────────────────────────────────────── */}
      {activeWords.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowWords((v) => !v)}
            className="flex items-center gap-2 min-h-[44px] w-full text-left"
          >
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Overused Words ({activeWords.length})
            </p>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              className={`h-3.5 w-3.5 text-slate-500 transition-transform ${showWords ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showWords && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {activeWords.map(({ item: w, k }) => (
                <div key={k} className="rounded-xl border border-slate-700/50 bg-slate-900/60 px-3 py-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-mono font-semibold text-slate-300">{w.word}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] text-slate-500 tabular-nums">{w.count}× · {w.frequency}</span>
                      {applied.has(k) ? (
                        <span className="text-[11px] font-semibold text-emerald-400">✓</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => applyItem(k)}
                            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:bg-emerald-500/25">
                            ✓
                          </button>
                          <button type="button" onClick={() => dismissItem(k)}
                            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-[11px] font-semibold bg-slate-700/40 border border-slate-600/40 text-slate-400 active:bg-slate-700/60">
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {w.alternatives.length > 0 && (
                    <p className="text-xs text-slate-400">Try: <span className="text-emerald-300">{w.alternatives.join(" · ")}</span></p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read transcript file"));
    reader.readAsText(file);
  });
}

const JOB_STORAGE_KEY = "nexus_ebook_current_job"; // stores jobId (for IndexedDB)
const JOB_STATE_KEY = "nexus_ebook_job_state";    // stores full state as JSON (primary)

export function EbookPipeline({
  ebookManifest,
  onManifestReady,
  onPipelineSnapshotChange,
  onJobStateChange,
  onSaveProject,
}: {
  ebookManifest?: EbookManifest | null;
  onManifestReady?: (manifest: EbookManifest) => void;
  onPipelineSnapshotChange?: (snapshot: EbookPipelineSnapshot | null) => void;
  onJobStateChange?: (jobState: EbookJobState | null) => void;
  /** Called when the user clicks Save inside the pipeline. Receives the chosen project name. */
  onSaveProject?: (name: string) => void;
} = {}) {
  const [audioFiles, setAudioFiles] = useState<(File | null)[]>([null, null, null, null, null, null, null, null, null, null]);
  const [transcriptFiles, setTranscriptFiles] = useState<(File | null)[]>([null, null, null, null, null, null, null, null, null, null]);
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [authorInstructions, setAuthorInstructions] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [oneChapterPerUpload, setOneChapterPerUpload] = useState(false);
  // Proposal 2: single-call chapter writer — set true to try, false to revert to per-section
  const [useChapterWriter, setUseChapterWriter] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState({ total: 0, completed: 0 });
  const [chapters, setChapters] = useState<ChapterDraft[]>([]);
  const [exportUrls, setExportUrls] = useState<{ pdfUrl?: string; epubUrl?: string; docxUrl?: string } | null>(null);
  const [completedManifest, setCompletedManifest] = useState<EbookManifest | null>(null);
  const [reviewContext, setReviewContext] = useState<{ contentMap: ContentMap; frontMatter: FrontBackMatter } | null>(null);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [auditRunning, setAuditRunning] = useState(false);
  const [applyingAudit, setApplyingAudit] = useState(false);
  const [exportingBook, setExportingBook] = useState(false);
  const [regeneratingBackMatter, setRegeneratingBackMatter] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [printSpec, setPrintSpec] = useState<PrintSpecType>({
    trimSize: "6x9",
    runningHeaders: true,
    folioStyle: "center",
    frontMatterNumbering: "arabic",
    sectionOrnament: "rule",
    bodyTextAlign: "template",
    bodyFontFamily: "template",
    fontSizeScale: 1.0,
  });
  const [error, setError] = useState<string | null>(null);
  const [signalFilterState, setSignalFilterState] = useState<SignalFilterState>("idle");
  const [signalFilterDetail, setSignalFilterDetail] = useState<string | null>(null);
  const [totalWords, setTotalWords] = useState(0);
  // Save bar state
  const [showSaveBar, setShowSaveBar] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedConfirm, setSavedConfirm] = useState(false);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("manuscript");
  const [sectionAssignments, setSectionAssignments] = useState<SectionAssignment[]>([]);
  const [sourceTranscripts, setSourceTranscripts] = useState<Array<{ label: string; text: string }>>([]);
  const [audioSourceStatuses, setAudioSourceStatuses] = useState<Array<"idle" | "transcribing" | "complete" | "error" | "regenerating">>(["idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle"]);
  const sourceMapImportRef = useRef<HTMLInputElement | null>(null);
  const jobIdRef = useRef<string>(newJobId());
  // Mirror of log in a ref so runPipeline (async) can read the current value for checkpoints
  const logRef = useRef<string[]>([]);
  // Full saved job (loaded on mount) — enables resume-from-failure
  const savedJobRef = useRef<EbookJobState | null>(null);
  // Prevent double-triggering the auto-download across re-renders
  const autoDownloadedRef = useRef(false);
  // Track the ebookManifest prop at mount time so the restore effect can detect when an
  // externally-edited manifest was already provided and must NOT be overwritten by the
  // job-state reconstruction (which only knows about the original pipeline output).
  const ebookManifestAtMountRef = useRef<EbookManifest | null | undefined>(ebookManifest);

  const addLog = useCallback((msg: string) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logRef.current = [...logRef.current.slice(-80), entry];
    setLog([...logRef.current]);
  }, []);

  const recalculateManifestTotal = useCallback((manifest: EbookManifest): EbookManifest => {
    const frontMatterWords = countWords(manifest.frontMatter.preface ?? "")
      + countWords(manifest.frontMatter.introduction ?? "")
      + countWords(manifest.frontMatter.conclusion ?? "")
      + countWords(manifest.frontMatter.aboutAuthor ?? "")
      + countWords((manifest.frontMatter.resourcesList ?? []).join(" "));

    const chapterWords = manifest.chapters.reduce((sum, chapter) => {
      const chapterText = [
        chapter.intro ?? "",
        chapter.forwardQuestion ?? "",
        ...(chapter.keyTakeaways ?? []),
        ...(chapter.reflectionQuestions ?? []),
      ].join(" ");
      const sectionWords = chapter.sections.reduce((sectionSum, section) => sectionSum + countWords(section.body ?? ""), 0);
      return sum + sectionWords + countWords(chapterText);
    }, 0);

    return {
      ...manifest,
      totalWordCount: frontMatterWords + chapterWords,
    };
  }, []);

  const syncCompletedManifest = useCallback((next: EbookManifest) => {
    const normalized = recalculateManifestTotal(next);
    setCompletedManifest(normalized);
    setChapters(normalized.chapters);
    setTotalWords(normalized.totalWordCount);
    setExportUrls(null);
    onManifestReady?.(normalized);
  }, [onManifestReady, recalculateManifestTotal]);

  const persistSourceMapState = useCallback(async (
    assignments: SectionAssignment[],
    transcripts?: Array<{ label: string; text: string }>,
  ) => {
    const nextTranscripts = transcripts ?? sourceTranscripts;
    const base = (() => {
      try {
        const raw = localStorage.getItem(JOB_STATE_KEY);
        if (!raw) return savedJobRef.current;
        return JSON.parse(raw) as EbookJobState;
      } catch {
        return savedJobRef.current;
      }
    })();

    if (!base) return;
    const updated: EbookJobState = {
      ...base,
      sectionAssignments: assignments,
      transcripts: nextTranscripts,
      updatedAt: new Date().toISOString(),
    };
    const persistableUpdated = sanitizeJobStateForPersistence(updated);
    savedJobRef.current = persistableUpdated;
    onJobStateChange?.(persistableUpdated);
    try { 
      localStorage.setItem(JOB_STATE_KEY, JSON.stringify(persistableUpdated)); 
    } catch (err) {
      addLog(`⚠ localStorage save failed: ${err instanceof Error ? err.message : 'quota exceeded'}`);
    }
    try { 
      await saveEbookJob(persistableUpdated); 
    } catch (err) {
      addLog(`⚠ IndexedDB save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }, [onJobStateChange, sourceTranscripts]);

  const downloadSourceMap = useCallback(() => {
    if (sectionAssignments.length === 0) {
      addLog("⚠ Source Map export skipped — no section assignments available");
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      jobId: jobIdRef.current,
      sectionAssignments,
      transcripts: sourceTranscripts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `source-map-${jobIdRef.current}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addLog(`✓ Source Map exported — ${sectionAssignments.length} section assignments`);
  }, [addLog, sectionAssignments, sourceTranscripts]);

  const handleSourceMapUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        sectionAssignments?: unknown;
        assignments?: unknown;
        transcripts?: unknown;
      };

      const assignmentCandidate = parsed.sectionAssignments ?? parsed.assignments ?? [];
      const assignmentsParsed = SectionAssignmentSchema.array().safeParse(assignmentCandidate);
      if (!assignmentsParsed.success) {
        throw new Error("Invalid Source Map file: assignment payload is malformed.");
      }

      const transcriptEntries = Array.isArray(parsed.transcripts)
        ? parsed.transcripts
          .filter((entry): entry is { label?: unknown; text?: unknown } => Boolean(entry && typeof entry === "object"))
          .map((entry) => ({
            label: typeof entry.label === "string" ? entry.label : "",
            text: typeof entry.text === "string" ? entry.text : "",
          }))
          .filter((entry) => entry.text.length > 0)
        : undefined;

      setSectionAssignments(assignmentsParsed.data);
      if (transcriptEntries && transcriptEntries.length > 0) {
        setSourceTranscripts(transcriptEntries);
      }
      await persistSourceMapState(assignmentsParsed.data, transcriptEntries);
      setReviewTab("source-map");
      addLog(`✓ Source Map imported — ${assignmentsParsed.data.length} section assignments`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to import Source Map";
      setError(message);
      addLog(`✗ Source Map import failed: ${message}`);
    } finally {
      event.target.value = "";
    }
  }, [addLog, persistSourceMapState]);

  useEffect(() => {
  if (!ebookManifest && !completedManifest) {
    onPipelineSnapshotChange?.(null);
    return;
  }
  const manifest = completedManifest ?? ebookManifest ?? null;
  const snapshot: EbookPipelineSnapshot | null = manifest ? {
    stage,
    progress,
    totalWords,
    reviewReady: Boolean(completedManifest && reviewContext),
    qualityReport,
    error,
    bookTitle: manifest.bookTitle ?? null,
    chapterCount: manifest.chapters.length,
    frontMatterSections: [
      manifest.frontMatter.preface,
      manifest.frontMatter.introduction,
      manifest.frontMatter.conclusion,
    ].filter(Boolean).length,
  } : null;
  onPipelineSnapshotChange?.(snapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ebookManifest, completedManifest, stage, progress.total, progress.completed, totalWords, reviewContext, qualityReport, error, onPipelineSnapshotChange]);

  useEffect(() => {
  if (!ebookManifest) return;
  const normalized = recalculateManifestTotal(ebookManifest);
  setCompletedManifest(normalized);
  setChapters(normalized.chapters);
  setTotalWords(normalized.totalWordCount);
  setExportUrls(null);
  setQualityReport(null);
  setError(null);
  setStage("complete");
  setReviewTab((prev) => (prev === "source-map" ? "source-map" : "manuscript"));
  // Build a minimal reviewContext so the export UI is available even without a full job state
  setReviewContext({
    contentMap: {
      totalEstimatedWords: normalized.totalWordCount,
      overarchingThemes: [],
      teachingArc: "",
      coreThesis: "",
      targetAudience: "",
      uniqueVocabulary: [],
      toneMap: "",
      segments: [],
      allQuotes: normalized.allQuotes ?? [],
    },
    frontMatter: normalized.frontMatter,
  });
  }, [ebookManifest, recalculateManifestTotal]);

  const updateCompletedManifest = useCallback((updater: (current: EbookManifest) => EbookManifest) => {
    setCompletedManifest((current) => {
      if (!current) return current;
      const next = recalculateManifestTotal(updater(current));
      setChapters(next.chapters);
      setTotalWords(next.totalWordCount);
      setExportUrls(null);
      setQualityReport(null);
      onManifestReady?.(next);
      return next;
    });
  }, [onManifestReady, recalculateManifestTotal]);

  const exportFinalBook = useCallback(async () => {
    if (!completedManifest || !reviewContext) return;
    setExportingBook(true);
    setError(null);
    try {
      setStage("exporting");
      addLog("Applying final harmonization pass…");
      const exportManifest = recalculateManifestTotal(harmonizeBookManifest(completedManifest));
      syncCompletedManifest(exportManifest);
      addLog("Running export quality gate…");
      const report = await postJson<QualityReport>("/api/ebook/quality-check", {
        chapters: exportManifest.chapters,
        contentMap: reviewContext.contentMap,
        frontMatter: exportManifest.frontMatter,
      });
      setQualityReport(report);
      if (report.pass) {
        addLog(`✓ Quality score: ${report.score}/100`);
      } else {
        const warnings = report.issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 3);
        addLog(`⚠ Quality advisory (${report.score}/100): ${warnings.join(" | ") || "some fidelity issues detected — exporting anyway"}`);
      }

      addLog("Generating PDF, EPUB, and Word doc…");
      const urls = await postJson<{ pdfUrl?: string; epubUrl?: string; docxUrl?: string }>(
        "/api/ebook/export",
        {
          manifest: exportManifest,
          formats: { pdf: true, epub: true, docx: true },
          template: exportManifest.selectedTemplate ?? "devotional",
          printSpec,
        }
      );
      setExportUrls(urls);
      addLog(`✓ PDF: ${urls.pdfUrl ? "yes" : "no"} | EPUB: ${urls.epubUrl ? "yes" : "no"} | DOCX: ${urls.docxUrl ? "yes" : "no"}`);
      addLog(`🎉 Ebook complete — ${exportManifest.totalWordCount.toLocaleString()} words across ${exportManifest.chapters.length} chapters`);
    } catch (err) {
      const msg = err instanceof Error && err.message.trim() ? err.message : "Export failed";
      setError(msg);
      addLog(`✗ Error: ${msg}`);
      setStage("complete");
    } finally {
      setExportingBook(false);
      setStage("complete");
    }
  }, [addLog, completedManifest, printSpec, recalculateManifestTotal, reviewContext, syncCompletedManifest]);

  // ── Book audit ────────────────────────────────────────────────────────────
  const runAudit = useCallback(async () => {
    if (!completedManifest) return;
    setAuditRunning(true);
    setAuditReport(null);
    try {
      const report = await postJson<AuditReport>("/api/ebook/audit", { manifest: completedManifest });
      setAuditReport(report);
    } catch (err) {
      addLog(`✗ Audit error: ${err instanceof Error ? err.message : "Audit failed"}`);
    } finally {
      setAuditRunning(false);
    }
  }, [addLog, completedManifest]);

  const regenerateBackMatter = useCallback(async () => {
    if (!completedManifest) return;
    setRegeneratingBackMatter(true);
    try {
      addLog("Regenerating back matter…");
      const backMatter = await postJson<BackMatter>("/api/ebook/backmatter", { manifest: completedManifest });
      updateCompletedManifest((current) => ({ ...current, backMatter }));
      addLog(`✓ Back matter regenerated — ${backMatter.glossary.length} glossary terms, ${backMatter.readingGroupGuide.length} chapter guides, ${backMatter.scriptureIndex.length} scripture references`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Back matter regeneration failed";
      addLog(`✗ Back matter regeneration failed: ${message}`);
      setError(message);
    } finally {
      setRegeneratingBackMatter(false);
    }
  }, [addLog, completedManifest, updateCompletedManifest]);

  // ── Apply audit findings to manuscript ───────────────────────────────────
  const applyAuditToManuscript = useCallback(async (appliedKeys: string[]) => {
    if (!completedManifest || !auditReport) return;
    setApplyingAudit(true);
    addLog(`→ Applying ${appliedKeys.length} audit fix(es) — duplicate sections will be deleted, word/phrase fixes applied…`);
    try {
      const result = await postJson<{ chapters: EbookManifest["chapters"] }>(
        "/api/ebook/apply-audit",
        { manifest: completedManifest, report: auditReport, appliedKeys },
      );
      updateCompletedManifest((current) => ({ ...current, chapters: result.chapters }));
      addLog(`✓ Audit applied — ${result.chapters.length} chapter(s) updated (duplicate sections deleted, seams stitched)`);
    } catch (err) {
      addLog(`✗ Apply audit error: ${err instanceof Error ? err.message : "Rewrite failed"}`);
    } finally {
      setApplyingAudit(false);
    }
  }, [addLog, auditReport, completedManifest, updateCompletedManifest]);

  // ── Auto-download PDF when export completes ──────────────────────────────
  useEffect(() => {
    if (!exportUrls?.pdfUrl || autoDownloadedRef.current) return;
    autoDownloadedRef.current = true;
    try {
      const popup = window.open(exportUrls.pdfUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        const a = document.createElement("a");
        a.href = exportUrls.pdfUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch {
      // pop-up blocked — user can still open manually from the download button
    }
  }, [exportUrls]);

  // ── Hydrate from localStorage (primary) or IndexedDB (fallback) on mount ──

  // Sanitize raw localStorage data — applies missing defaults that Zod can't fill
  // because data is loaded with JSON.parse (not Zod.parse), so .default() never runs.
  function normalizeJob(raw: EbookJobState): EbookJobState {
    const fixArrays = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
    const fixStr = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
    const transcripts = fixArrays<Record<string, unknown>>(raw.transcripts as unknown)
      .map((t) => ({
        label: fixStr(t.label),
        text: fixStr(t.text),
      }))
      .filter((t) => t.text);
    const rebuiltMasterTranscript = transcripts
      .map((t) => `[${t.label}]\n${t.text}`)
      .join("\n\n═══════════════════════════════════════\n\n");

    const vdna = raw.voiceDNA as Record<string, unknown> | null;
    const voiceDNA = vdna ? {
      ...vdna,
      signaturePhrases:      fixArrays(vdna.signaturePhrases),
      preferredTerminology:  fixArrays(vdna.preferredTerminology),
      rhetoricalPatterns:    fixArrays(vdna.rhetoricalPatterns),
      avoidWords:            fixArrays(vdna.avoidWords),
      toneProfile:           fixStr(vdna.toneProfile),
      teachingStyle:         fixStr(vdna.teachingStyle),
      sentencePattern:       (vdna.sentencePattern as string) ?? "mixed",
    } : null;

    const cm = raw.contentMap as Record<string, unknown> | null;
    const contentMap = cm ? {
      ...cm,
      overarchingThemes: fixArrays(cm.overarchingThemes),
      teachingArc:       fixStr(cm.teachingArc),
      coreThesis:        fixStr(cm.coreThesis),
      targetAudience:    fixStr(cm.targetAudience),
      uniqueVocabulary:  fixArrays(cm.uniqueVocabulary),
      toneMap:           fixStr(cm.toneMap),
      allQuotes: fixArrays(cm.allQuotes),
      segments: fixArrays<Record<string, unknown>>(cm.segments).map((s) => ({
        ...s,
        keyPoints: fixArrays(s.keyPoints),
        quotes:    fixArrays(s.quotes),
        rawText:   fixStr(s.rawText),
      })),
    } : null;

    const arch = raw.architecture as Record<string, unknown> | null;
    const architecture = arch ? {
      ...arch,
      chapters: fixArrays<Record<string, unknown>>(arch.chapters).map((c) => ({
        ...c,
        quotesInChapter: fixArrays(c.quotesInChapter),
        sections: fixArrays<Record<string, unknown>>(c.sections).map((s) => ({
          ...s,
          keyPoints:       fixArrays(s.keyPoints),
          quotesInSection: fixArrays(s.quotesInSection),
          sourceSegmentIds: fixArrays(s.sourceSegmentIds),
        })),
      })),
    } : null;

    const sections = fixArrays<Record<string, unknown>>(raw.sections as unknown).map((s) => ({
      ...s,
      body:    fixStr(s.body),
      heading: fixStr(s.heading),
    }));

    const sectionAssignments = fixArrays<Record<string, unknown>>(raw.sectionAssignments as unknown).map((a) => {
      const avdna = a.voiceDNA as Record<string, unknown> | null | undefined;
      return {
        ...a,
        keyPoints:          fixArrays(a.keyPoints),
        transcriptExcerpts: fixArrays(a.transcriptExcerpts),
        quotes:             fixArrays(a.quotes),
        voiceDNA: avdna ? {
          ...avdna,
          signaturePhrases:     fixArrays(avdna.signaturePhrases),
          preferredTerminology: fixArrays(avdna.preferredTerminology),
          rhetoricalPatterns:   fixArrays(avdna.rhetoricalPatterns),
          avoidWords:           fixArrays(avdna.avoidWords),
          toneProfile:          fixStr(avdna.toneProfile),
          teachingStyle:        fixStr(avdna.teachingStyle),
          sentencePattern:      (avdna.sentencePattern as string) ?? "mixed",
        } : a.voiceDNA,
      };
    });

    const chapters = fixArrays<Record<string, unknown>>(raw.chapters as unknown).map((c) => ({
      ...c,
      intro:               fixStr(c.intro),
      forwardQuestion:     fixStr(c.forwardQuestion),
      keyTakeaways:        fixArrays(c.keyTakeaways),
      reflectionQuestions: fixArrays(c.reflectionQuestions),
      sections: fixArrays<Record<string, unknown>>(c.sections).map((s) => ({
        ...s,
        body:    fixStr(s.body),
        heading: fixStr(s.heading),
      })),
    }));

    return {
      ...raw,
      audioFileNames: fixArrays(raw.audioFileNames),
      transcripts,
      masterTranscript: fixStr(raw.masterTranscript, rebuiltMasterTranscript),
      filteredTranscript: fixStr((raw as EbookJobState & { filteredTranscript?: unknown }).filteredTranscript),
      voiceDNA,
      contentMap,
      architecture,
      sections,
      sectionAssignments,
      chapters,
    } as EbookJobState;
  }

  useEffect(() => {
    // Try localStorage first — it's synchronous and reliably available in Safari
    const tryLocalStorage = () => {
      try {
        const raw = localStorage.getItem(JOB_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as EbookJobState;
        // Populate savedJobRef immediately so resume button shows even if normalization fails
        savedJobRef.current = parsed;
        return normalizeJob(parsed);
      } catch (err) {
        console.warn("[EbookPipeline] Failed to load saved job from localStorage:", err);
        return null;
      }
    };

    const restore = (job: EbookJobState) => {
      savedJobRef.current = job;
      onJobStateChange?.(job);
      const filterInfo = parseSignalFilterLog(job.errorLog ?? []);
      setSignalFilterState(filterInfo.state);
      setSignalFilterDetail(filterInfo.detail);
      const hasRecoverableState = Boolean(
        (job.masterTranscript && job.masterTranscript.length > 0) ||
        (job.transcripts?.length ?? 0) > 0 ||
        job.voiceDNA ||
        job.contentMap ||
        job.architecture ||
        (job.sectionAssignments?.length ?? 0) > 0 ||
        (job.sections?.length ?? 0) > 0 ||
        (job.chapters?.length ?? 0) > 0 ||
        job.frontMatter ||
        (job.progress?.completed ?? 0) > 0 ||
        job.status === "complete" ||
        job.status === "failed"
      );
      if (!hasRecoverableState) return;
      jobIdRef.current = job.jobId;
      setStage(job.status as PipelineStage);
      logRef.current = job.errorLog ?? [];
      setLog(job.errorLog ?? []);
      setProgress(job.progress ?? { total: 0, completed: 0 });
      setChapters(job.chapters ?? []);
      setSectionAssignments(job.sectionAssignments ?? []);
      setSourceTranscripts(job.transcripts ?? []);
      // Restore error so the Resume button is visible after refresh
      if (job.status === "failed") {
        const lastErr = (job.errorLog ?? []).findLast?.((e) => e.includes("✗"));
        setError(lastErr ? lastErr.replace(/.*✗ Error:\s*/, "") || "Pipeline failed" : "Pipeline failed — tap Resume to retry");
      }
      if (job.exportUrls?.pdfUrl || job.exportUrls?.epubUrl || job.exportUrls?.docxUrl) {
        setExportUrls({
          pdfUrl: job.exportUrls.pdfUrl || undefined,
          epubUrl: job.exportUrls.epubUrl || undefined,
          docxUrl: job.exportUrls.docxUrl || undefined,
        });
      }
      if (job.status === "complete" && job.architecture && job.frontMatter) {
        // Build a contentMap stub when the saved job state is missing one (older saves)
        const contentMap: ContentMap = job.contentMap ?? {
          totalEstimatedWords: (job.chapters ?? []).reduce((a, c) => a + (c.totalWordCount ?? 0), 0),
          overarchingThemes: [],
          teachingArc: "",
          coreThesis: "",
          targetAudience: "",
          uniqueVocabulary: [],
          toneMap: "",
          segments: [],
          allQuotes: [],
        };
        const manifest: EbookManifest = {
          jobId: job.jobId,
          bookTitle: job.architecture.bookTitle,
          subtitle: job.architecture.subtitle,
          authorName: job.architecture.authorName,
          frontMatter: job.frontMatter,
          chapters: job.chapters ?? [],
          totalWordCount: (job.chapters ?? []).reduce((sum, chapter) => sum + (chapter.totalWordCount ?? 0), 0),
          allQuotes: contentMap.allQuotes ?? [],
          generatedAt: new Date().toISOString(),
          backMatter: job.backMatter ?? null,
        };
        setReviewContext({ contentMap, frontMatter: job.frontMatter });
        // Only reconstruct the manifest from job state when no external manifest was
        // provided at mount.  If ebookManifest prop is set it may contain assistant
        // edits made after the pipeline ran — those must not be overwritten.
        if (!ebookManifestAtMountRef.current) {
          syncCompletedManifest(manifest);
        }
      }
      const words = (job.chapters ?? []).reduce((a, c) => a + (c.totalWordCount ?? 0), 0);
      if (words > 0) setTotalWords(words);
    };

    const fromLocal = tryLocalStorage();
    if (fromLocal) { restore(fromLocal); return; }

    // IndexedDB fallback
    const savedId = localStorage.getItem(JOB_STORAGE_KEY);
    if (!savedId) return;
    void getEbookJob(savedId).then((job) => {
      if (!job) return;
      // Populate savedJobRef immediately so resume button shows even if normalization fails
      savedJobRef.current = job;
      try {
        restore(normalizeJob(job));
      } catch (err) {
        console.warn("[EbookPipeline] Failed to normalize saved job from IndexedDB:", err);
        // Still populate savedJobRef so resume button shows
        setError("Load failed — tap Resume to retry");
      }
    }).catch((err) => {
      console.warn("[EbookPipeline] Failed to load job from IndexedDB:", err);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAudio = useCallback((i: number, f: File | null) => {
    setAudioFiles((prev) => { const next = [...prev]; next[i] = f; return next; });
  }, []);

  const setTranscript = useCallback((i: number, f: File | null) => {
    setTranscriptFiles((prev) => { const next = [...prev]; next[i] = f; return next; });
  }, []);

  // A slot is active if it has audio OR a pre-existing transcript
  const activeSlotCount = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
    (i) => audioFiles[i] || transcriptFiles[i]
  ).length;
  const canStart = activeSlotCount >= 1 && stage === "idle";

  // ── Audio Source Management Handlers ──────────────────────────────────────

  const handleRegenerateSource = useCallback(async (slot: number, newTranscriptFile?: File) => {
    const label = `Slot-${slot + 1}`;
    const sourceId = `audio-${slot + 1}` as `audio-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
    
    try {
      setAudioSourceStatuses((prev) => {
        const next = [...prev];
        next[slot] = "regenerating";
        return next;
      });
      addLog(`Regenerating ${label} with chapter restructuring...`);

      // Step 1: Get the transcript (either from new file or existing)
      let transcript: string;
      if (newTranscriptFile) {
        addLog(`Reading new transcript file for ${label}...`);
        transcript = await readTextFile(newTranscriptFile);
        addLog(`✓ New transcript loaded — ${countWords(transcript).toLocaleString()} words`);
        
        // Update the transcript in state
        setSourceTranscripts((prev) => {
          const next = [...prev];
          const existing = next.find((t) => t.label === label);
          if (existing) {
            existing.text = transcript;
          } else {
            next.push({ label, text: transcript });
          }
          return next;
        });
      } else {
        // Use existing transcript
        const existing = sourceTranscripts.find((t) => t.label === label);
        if (!existing || !existing.text) {
          throw new Error(`No transcript found for ${label}. Upload a transcript file first.`);
        }
        transcript = existing.text;
        addLog(`Using existing transcript — ${countWords(transcript).toLocaleString()} words`);
      }

      // Step 2: Filter the transcript
      addLog(`Filtering ${label} transcript...`);
      type FilterResult = { cleanedTranscript: string; removedSegments: { reason: string; excerpt: string }[]; summary: string };
      const filterRes = await postJson<FilterResult>("/api/ebook/filter-signal", {
        masterTranscript: transcript,
      });
      const cleanedTranscript = filterRes.cleanedTranscript;
      addLog(`✓ ${label} filtered — ${filterRes.removedSegments.length} segments removed`);

      // Step 3: Create content map for this source
      addLog(`Analyzing ${label} content structure...`);
      // Generate voice DNA if not available
      let voiceDNA: VoiceDNA;
      if (reviewContext?.contentMap?.voiceDNA) {
        voiceDNA = reviewContext.contentMap.voiceDNA as VoiceDNA;
      } else {
        addLog(`Extracting voice DNA from ${label}...`);
        voiceDNA = await postJson<VoiceDNA>("/api/ebook/voice-dna", { 
          masterTranscript: cleanedTranscript 
        });
        addLog(`✓ Voice DNA captured`);
      }

      const sourceContentMap = await postJson<ContentMap>("/api/ebook/content-map", {
        masterTranscript: cleanedTranscript,
        voiceDNA,
      });
      addLog(`✓ Content mapped — ${sourceContentMap.segments.length} segments identified`);

      // Step 4: Find affected chapters and determine what needs restructuring
      const affectedChapterNumbers = new Set<number>();
      
      // Check if we have existing sections to regenerate
      if (completedManifest && sectionAssignments.length > 0) {
        for (const assignment of sectionAssignments) {
          const hasThisSource = (assignment.sourceSegmentIds ?? []).some((segId) => {
            return segId.includes(sourceId) || segId.startsWith(`${sourceId}-`);
          });
          if (hasThisSource) {
            affectedChapterNumbers.add(assignment.chapterNumber);
          }
        }
      }

      // If no existing chapters use this source, generate new chapters
      if (affectedChapterNumbers.size === 0) {
        addLog(`No existing chapters found. Generating 1 chapter from ${label}...`);
        
        // Create new architecture from this transcript alone (1 source = 1 chapter)
        const newArchitecture = await postJson<BookArchitecture>("/api/ebook/architect", {
          contentMap: sourceContentMap,
          voiceDNA,
          oneChapterPerUpload: true,
        });
        
        addLog(`✓ Architecture: 1 chapter planned (${newArchitecture.chapters[0]?.title || "Untitled"})`);
        
        // Use only the first chapter (should be exactly 1 when oneChapterPerUpload=true)
        if (newArchitecture.chapters[0]) {
          affectedChapterNumbers.add(newArchitecture.chapters[0].number);
        }
      }

      const affectedChapters = Array.from(affectedChapterNumbers).sort((a, b) => a - b);
      addLog(`Processing ${affectedChapters.length} chapter(s): ${affectedChapters.join(", ")}`);

      // Step 5: For each affected chapter, re-architect with new content
      for (const chapterNum of affectedChapters) {
        addLog(`  Restructuring Chapter ${chapterNum}...`);

        // Get the original chapter from architecture
        const originalChapter = completedManifest?.chapters.find((c) => c.number === chapterNum);

        // Build a hybrid content map: keep other sources, replace this source's segments
        const otherSourceSegments = reviewContext?.contentMap?.segments?.filter(
          (seg) => seg.sourceAudio !== sourceId
        ) ?? [];
        const thisSourceSegments = sourceContentMap.segments.map((seg) => ({
          ...seg,
          sourceAudio: sourceId,
        }));

        const hybridContentMap: ContentMap = {
          totalEstimatedWords: [...otherSourceSegments, ...thisSourceSegments].reduce((sum, seg) => sum + seg.estimatedWordCount, 0),
          overarchingThemes: sourceContentMap.overarchingThemes,
          teachingArc: sourceContentMap.teachingArc,
          coreThesis: sourceContentMap.coreThesis,
          targetAudience: sourceContentMap.targetAudience || "",
          uniqueVocabulary: sourceContentMap.uniqueVocabulary,
          toneMap: sourceContentMap.toneMap,
          segments: [...otherSourceSegments, ...thisSourceSegments],
          allQuotes: [
            ...otherSourceSegments.flatMap((seg) => seg.quotes),
            ...sourceContentMap.allQuotes,
          ],
        };

        // Re-architect just this chapter
        addLog(`  Planning new section structure for Chapter ${chapterNum}...`);
        const chapterArchitecture = await postJson<BookArchitecture>("/api/ebook/architect", {
          contentMap: hybridContentMap,
          voiceDNA,
          oneChapterPerUpload: false,
        });

        // Find the new structure for this chapter
        const newChapterBlueprint = chapterArchitecture.chapters[0]; // Take first chapter from architecture
        if (!newChapterBlueprint) {
          addLog(`  ⚠ Chapter ${chapterNum} architecture failed, skipping...`);
          continue;
        }

        const oldSectionCount = originalChapter?.sections.length ?? 0;
        addLog(`  ✓ Chapter ${chapterNum} restructured: ${newChapterBlueprint.sections.length} sections${oldSectionCount > 0 ? ` (was ${oldSectionCount})` : ""}`);

        // Step 6: Create section assignments for the new structure
        const newSectionAssignments: SectionAssignment[] = [];
        for (const section of newChapterBlueprint.sections) {
          const assignment: SectionAssignment = {
            chapterNumber: chapterNum,
            chapterTitle: newChapterBlueprint.title,
            sectionNumber: section.sectionNumber,
            heading: section.heading,
            transcriptExcerpts: section.sourceSegmentIds.map((segId) => {
              const segment = hybridContentMap.segments.find((s) => s.id === segId);
              return segment?.rawText ?? "";
            }),
            quotes: section.quotesInSection,
            keyPoints: section.keyPoints,
            voiceDNA,
            previousSectionEnding: "",
            nextSectionHeading: newChapterBlueprint.sections[section.sectionNumber]?.heading,
            targetWordCount: section.targetWordCount,
            alreadyCoveredPoints: [],
            alreadyQuotedRefs: [],
            isLastSectionInChapter: section.sectionNumber === newChapterBlueprint.sections.length,
            nextChapterTitle: completedManifest?.chapters[chapterNum]?.title,
            sourceSegmentIds: section.sourceSegmentIds,
            consumedSegmentIds: [],
            conceptOwnershipMap: {},
            forbiddenVerseTexts: [],
            allowedInlineOnly: [],
          };
          newSectionAssignments.push(assignment);
        }

        // Step 7: Write all sections in the new chapter structure
        const newSections: Array<{ sectionNumber: number; heading: string; body: string; quotes: Array<{ id: string; text: string; reference: string; translation: string; type: "scripture" | "quote" | "proverb"; isBlockQuote: boolean }>; wordCount: number }> = [];

        for (const assignment of newSectionAssignments) {
          addLog(`    Writing Section ${assignment.sectionNumber}: ${assignment.heading}...`);
          
          const sectionRes = await postJson<{ body: string; quotes: Array<{ id: string; text: string; reference: string; translation: string; type: "scripture" | "quote" | "proverb"; isBlockQuote: boolean }> }>(
            "/api/ebook/write-section",
            { assignment }
          );

          newSections.push({
            sectionNumber: assignment.sectionNumber,
            heading: assignment.heading,
            body: sectionRes.body,
            quotes: sectionRes.quotes,
            wordCount: countWords(sectionRes.body),
          });

          addLog(`    ✓ Section ${assignment.sectionNumber} — ${countWords(sectionRes.body).toLocaleString()} words`);
        }

        // Step 7b: Polish the chapter (add intro, takeaways, forward question)
        addLog(`  Polishing Chapter ${chapterNum}...`);
        
        const chapterSegmentTexts = newSectionAssignments.flatMap((a) => a.transcriptExcerpts);
        const polishInput = {
          number: chapterNum,
          title: newChapterBlueprint.title,
          sections: newSections.map((s) => ({
            chapterNumber: chapterNum,
            sectionNumber: s.sectionNumber,
            heading: s.heading,
            body: s.body,
            wordCount: s.wordCount,
            status: "complete" as const,
          })),
          chapterSegmentTexts,
          voiceDNA,
          quotesInChapter: newChapterBlueprint.quotesInChapter ?? [],
          chapterPremise: newChapterBlueprint.chapterPremise,
        };

        const polished = await postJson<{
          intro: string;
          epigraph: string;
          forwardQuestion: string;
          keyTakeaways: string[];
          reflectionQuestions: string[];
        }>("/api/ebook/polish", { input: polishInput });

        addLog(`  ✓ Chapter ${chapterNum} polished`);

        // Step 8: Update the manifest with the polished chapter
        if (completedManifest) {
          updateCompletedManifest((current) => {
            const existingChapterIndex = current.chapters.findIndex((c) => c.number === chapterNum);
            const updatedChapter = {
              number: chapterNum,
              title: newChapterBlueprint.title,
              intro: polished.intro,
              epigraph: polished.epigraph,
              sections: newSections,
              forwardQuestion: polished.forwardQuestion,
              keyTakeaways: polished.keyTakeaways,
              reflectionQuestions: polished.reflectionQuestions,
              totalWordCount: newSections.reduce((sum, s) => sum + s.wordCount, 0),
              status: "complete" as const,
            };
            
            if (existingChapterIndex >= 0) {
              // Replace existing chapter
              return {
                ...current,
                chapters: current.chapters.map((chapter) => 
                  chapter.number === chapterNum ? updatedChapter : chapter
                ),
              };
            } else {
              // Add new chapter
              return {
                ...current,
                chapters: [...current.chapters, updatedChapter].sort((a, b) => a.number - b.number),
              };
            }
          });
        }

        addLog(`  ✓ Chapter ${chapterNum} complete with ${newSections.length} sections`);
      }

      setAudioSourceStatuses((prev) => {
        const next = [...prev];
        next[slot] = "complete";
        return next;
      });
      addLog(`✓ ${label} regeneration complete — ${affectedChapters.length} chapter(s) restructured`);
    } catch (err) {
      setAudioSourceStatuses((prev) => {
        const next = [...prev];
        next[slot] = "error";
        return next;
      });
      addLog(`✗ ${label} regeneration failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      throw err;
    }
  }, [addLog, sourceTranscripts, sectionAssignments, completedManifest, reviewContext, updateCompletedManifest]);

  const handleTranscriptEdit = useCallback((slot: number, newTranscript: string) => {
    const label = `Slot-${slot + 1}`;
    setSourceTranscripts((prev) => {
      const next = [...prev];
      const existing = next.find((t) => t.label === label);
      if (existing) {
        existing.text = newTranscript;
      } else {
        next.push({ label, text: newTranscript });
      }
      return next;
    });
    addLog(`✓ ${label} transcript edited manually — ${countWords(newTranscript).toLocaleString()} words`);
  }, [addLog]);

  const handleRemoveSource = useCallback((slot: number) => {
    const label = `Slot-${slot + 1}`;
    setAudioFiles((prev) => {
      const next = [...prev];
      next[slot] = null;
      return next;
    });
    setTranscriptFiles((prev) => {
      const next = [...prev];
      next[slot] = null;
      return next;
    });
    setSourceTranscripts((prev) => prev.filter((t) => t.label !== label));
    setAudioSourceStatuses((prev) => {
      const next = [...prev];
      next[slot] = "idle";
      return next;
    });
    addLog(`✗ ${label} removed from pipeline`);
    addLog(`⚠ Manuscript will need regeneration to reflect source removal.`);
  }, [addLog]);

  // ── Resolve one slot: use pre-existing transcript or call Deepgram ─────────

  async function resolveSlot(
    audioFile: File | null,
    transcriptFile: File | null,
    label: string
  ): Promise<string> {
    // Pre-existing transcript takes priority — skip the API call entirely
    if (transcriptFile) {
      addLog(`Reading transcript file for ${label}…`);
      const text = await readTextFile(transcriptFile);
      addLog(`✓ ${label} transcript loaded — ${countWords(text).toLocaleString()} words`);
      return text;
    }
    // Fall back to Deepgram transcription — send directly from browser to
    // avoid the Next.js / Codespaces proxy 413 body-size limit on large files.
    if (audioFile) {
      addLog(`Transcribing ${label} via Deepgram…`);

      const tokenRes = await fetch("/api/transcribe-token");
      if (!tokenRes.ok) throw new Error(`Could not get Deepgram token (HTTP ${tokenRes.status})`);
      const { apiKey } = await tokenRes.json() as { apiKey: string };

      // Map video containers to their audio MIME equivalent for Deepgram
      const VIDEO_TO_AUDIO: Record<string, string> = {
        "video/mp4": "audio/mp4",
        "video/quicktime": "audio/mp4",
        "video/x-m4v": "audio/mp4",
        "video/webm": "audio/webm",
        "video/ogg": "audio/ogg",
        "video/x-matroska": "audio/webm",
      };
      const rawMime = audioFile.type || "";
      const mimeType = VIDEO_TO_AUDIO[rawMime] ?? (rawMime || "audio/mpeg");

      const params = new URLSearchParams({
        model: "nova-2",
        smart_format: "true",
        punctuate: "true",
        paragraphs: "true",
        language: "en",
      });

      const buffer = await audioFile.arrayBuffer();
      const dgRes = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType },
        body: buffer,
      });

      if (!dgRes.ok) {
        const dgErr = await dgRes.json().catch(() => ({})) as { err_msg?: string };
        throw new Error(`Transcription failed for ${label}: ${dgErr.err_msg || dgRes.statusText || `HTTP ${dgRes.status}`}`);
      }

      type DgResponse = { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
      const data = await dgRes.json() as DgResponse;
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      if (!transcript.trim()) throw new Error(`Deepgram returned an empty transcript for ${label}`);

      addLog(`✓ ${label} transcribed — ${countWords(transcript).toLocaleString()} words`);
      return transcript;
    }
    throw new Error(`${label} has neither an audio file nor a transcript file.`);
  }

  // ── Main pipeline run ─────────────────────────────────────────────────────

  async function runPipeline(resume?: EbookJobState) {
    setStage("transcribing");
    setError(null);
    // Restore existing log when resuming so the user sees full history
    if (!resume) {
      logRef.current = [];
      setLog([]);
      setChapters([]);
      setSignalFilterState("idle");
      setSignalFilterDetail(null);
      setExportUrls(null);
      setCompletedManifest(null);
      setReviewContext(null);
      setQualityReport(null);
      setReviewTab("manuscript");
      setSectionAssignments([]);
      setSourceTranscripts([]);
      setTotalWords(0);
      autoDownloadedRef.current = false;
    }
    const jobId = resume?.jobId ?? jobIdRef.current;
    jobIdRef.current = jobId;
    localStorage.setItem(JOB_STORAGE_KEY, jobId);

    const now = new Date().toISOString();
    const acc: EbookJobState = resume
      ? {
          ...resume,
          status: "transcribing",
          updatedAt: now,
          // Guard against old persisted jobs that may be missing array fields
          chapters: resume.chapters ?? [],
          sections: resume.sections ?? [],
          sectionAssignments: resume.sectionAssignments ?? [],
          transcripts: resume.transcripts ?? [],
          errorLog: resume.errorLog ?? [],
        }
      : {
          jobId,
          status: "transcribing",
          audioFileNames: audioFiles.filter(Boolean).map((f) => f!.name),
          transcripts: [],
          masterTranscript: "",
          voiceDNA: null,
          contentMap: null,
          architecture: null,
          sectionAssignments: [],
          sections: [],
          chapters: [],
          frontMatter: null,
          exportUrls: null,
          currentStage: "transcribing",
          progress: { total: 0, completed: 0 },
          errorLog: [],
          createdAt: now,
          updatedAt: now,
        };
    savedJobRef.current = { ...acc };
    onJobStateChange?.({ ...acc });
    const checkpoint = async (s: PipelineStage) => {
      acc.status = s;
      acc.currentStage = s;
      acc.errorLog = logRef.current;
      acc.updatedAt = new Date().toISOString();
      const persistableAcc = sanitizeJobStateForPersistence({ ...acc });
      savedJobRef.current = { ...persistableAcc };
      onJobStateChange?.({ ...persistableAcc });
      // Primary: localStorage (synchronous, always available)
      try { 
        localStorage.setItem(JOB_STATE_KEY, JSON.stringify(persistableAcc)); 
      } catch (err) {
        addLog(`⚠ localStorage checkpoint failed: ${err instanceof Error ? err.message : 'quota exceeded'}`);
      }
      // Secondary: IndexedDB
      try { 
        await saveEbookJob({ ...persistableAcc }); 
      } catch (err) {
        addLog(`⚠ IndexedDB checkpoint failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    };

    try {
      // ── Stage 1: Transcribe (skip if resuming with existing transcript) ────
      let masterTranscript = acc.masterTranscript;
      if (!masterTranscript) {
        type FilterResult = { cleanedTranscript: string; removedSegments: { reason: string; excerpt: string }[]; summary: string };
        const transcriptResults: { label: string; text: string }[] = [];

        // Reset all statuses to idle before starting
        setAudioSourceStatuses(["idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle", "idle"]);

        setStage("filtering");
        for (let i = 0; i < 10; i++) {
          if (!audioFiles[i] && !transcriptFiles[i]) continue;
          const label = `Slot-${i + 1}`;
          
          // Mark as transcribing
          setAudioSourceStatuses((prev) => {
            const next = [...prev];
            next[i] = "transcribing";
            return next;
          });

          const rawText = await resolveSlot(audioFiles[i], transcriptFiles[i], label);

          // Mark as complete
          setAudioSourceStatuses((prev) => {
            const next = [...prev];
            next[i] = "complete";
            return next;
          });

          // ── Per-slot signal filter — catches opening prayers, closings, altar
          //    calls and announcements specific to each audio/transcript file ──
          let slotText = rawText;
          try {
            addLog(`  Filtering ${label} signal…`);
            const slotFilter = await postJson<FilterResult>("/api/ebook/filter-signal", { masterTranscript: rawText });
            slotText = slotFilter.cleanedTranscript || rawText;
            const rawWords = countWords(rawText);
            const cleanWords = countWords(slotText);
            const trimmed = rawWords - cleanWords;
            if (trimmed > 0) {
              addLog(`  ✓ ${label} filtered — ${trimmed.toLocaleString()} non-teaching words removed (${slotFilter.summary})`);
            } else {
              addLog(`  ✓ ${label} — no non-teaching content found`);
            }
          } catch {
            addLog(`  ⚠ ${label} signal filter skipped — using raw text`);
          }

          transcriptResults.push({ label, text: slotText });
        }
        masterTranscript = transcriptResults
          .map((t) => `[${t.label}]\n${t.text}`)
          .join("\n\n═══════════════════════════════════════\n\n");
        setSourceTranscripts(transcriptResults);
        addLog(`Master transcript assembled — ${countWords(masterTranscript).toLocaleString()} words after per-slot filtering`);

        // ── Stage 1b: Glossary sanitization — zero-cost regex ASR correction ─
        try {
          type SanitizeResult = { sanitizedTranscript: string; replacements: { wrong: string; correct: string; count: number }[] };
          const sanitizeResult = await postJson<SanitizeResult>("/api/ebook/sanitize", { masterTranscript });
          if (sanitizeResult.replacements.length > 0) {
            const fixes = sanitizeResult.replacements.map((r) => `"${r.wrong}" → "${r.correct}" (×${r.count})`).join(", ");
            addLog(`✓ Glossary sanitized — ${sanitizeResult.replacements.length} ASR correction${sanitizeResult.replacements.length !== 1 ? "s" : ""}: ${fixes}`);
            masterTranscript = sanitizeResult.sanitizedTranscript;
          } else {
            addLog("✓ Glossary check — no ASR corrections needed");
          }
        } catch {
          addLog("⚠ Glossary sanitization skipped — proceeding with raw transcript");
        }

        acc.masterTranscript = masterTranscript;
        acc.transcripts = transcriptResults;
        await checkpoint("filtering");
      } else {
        setSourceTranscripts(acc.transcripts ?? []);
        addLog(`↩ Resuming — transcript available (${countWords(masterTranscript).toLocaleString()} words)`);
      }

      // ── Stage 2: Signal Filter — final safety pass on the combined transcript
      //    Catches any non-teaching content that spans a slot boundary or was
      //    missed by the per-slot pass (e.g. a multi-slot altar call finale). ─
      let filteredTranscript = (acc as EbookJobState & { filteredTranscript?: string }).filteredTranscript ?? "";
      if (!filteredTranscript) {
        setStage("filtering");
        addLog("Running final combined signal filter pass…");
        try {
          type FilterResult = { cleanedTranscript: string; removedSegments: { reason: string; excerpt: string }[]; summary: string };
          const filterResult = await postJson<FilterResult>("/api/ebook/filter-signal", { masterTranscript });
          filteredTranscript = filterResult.cleanedTranscript || masterTranscript;
          const removedCount = filterResult.removedSegments.length;
          if (removedCount > 0) {
            addLog(`✓ Final filter — removed ${removedCount} additional block${removedCount !== 1 ? "s" : ""}: ${filterResult.summary}`);
          } else {
            addLog("✓ Final filter pass — no additional non-teaching content found");
          }
          setSignalFilterState("applied");
          setSignalFilterDetail(filterResult.summary || null);
          (acc as EbookJobState & { filteredTranscript: string; filterRemovedCount: number }).filteredTranscript = filteredTranscript;
          (acc as EbookJobState & { filteredTranscript: string; filterRemovedCount: number }).filterRemovedCount = removedCount;
        } catch (filterErr) {
          // Non-fatal: if filtering fails, proceed with the per-slot-filtered transcript
          filteredTranscript = masterTranscript;
          const detail = filterErr instanceof Error ? filterErr.message : "unknown error";
          setSignalFilterState("skipped");
          setSignalFilterDetail(detail);
          addLog(`⚠ Final signal filter unavailable — using per-slot filtered transcript (${detail})`);
        }
        await checkpoint("analyzing");
      } else {
        setSignalFilterState("applied");
        setSignalFilterDetail(null);
        addLog(`↩ Resuming — filtered transcript available (${countWords(filteredTranscript).toLocaleString()} teaching words)`);
      }

      // Use filtered transcript for all downstream steps
      const teachingTranscript = filteredTranscript || masterTranscript;

      // ── Stage 3: Voice DNA ───────────────────────────────────────────
      let voiceDNA = acc.voiceDNA;
      if (!voiceDNA) {
        setStage("analyzing");
        addLog("Extracting Voice DNA…");
        voiceDNA = await postJson<VoiceDNA>("/api/ebook/voice-dna", { masterTranscript: teachingTranscript });
        addLog(`✓ Voice DNA captured — tone: ${voiceDNA.toneProfile}`);
        acc.voiceDNA = voiceDNA;
        await checkpoint("mapping");
      } else {
        addLog(`↩ Resuming — voice DNA available`);
      }

      // ── Stage 4: Content Map ─────────────────────────────────────────────
      let contentMap = acc.contentMap;
      if (!contentMap) {
        setStage("mapping");
        addLog("Mapping content segments…");
        contentMap = await postJson<ContentMap>("/api/ebook/content-map", { masterTranscript: teachingTranscript, voiceDNA });
        addLog(`✓ Content mapped — ${contentMap.segments.length} segments, ${contentMap.allQuotes.length} scriptures/quotes`);
        acc.contentMap = contentMap;
        await checkpoint("architecting");
      } else {
        addLog(`↩ Resuming — content map available (${contentMap.segments.length} segments)`);
      }

      // ── Stage 5: Architect ───────────────────────────────────────────────
      let architecture = acc.architecture;
      if (!architecture) {
        setStage("architecting");
        addLog("Designing chapter structure…");
        architecture = await postJson<BookArchitecture>("/api/ebook/architect", { contentMap, voiceDNA, oneChapterPerUpload });
        const totalSections = architecture.chapters.reduce((a, c) => a + c.sections.length, 0);
        addLog(`✓ Architecture: "${architecture.bookTitle}" — ${architecture.chapters.length} chapters, ${totalSections} sections`);
        acc.architecture = architecture;
      } else {
        const totalSections = architecture.chapters.reduce((a, c) => a + c.sections.length, 0);
        addLog(`↩ Resuming — architecture available (${architecture.chapters.length} chapters, ${totalSections} sections)`);
      }

      // Seed chapters for UI display (always re-seed from architecture)
      const totalSections = architecture.chapters.reduce((a, c) => a + c.sections.length, 0);
      if (acc.chapters.length === 0) {
        const seedChapters: ChapterDraft[] = architecture.chapters.map((c) => ({
          number: c.number,
          title: c.title,
          intro: "",
          sections: c.sections.map((s) => ({
            chapterNumber: c.number,
            sectionNumber: s.sectionNumber,
            heading: s.heading,
            body: "",
            wordCount: 0,
            status: "pending" as const,
          })),
          forwardQuestion: "",
          keyTakeaways: [],
          reflectionQuestions: [],
          totalWordCount: 0,
          status: "pending" as const,
        }));
        setChapters(seedChapters);
        setProgress({ total: totalSections, completed: 0 });
        acc.chapters = seedChapters;
      } else {
        // Restore previously written chapters to UI
        setChapters(acc.chapters);
        setProgress(acc.progress);
      }
      await checkpoint("assigning");

      // ── Stage 5: Assign Segments ─────────────────────────────────────────
      let assignments = acc.sectionAssignments;
      if (assignments.length === 0) {
        setStage("assigning");
        addLog("Assigning transcript segments to sections…");
        const result = await postJson<{ assignments: SectionAssignment[] }>(
          "/api/ebook/assign-segments",
          { architecture, contentMap, voiceDNA }
        );
        assignments = result.assignments;
        setSectionAssignments(assignments);
        addLog(`✓ ${assignments.length} section assignments ready`);
        acc.sectionAssignments = assignments;
        await checkpoint("writing");
      } else {
        setSectionAssignments(assignments);
        addLog(`↩ Resuming — ${assignments.length} section assignments available`);
      }

      // ── Stage 6: Write Sections (sequential with continuity) ─────────────
      setStage("writing");
      // Sections already written in a previous run are kept; only write remaining ones
      const completedSectionKeys = new Set(
        acc.sections.map((s) => `${s.chapterNumber}-${s.sectionNumber}`)
      );
      // Deduplicate stored sections: if a prior run left duplicates in acc.sections
      // (same chapterNumber+sectionNumber), keep only the last-written copy so the
      // book body never contains the same section twice. The Set preserves order.
      const _seenSectionKeys = new Set<string>();
      const _dedupedSections: SectionDraft[] = [];
      for (const s of acc.sections.slice().reverse()) {
        const k = `${s.chapterNumber}-${s.sectionNumber}`;
        if (!_seenSectionKeys.has(k)) {
          _seenSectionKeys.add(k);
          _dedupedSections.unshift(s);
        }
      }
      if (_dedupedSections.length < acc.sections.length) {
        console.warn(`[pipeline] Dropped ${acc.sections.length - _dedupedSections.length} duplicate section(s) from stored state`);
        acc.sections = _dedupedSections;
      }
      const allSections: SectionDraft[] = [..._dedupedSections];
      let completedCount = allSections.length;
      let rawTranscriptFallbackCount = 0;
      const getLastSentence = (text: string) => {
        const lastPara = text.split("\n\n").filter(Boolean).slice(-1)[0] ?? "";
        const sentences = lastPara.match(/[^.!?]+[.!?]+/g) ?? [];
        return sentences[sentences.length - 1]?.trim() ?? "";
      };
      let previousEnding = allSections.length > 0
        ? getLastSentence(allSections[allSections.length - 1].body ?? "")
        : "";

      // ── Seq-A7: Prior excerpt tail tracker ───────────────────────────────
      // After each section is written, record the last 2 sentences of that
      // section's final transcript excerpt so the next section can pick up
      // mid-argument rather than re-setting up what was already established.
      let previousExcerptTail = "";

      // ── FIX 1: Prose-based deduplication (replaces metadata-based system) ──────
      // Store actual written prose by chapter for true n-gram overlap detection.
      // Cross-chapter: last 2 paragraphs per chapter (actual sentences)
      // Current chapter: full prose of all completed sections
      const writtenProseByChapter = new Map<number, string>(); // chapterNum → full prose
      let currentChapterProse = "";  // accumulates prose for the chapter being written
      let currentChapterNum = -1;

      // Seed from already-completed sections on resume.
      // Group prose by chapter so we can sample it properly.
      for (const a of assignments.filter((a) => completedSectionKeys.has(`${a.chapterNumber}-${a.sectionNumber}`))) {
        const section = allSections.find((s) => s.chapterNumber === a.chapterNumber && s.sectionNumber === a.sectionNumber);
        const body = section?.body ?? "";
        const existing = writtenProseByChapter.get(a.chapterNumber) ?? "";
        writtenProseByChapter.set(a.chapterNumber, existing + "\n\n" + body);
      }

      // Build prose sample for deduplication: actual written sentences, not metadata.
      // This gives n-gram overlap real signal to detect duplicated stories/scriptures.
      function buildProseSampleForDedup(currentChapterNum: number): string[] {
        const samples: string[] = [];
        
        // Cross-chapter: last 2 paragraphs from each prior chapter
        for (const [chNum, prose] of writtenProseByChapter.entries()) {
          if (chNum >= currentChapterNum) continue; // only prior chapters
          const paragraphs = prose.split(/\n{2,}/).filter(Boolean);
          const lastTwo = paragraphs.slice(-2);
          for (const para of lastTwo) {
            samples.push(`[Ch ${chNum}] ${para.trim()}`);
          }
        }
        
        // Current chapter: all sentences from completed sections
        if (currentChapterProse.length > 0) {
          const sentences = currentChapterProse
            .split(/\n{2,}/)
            .flatMap((p) => p.split(/(?<=[.!?])\s+/))
            .filter((s) => s.trim().length > 20);
          samples.push(...sentences);
        }
        
        return samples;
      }

      // ── Upgrade 1: Transcript segment consumption registry ───────────────
      // Once a section's source segments are written, mark them consumed so later
      // sections receive filtered excerpts that exclude already-used material.
      const consumedSegmentIds = new Set<string>(
        assignments
          .filter((a) => completedSectionKeys.has(`${a.chapterNumber}-${a.sectionNumber}`))
          .flatMap((a) => a.sourceSegmentIds ?? [])
      );

      // ── Upgrade 5: Canonical concept ownership map ───────────────────────
      // Built once from architecture: concept/section heading → owning chapter number.
      // Sent to write-section so the LLM knows which chapter owns each concept.
      const conceptOwnershipMap: Record<string, number> = {};
      // Assignment key-points lookup for coverage ledger enrichment (ch-sec → keyPoints[])
      const assignmentKeyPointsLookup = new Map<string, string[]>();
      // FIX 3: Segment-to-chapter mapping for hard chapter boundary enforcement
      const segmentToChapter = new Map<string, number>();
      for (const ch of architecture.chapters) {
        for (const sec of ch.sections) {
          conceptOwnershipMap[sec.heading] = ch.number;
          for (const kp of sec.keyPoints ?? []) {
            conceptOwnershipMap[kp] = ch.number;
          }
          // Map each segment to its owning chapter
          for (const segId of sec.sourceSegmentIds ?? []) {
            segmentToChapter.set(segId, ch.number);
          }
        }
      }
      for (const a of assignments) {
        assignmentKeyPointsLookup.set(`${a.chapterNumber}-${a.sectionNumber}`, a.keyPoints ?? []);
      }

      // ── Upgrade 7: Tiered quote dedup ────────────────────────────────────
      // Tier 1: forbiddenVerseTexts — hard ban on re-printing the full verse text.
      // Tier 2: allowedInlineOnly — ref is allowed in a brief inline mention only.
      const quotedVerseTextsByRef = new Map<string, string>(); // ref → full verse text
      // Pre-seed from already-written sections on resume
      for (const a of assignments.filter((aa) => completedSectionKeys.has(`${aa.chapterNumber}-${aa.sectionNumber}`))) {
        for (const q of a.quotes ?? []) {
          if (q.reference) quotedVerseTextsByRef.set(q.reference, q.text);
        }
      }

      // Track scripture/quote references already reproduced in full so later sections
      // reference rather than re-quote them.
      const usedQuoteRefs = new Set<string>(quotedVerseTextsByRef.keys());

      // ── Upgrade 4 (writer): Illustration / story dedup tracker ───────────
      // After each section is written, extract story-opening sentences and add
      // them as dedup labels so later sections can't retell the same narrative.
      const usedIllustrations = new Set<string>(
        allSections
          .map((s) => s.body ?? "")
          .flatMap(extractIllustrationLabels)
      );

      // ── Upgrade 6: Corpus of all written text for similarity gating ──────
      let writtenCorpus = allSections.map((s) => s.body ?? "").join("\n\n");

      // ── Chapter-level plan cache ──────────────────────────────────────────
      // Keyed by sectionNumber, populated once per chapter before any section
      // in that chapter is written. Each entry is the paragraph plan the writer
      // must follow — computed by /api/ebook/chapter-plan so the planner sees
      // ALL sections simultaneously and cannot assign the same concept twice.
      const chapterPlanMap = new Map<number, Array<{ purpose: string; supportedExcerptNumbers: number[]; minExcerptNumber?: number }>>();
      let chapterPlanBuiltForChapter = -1;

      // Proposal 2: chapter-writer cache — keyed by "chapterNum-sectionNum"
      // Populated at chapter rotation; consumed in the section loop instead of calling write-section.
      const chapterWriteCache = new Map<string, { paragraphs: string[]; claimLedger: Array<{ claim: string }> }>();
      let chapterWrittenForChapter = -1;

      if (completedCount > 0) {
        addLog(`↩ Resuming — ${completedCount} sections already written, continuing from section ${completedCount + 1}`);
        setProgress({ total: totalSections, completed: completedCount });
      }

      for (const assignment of assignments) {
        const key = `${assignment.chapterNumber}-${assignment.sectionNumber}`;
        if (completedSectionKeys.has(key)) continue; // already done

        const currentIdx = assignments.indexOf(assignment);
        const nextAssignment = assignments[currentIdx + 1];
        const isLastSectionInChapter = nextAssignment
          ? nextAssignment.chapterNumber !== assignment.chapterNumber
          : true; // last section of the whole book is also a chapter-closer

        // ── FIX 1: Rotate chapter prose when we enter a new chapter ──
        if (assignment.chapterNumber !== currentChapterNum) {
          if (currentChapterNum !== -1 && currentChapterProse.length > 0) {
            // Persist current chapter's full prose to the cross-chapter map
            const existing = writtenProseByChapter.get(currentChapterNum) ?? "";
            writtenProseByChapter.set(currentChapterNum, existing + "\n\n" + currentChapterProse);
          }
          currentChapterProse = "";
          currentChapterNum = assignment.chapterNumber;

          // ── Chapter-level planner: plan ALL sections before writing any ──
          // Builds the concept-ownership contract for this chapter in one call.
          // Falls back gracefully (chapterPlanMap stays empty) if the call fails.
          if (chapterPlanBuiltForChapter !== assignment.chapterNumber) {
            chapterPlanBuiltForChapter = assignment.chapterNumber;
            chapterPlanMap.clear();
            // Include ALL sections in chapter-plan (even completed ones) so the planner
            // can see the full chapter structure. Completed sections' excerpts are already
            // filtered out by consumedSegmentIds, so no duplication risk.
            const chapterAssignments = assignments.filter(
              (a) => a.chapterNumber === assignment.chapterNumber
            );
            const incompleteCount = chapterAssignments.filter(
              (a) => !completedSectionKeys.has(`${a.chapterNumber}-${a.sectionNumber}`)
            ).length;
            if (incompleteCount > 0) {
              addLog(`  📋 Planning Chapter ${assignment.chapterNumber} (${incompleteCount} sections remaining)…`);
              try {
                const chapterPlanResult = await postJson<{ sectionPlans: Array<{ sectionNumber: number; paragraphPlan: Array<{ purpose: string; supportedExcerptNumbers: number[]; minExcerptNumber?: number }> }> }>(
                  "/api/ebook/chapter-plan",
                  {
                    chapterNumber: assignment.chapterNumber,
                    chapterTitle: assignment.chapterTitle,
                    nextChapterTitle: (() => {
                      const lastChapterAssignment = chapterAssignments[chapterAssignments.length - 1];
                      const lastIdx = assignments.indexOf(lastChapterAssignment);
                      return assignments[lastIdx + 1]?.chapterTitle;
                    })(),
                    coreThesis: contentMap.coreThesis || undefined,
                    voiceDNA,
                    priorSectionsSample: buildProseSampleForDedup(assignment.chapterNumber),
                    // Feed prior-chapter coverage into the planner's PRIOR CHAPTERS HARD SKIP block.
                    // Previously [] meant the planner had zero knowledge of what earlier chapters
                    // established — it could (and did) re-plan the same concepts across chapters.
                    alreadyCoveredPoints: buildCoverageLedger(
                      allSections.filter((s) => s.chapterNumber !== assignment.chapterNumber),
                      assignmentKeyPointsLookup
                    ).map((e) => `[${e.heading}]: ${e.summary}`),
                    sections: chapterAssignments.map((a) => ({
                      sectionNumber: a.sectionNumber,
                      heading: a.heading,
                      keyPoints: a.keyPoints ?? [],
                      transcriptExcerpts: (a.transcriptExcerpts ?? []).filter((_, idx) => {
                        const segId = (a.sourceSegmentIds ?? [])[idx];
                        // FIX 3: Hard chapter boundary — only include excerpts from segments
                        // that belong to the current chapter. This prevents chapter spillage.
                        if (segId && segmentToChapter.has(segId)) {
                          const excerptChapter = segmentToChapter.get(segId)!;
                          if (excerptChapter !== assignment.chapterNumber) {
                            return false; // This excerpt belongs to a different chapter
                          }
                        }
                        return !segId || !consumedSegmentIds.has(segId);
                      }),
                      nextSectionHeading: (() => {
                        const idx = assignments.indexOf(a);
                        const next = assignments[idx + 1];
                        return next?.chapterNumber === a.chapterNumber ? next.heading : undefined;
                      })(),
                      isLastSectionInChapter: (() => {
                        const idx = assignments.indexOf(a);
                        const next = assignments[idx + 1];
                        return !next || next.chapterNumber !== a.chapterNumber;
                      })(),
                    })),
                  }
                );
                for (const sp of chapterPlanResult.sectionPlans ?? []) {
                  if ((sp.paragraphPlan ?? []).length > 0) {
                    chapterPlanMap.set(sp.sectionNumber, sp.paragraphPlan);
                  }
                }
                addLog(`  ✓ Chapter ${assignment.chapterNumber} plan ready (${chapterPlanMap.size} sections planned)`);
              } catch (planErr) {
                addLog(`  ⚠ Chapter plan failed — pipeline will stop at write-section (Fix 2: no fallback planner)`);
                console.warn("[chapter-plan] failed:", planErr);
                // FIX 2: No fallback planner. Write-section will return 400 error.
                // This forces the user to retry with a working chapter-plan.
              }
            }
          }

          // ── Proposal 2: single-call chapter writer ──────────────────────
          // When useChapterWriter is on, write ALL sections of this chapter
          // in one LLM call. Results cached — per-section loop reads from cache.
          // Falls back to per-section writes if the call fails.
          if (useChapterWriter && chapterWrittenForChapter !== assignment.chapterNumber) {
            chapterWrittenForChapter = assignment.chapterNumber;
            chapterWriteCache.clear();
            const chapterAssignmentsForWrite = assignments.filter(
              (a) => a.chapterNumber === assignment.chapterNumber &&
                     !completedSectionKeys.has(`${a.chapterNumber}-${a.sectionNumber}`)
            );
            if (chapterAssignmentsForWrite.length > 0) {
              addLog(`  ✍ Writing Chapter ${assignment.chapterNumber} in one pass (${chapterAssignmentsForWrite.length} sections)…`);
              try {
                // G6: route now returns SSE — read the stream and parse the data: line
                const chapterWriteRes = await fetch("/api/ebook/write-chapter", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chapterNumber: assignment.chapterNumber,
                    chapterTitle: assignment.chapterTitle,
                    chapterPremise: (architecture.chapters.find((ch) => ch.number === assignment.chapterNumber) as { chapterPremise?: string } | undefined)?.chapterPremise ?? undefined,
                    nextChapterTitle: (() => {
                      const last = chapterAssignmentsForWrite[chapterAssignmentsForWrite.length - 1];
                      const lastIdx = assignments.indexOf(last);
                      return assignments[lastIdx + 1]?.chapterTitle;
                    })(),
                    coreThesis: contentMap.coreThesis || undefined,
                    primaryTranslation: chapterAssignmentsForWrite[0]?.primaryTranslation,
                    voiceDNA,
                    authorConfig: (authorInstructions || targetAudience) ? { instructions: authorInstructions, targetAudience } : undefined,
                    priorSectionsSample: buildProseSampleForDedup(assignment.chapterNumber),
                    bannedRecaps: extractBannedRecaps(allSections),
                    alreadyQuotedRefs: [...usedQuoteRefs],
                    forbiddenVerseTexts: Array.from(quotedVerseTextsByRef.values()).filter(Boolean),
                    overusedPhrases: extractOverusedPhrases(writtenCorpus, 10), // G4
                    sections: chapterAssignmentsForWrite.map((a) => {
                      const filtered = (a.transcriptExcerpts ?? []).filter((_, idx) => {
                        const segId = (a.sourceSegmentIds ?? [])[idx];
                        return !segId || !consumedSegmentIds.has(segId);
                      });
                      const idx2 = assignments.indexOf(a);
                      const next2 = assignments[idx2 + 1];
                      return {
                        sectionNumber: a.sectionNumber,
                        heading: a.heading,
                        transcriptExcerpts: filtered.length > 0 ? filtered : a.transcriptExcerpts,
                        keyPoints: a.keyPoints ?? [],
                        quotes: a.quotes ?? [],
                        targetWordCount: a.targetWordCount ?? 500,
                        isLastSectionInChapter: !next2 || next2.chapterNumber !== a.chapterNumber,
                        assignedPlan: chapterPlanMap.get(a.sectionNumber),
                      };
                    }),
                  }),
                });
                // Read SSE buffer, extract the data: JSON line
                const reader = chapterWriteRes.body!.getReader();
                const dec = new TextDecoder();
                let buf = "";
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buf += dec.decode(value, { stream: true });
                }
                let chapterWriteResult: { sections: Array<{ sectionNumber: number; paragraphs: string[]; claimLedger: Array<{ claim: string }> }>; error?: string } | null = null;
                for (const line of buf.split("\n")) {
                  if (line.startsWith("data: ")) {
                    chapterWriteResult = JSON.parse(line.slice(6));
                    break;
                  }
                }
                if (!chapterWriteResult || chapterWriteResult.error) throw new Error(chapterWriteResult?.error ?? "Empty response from write-chapter");

                for (const sec of chapterWriteResult.sections ?? []) {
                  chapterWriteCache.set(`${assignment.chapterNumber}-${sec.sectionNumber}`, {
                    paragraphs: sec.paragraphs ?? [],
                    claimLedger: sec.claimLedger ?? [],
                  });
                }
                addLog(`  ✓ Chapter ${assignment.chapterNumber} written (${chapterWriteCache.size} sections cached)`);
              } catch (writeErr) {
                addLog(`  ⚠ Chapter write call failed — falling back to per-section writes`);
                console.warn("[write-chapter] failed:", writeErr);
              }
            }
          }
        }

        // ── FIX 3: Filter excerpts by chapter boundary ────────────────────
        // Only send excerpts from segments that belong to the current chapter.
        // This enforces hard chapter boundaries at the data level, preventing
        // the LLM from accessing next-chapter content even if it wanted to.
        const filteredExcerpts = (assignment.transcriptExcerpts ?? []).filter((_, idx) => {
          const segId = (assignment.sourceSegmentIds ?? [])[idx];
          // Chapter boundary check first
          if (segId && segmentToChapter.has(segId)) {
            const excerptChapter = segmentToChapter.get(segId)!;
            if (excerptChapter !== assignment.chapterNumber) {
              return false; // Hard boundary: this excerpt belongs to another chapter
            }
          }
          // Then check consumption
          return !segId || !consumedSegmentIds.has(segId);
        });
        const partiallyConsumed = filteredExcerpts.length < (assignment.transcriptExcerpts ?? []).length;
        if (partiallyConsumed) {
          addLog(`  ⚡ Upgrade 1: ${(assignment.transcriptExcerpts ?? []).length - filteredExcerpts.length} consumed excerpts stripped for §${assignment.sectionNumber}`);
        }

        // ── Upgrade 7: Build tiered quote dedup arrays ───────────────────
        const forbiddenVerseTexts = Array.from(quotedVerseTextsByRef.values()).filter(Boolean);
        const allowedInlineOnly = Array.from(usedQuoteRefs);

        // Compute coverage ledger once — reused for both the COVERAGE LEDGER prompt block
        // and alreadyCoveredPoints. Previously alreadyCoveredPoints was hardcoded to [],
        // which silently disabled the "PRIOR CONTENT — HARD SKIP" system prompt block
        // (gated on array length > 0). The LLM was never told what was already written.
        const _sectionLedger = buildCoverageLedger(allSections, assignmentKeyPointsLookup);

        const augmented: SectionAssignment = {
          ...assignment,
          transcriptExcerpts: filteredExcerpts.length > 0 ? filteredExcerpts : assignment.transcriptExcerpts,
          previousSectionEnding: previousEnding,
          nextSectionHeading: nextAssignment?.heading,
          priorSectionsSample: buildProseSampleForDedup(assignment.chapterNumber),
          // Restored: activates the "PRIOR CONTENT — HARD SKIP" block in the system prompt.
          // Each entry is "[Section Heading]: <paragraph openers + key points>" — explicit
          // enough for the LLM to recognize when it is about to re-cover covered ground.
          alreadyCoveredPoints: _sectionLedger.map((e) => `[${e.heading}]: ${e.summary}`),
          alreadyQuotedRefs: [...usedQuoteRefs],
          isLastSectionInChapter,
          nextChapterTitle: isLastSectionInChapter && nextAssignment
            ? nextAssignment.chapterTitle
            : undefined,
          // Upgrade 1: consumed segment registry
          consumedSegmentIds: Array.from(consumedSegmentIds),
          // Upgrade 5: concept ownership map
          conceptOwnershipMap,
          // Upgrade 7: tiered quote dedup
          forbiddenVerseTexts,
          allowedInlineOnly,
          // S7: chapter premise anchor
          chapterPremise: (architecture.chapters.find((ch) => ch.number === assignment.chapterNumber) as { chapterPremise?: string } | undefined)?.chapterPremise ?? undefined,
          // Upgrade 3: book thesis threading
          coreThesis: contentMap.coreThesis || undefined,
          // Upgrade 4: illustration dedup
          usedIllustrations: Array.from(usedIllustrations),
          // Scripture Amendment 4: primary translation (from assignment, seeded by assign-segments)
          primaryTranslation: assignment.primaryTranslation,
          // ── 7-Amendment Anti-Duplication System ──────────────────────────
          // Amendment 1: full coverage ledger — every section written so far
          coverageLedger: _sectionLedger,
          // Amendment 4: thesis sentences from prior sections — banned from paraphrase
          bannedRecaps: extractBannedRecaps(allSections),
          // Amendment 6: top repeated 3-grams — encourage lexical variety
          overusedPhrases: extractOverusedPhrases(writtenCorpus, 10),
          // Amendment 7: section position within chapter — drives novelty cap
          sectionIndexInChapter: (() => {
            const chapterAssignments = assignments.filter((a) => a.chapterNumber === assignment.chapterNumber);
            return Math.max(0, chapterAssignments.findIndex((a) => a.sectionNumber === assignment.sectionNumber));
          })(),
          // ── 7-Amendment Speaker-Sequence System ──────────────────────────
          // Seq-A3: argument pivot phrases extracted from this section's excerpts
          sequenceTurns: extractSequenceTurns(filteredExcerpts.length > 0 ? filteredExcerpts : assignment.transcriptExcerpts),
          // Seq-A4: story setup → principle pairs extracted from this section's excerpts
          storyPayoffPairs: extractStoryPayoffPairs(filteredExcerpts.length > 0 ? filteredExcerpts : assignment.transcriptExcerpts),
          // Seq-A5: scripture reference → excerpt index positions
          scripturePositions: extractScripturePositions(filteredExcerpts.length > 0 ? filteredExcerpts : assignment.transcriptExcerpts),
          // Seq-A7: last 2 sentences of prev section's final excerpt — argument was mid-flow
          priorExcerptTail: previousExcerptTail || undefined,
          // Chapter-level pre-computed plan — skips per-section planner in write-section
          assignedPlan: chapterPlanMap.get(assignment.sectionNumber),
        };
        addLog(`Writing Ch ${assignment.chapterNumber} § ${assignment.sectionNumber}: ${assignment.heading}…`);

        // Update section status to "writing"
        setChapters((prev) =>
          prev.map((ch) =>
            ch.number === assignment.chapterNumber
              ? {
                  ...ch,
                  sections: ch.sections.map((s) =>
                    s.sectionNumber === assignment.sectionNumber ? { ...s, status: "writing" as const } : s
                  ),
                }
              : ch
          )
        );

        // Proposal 2 fast-path: use chapter-writer cached result if available
        const _cacheKey = `${assignment.chapterNumber}-${assignment.sectionNumber}`;
        const _cached = chapterWriteCache.get(_cacheKey);
        let body: string;
        let claimLedger: Array<{ claim: string }>;
        let passiveVoiceCount: number;
        let unfullfilledHook: string | null;
        let sequenceBreakCount: number;
        let usedFallback = false;
        let fallbackError: string | null = null;
        if (_cached && _cached.paragraphs.length > 0) {
          body = _cached.paragraphs.join("\n\n");
          claimLedger = _cached.claimLedger;
          passiveVoiceCount = 0;
          unfullfilledHook = null;
          sequenceBreakCount = 0;
        } else {
          ({ body, claimLedger, passiveVoiceCount, unfullfilledHook, sequenceBreakCount, fallback: usedFallback, fallbackError } = await streamSection(
            augmented,
            (authorInstructions || targetAudience) ? { instructions: authorInstructions, targetAudience } : undefined
          ));
          // A transient LLM/API failure degrades the route to raw transcript text.
          // Retry up to 2 more times before accepting unedited transcript into the book.
          for (let retryAttempt = 1; usedFallback && retryAttempt <= 2; retryAttempt++) {
            addLog(`  ↺ Ch${assignment.chapterNumber} §${assignment.sectionNumber} fell back to raw transcript (${fallbackError}) — retry ${retryAttempt}/2…`);
            ({ body, claimLedger, passiveVoiceCount, unfullfilledHook, sequenceBreakCount, fallback: usedFallback, fallbackError } = await streamSection(
              augmented,
              (authorInstructions || targetAudience) ? { instructions: authorInstructions, targetAudience } : undefined
            ));
          }
          if (usedFallback) {
            rawTranscriptFallbackCount++;
            addLog(`  ⚠ Ch${assignment.chapterNumber} §${assignment.sectionNumber} STILL raw transcript after retries (${fallbackError}) — review and rewrite this section manually`);
          }
        }

        // Quality gate: retry once if too short (transcript coverage check)
        const wc = countWords(body);
        if (wc < 300 && assignment.transcriptExcerpts.join(" ").length > 500) {
          addLog(`  ↺ Section too short (${wc} words) — retrying with expansion prompt…`);
          const expanded = { ...augmented, targetWordCount: Math.max(assignment.targetWordCount, 600) };
          ({ body, claimLedger, passiveVoiceCount, unfullfilledHook, sequenceBreakCount } = await streamSection(
            expanded,
            (authorInstructions || targetAudience) ? { instructions: authorInstructions, targetAudience } : undefined
          ));
        }


        // ── Upgrade 8: Log passive voice hits ────────────────────────────
        if (passiveVoiceCount > 0) {
          addLog(`  ⚠ ${passiveVoiceCount} passive voice hit(s) in Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
        }
        // ── Upgrade 12: Log unfulfilled hook ─────────────────────────────
        if (unfullfilledHook) {
          addLog(`  ⚠ Unfulfilled hook in Ch${assignment.chapterNumber} §${assignment.sectionNumber}: "${unfullfilledHook.slice(0, 80)}…"`);
        }
        // ── Seq-A6: Log route-level sequence breaks ───────────────────────
        if (sequenceBreakCount > 0) {
          addLog(`  ⚠ Seq: ${sequenceBreakCount} sequence break(s) in Ch${assignment.chapterNumber} §${assignment.sectionNumber} — speaker arc may be partially out of order`);
        }

        const finalWc = countWords(body);
        const draft: SectionDraft = {
          chapterNumber: assignment.chapterNumber,
          sectionNumber: assignment.sectionNumber,
          heading: assignment.heading,
          body,
          wordCount: finalWc,
          status: "complete",
        };
        allSections.push(draft);
        completedCount++;
        previousEnding = getLastSentence(body ?? "");

        // ── Seq-A7: Update prior excerpt tail for next section ────────────
        const effectiveExcerpts = filteredExcerpts.length > 0 ? filteredExcerpts : assignment.transcriptExcerpts;
        const lastExcerpt = effectiveExcerpts[effectiveExcerpts.length - 1] ?? "";
        const excerptSentences = lastExcerpt.split(/(?<=[.!?])\s+/).filter(Boolean);
        previousExcerptTail = excerptSentences.slice(-2).join(" ").slice(0, 240);

        // ── Seq-A2: Post-write sequence watermark ─────────────────────────
        const writtenParas = (body ?? "").split(/\n\n+/).filter(Boolean);
        const seqBreaks = checkSequenceWatermark(writtenParas, effectiveExcerpts);
        if (seqBreaks.length > 0) {
          for (const brk of seqBreaks) {
            addLog(`  ⚠ Seq-A2: Ch${assignment.chapterNumber} §${assignment.sectionNumber} paragraph ${brk.paragraphIdx} drew from excerpt ${brk.got} (expected ≥${brk.expectedMin}) — sequence inversion`);
          }
        }

        // ── Upgrade 6: Extend corpus for future similarity checks ─────────
        writtenCorpus += "\n\n" + body;
        
        // ── FIX 1: Accumulate prose for current chapter ───────────────────
        currentChapterProse += "\n\n" + body;

        // ── Upgrade 4 (writer): Register new illustration labels ──────────
        for (const label of extractIllustrationLabels(body ?? "")) {
          usedIllustrations.add(label);
        }

        // ── Upgrade 1: Mark source segments as consumed ───────────────────
        for (const segId of assignment.sourceSegmentIds ?? []) {
          consumedSegmentIds.add(segId);
        }

        // ── Upgrade 7: Register quoted verse texts ────────────────────────
        // Register every quote ref from this section so future sections reference-only
        for (const q of assignment.quotes ?? []) {
          if (q.reference) {
            usedQuoteRefs.add(q.reference);
            if (q.text) quotedVerseTextsByRef.set(q.reference, q.text);
          }
        }

        // Update UI
        setChapters((prev) =>
          prev.map((ch) =>
            ch.number === assignment.chapterNumber
              ? {
                  ...ch,
                  sections: ch.sections.map((s) =>
                    s.sectionNumber === assignment.sectionNumber ? draft : s
                  ),
                }
              : ch
          )
        );
        setProgress({ total: totalSections, completed: completedCount });
        addLog(`  ✓ ${finalWc.toLocaleString()} words written`);
        // Save after every section so a refresh never loses completed work
        acc.sections = [...allSections];
        acc.progress = { total: totalSections, completed: completedCount };
        await checkpoint("writing");
      }

      // ── Upgrade 10: Chapter word-count normalization check ───────────────
      // Flag chapters that are drastically shorter or longer than the mean —
      // this is a pipeline signal only; the user is informed via the log.
      {
        const chapterWordCounts = acc.chapters.map((ch) => ({
          number: ch.number,
          title: ch.title,
          wordCount: ch.sections.reduce((sum, s) => sum + countWords(s.body ?? ""), 0),
        }));
        const meanWords = chapterWordCounts.reduce((s, c) => s + c.wordCount, 0) / (chapterWordCounts.length || 1);
        for (const ch of chapterWordCounts) {
          const ratio = ch.wordCount / (meanWords || 1);
          if (ratio < 0.4) {
            addLog(`⚠ Chapter ${ch.number} "${ch.title}" is very short (${ch.wordCount.toLocaleString()} wds — ${Math.round(ratio * 100)}% of mean). Consider expanding.`);
          } else if (ratio > 2.5) {
            addLog(`⚠ Chapter ${ch.number} "${ch.title}" is very long (${ch.wordCount.toLocaleString()} wds — ${Math.round(ratio * 100)}% of mean). Consider splitting or trimming.`);
          }
        }
      }
      if (rawTranscriptFallbackCount > 0) {
        addLog(`⚠ ${rawTranscriptFallbackCount} section(s) still contain raw, unedited transcript after retries — search the manuscript for these before publishing.`);
      }

      // ── Stage 7: Polish chapters ─────────────────────────────────────────
      setStage("polishing");
      const completedChapterNums = new Set(
        acc.chapters.filter((c) => c.status === "complete").map((c) => c.number)
      );
      const polishedChapters: ChapterDraft[] = acc.chapters.filter((c) => c.status === "complete");
      if (polishedChapters.length > 0) {
        addLog(`↩ Resuming — ${polishedChapters.length} chapters already polished`);
      }

      for (const chapterBlueprint of architecture.chapters) {
        if (completedChapterNums.has(chapterBlueprint.number)) continue; // already done

        addLog(`Polishing Chapter ${chapterBlueprint.number}: ${chapterBlueprint.title}…`);
        const chapterSections = allSections.filter((s) => s.chapterNumber === chapterBlueprint.number);

        // Send slim sections — the route only uses the first ~300 chars per body for the summary.
        // Full bodies are re-merged client-side after the response to avoid a large payload.
        const slimSections = chapterSections.map((s) => ({
          ...s,
          body: (s.body ?? "").slice(0, 400),
        }));

        const polished = await postJson<ChapterDraft>("/api/ebook/polish", {
          input: {
            number: chapterBlueprint.number,
            title: chapterBlueprint.title,
            sections: slimSections,
            chapterSegmentTexts: [], // not used by the route; omit to reduce payload
            voiceDNA,
            quotesInChapter: (chapterBlueprint.quotesInChapter ?? []).slice(0, 8),
            primaryTranslation: assignments.find((a) => a.chapterNumber === chapterBlueprint.number)?.primaryTranslation,
            previousChapterForwardQuestion: polishedChapters.length > 0
              ? polishedChapters[polishedChapters.length - 1].forwardQuestion
              : undefined,
            // U5: chapter premise line from architect — north-star for intro/conclusion
            chapterPremise: (chapterBlueprint as { chapterPremise?: string }).chapterPremise ?? undefined,
            // U7: series arc bridge concept — tells polish what thread this chapter picks up
            seriesArcBridge: (() => {
              const arc = (architecture as { seriesArc?: Array<{ fromChapter: number; toChapter: number; bridgeConcept: string }> }).seriesArc ?? [];
              return arc.find((e) => e.toChapter === chapterBlueprint.number)?.bridgeConcept ?? undefined;
            })(),
            // Amendment 6: next chapter title — polish uses this to write a forward
            // question that genuinely anticipates what the next chapter delivers.
            nextChapterTitle: (() => {
              const next = architecture.chapters.find((c) => c.number === chapterBlueprint.number + 1);
              return next?.title ?? undefined;
            })(),
          },
          ...((authorInstructions || targetAudience) ? { authorConfig: { instructions: authorInstructions, targetAudience } } : {}),
        });

        // Restore full section bodies that were stripped for the request
        const fullPolished: ChapterDraft = {
          ...polished,
          sections: polished.sections.map((s) => {
            const full = chapterSections.find((cs) => cs.sectionNumber === s.sectionNumber);
            return full ? { ...s, body: full.body, wordCount: full.wordCount } : s;
          }),
        };

        polishedChapters.push(fullPolished);
        setChapters((prev) =>
          prev.map((ch) => (ch.number === chapterBlueprint.number ? fullPolished : ch))
        );
        addLog(`  ✓ Chapter ${chapterBlueprint.number} polished`);
        // ── Upgrade 14: Log epigraph credibility warning ─────────────────
        const polishedWithWarning = polished as ChapterDraft & { epigraphCredibilityWarning?: string };
        if (polishedWithWarning.epigraphCredibilityWarning) {
          addLog(`  ⚠ Epigraph Ch${chapterBlueprint.number}: ${polishedWithWarning.epigraphCredibilityWarning}`);
        }
        acc.chapters = [...polishedChapters];
        await checkpoint("polishing");
      }

      // ── Stage 8: Front / Back Matter ────────────────────────────────────
      let frontMatter = acc.frontMatter;
      if (!frontMatter) {
        setStage("frontmatter");
        addLog("Writing preface, introduction, and conclusion…");
        // A3: Use the filtered (teaching-only) transcript for front matter so
        // prayers, announcements, and altar calls don't bleed into the preface/introduction.
        const frontMatterTranscript = typeof teachingTranscript === "string" && teachingTranscript
          ? teachingTranscript
          : acc.transcripts
              .map((t) => `[${t.label}]\n${t.text}`)
              .join("\n\n═══════════════════════════════════════\n\n");
        if (countWords(frontMatterTranscript) < 100) {
          throw new Error("Saved job is missing transcript text required for front matter");
        }
        frontMatter = await postJson<FrontBackMatter>("/api/ebook/frontmatter", {
          masterTranscript: frontMatterTranscript.slice(0, 14000),
          architecture,
          voiceDNA,
          ...((authorInstructions || targetAudience) ? { authorConfig: { instructions: authorInstructions, targetAudience } } : {}),
          alreadyQuotedRefs: [...quotedVerseTextsByRef.keys()],
          forbiddenVerseTexts: Array.from(quotedVerseTextsByRef.values()).filter(Boolean),
        });
        addLog("✓ Front and back matter complete");
        acc.frontMatter = frontMatter;
        await checkpoint("complete");
      } else {
        addLog("↩ Resuming — front matter available");
      }

      // ── Assemble + harmonize manifest ───────────────────────────────────
      const runningTotal = polishedChapters.reduce((sum, chapter) => sum + chapter.totalWordCount, 0);
      const manifest: EbookManifest = {
        jobId,
        bookTitle: architecture.bookTitle,
        subtitle: architecture.subtitle,
        authorName: architecture.authorName,
        frontMatter,
        chapters: polishedChapters,
        totalWordCount: runningTotal,
        allQuotes: contentMap.allQuotes,
        generatedAt: new Date().toISOString(),
      };

      const harmonizedManifest = harmonizeBookManifest(manifest);
      const harmonizedTotal = harmonizedManifest.chapters.reduce((sum, chapter) => sum + chapter.totalWordCount, 0);
      harmonizedManifest.totalWordCount = harmonizedTotal;
      setTotalWords(harmonizedTotal);
      addLog("✓ Harmonization pass complete — removed non-book phrasing and normalized chapter flow");

      // ── Back Matter: glossary, reading group guide, scripture index ─────
      addLog("Generating back matter (glossary, discussion guide, scripture index)…");
      try {
        const backMatter = await postJson<BackMatter>("/api/ebook/backmatter", { manifest: harmonizedManifest });
        harmonizedManifest.backMatter = backMatter;
        acc.backMatter = backMatter;
        await checkpoint("complete");
        const glossaryCount = backMatter.glossary?.length ?? 0;
        const guideCount = backMatter.readingGroupGuide?.length ?? 0;
        const scriptureCount = backMatter.scriptureIndex?.length ?? 0;
        addLog(`✓ Back matter complete — ${glossaryCount} glossary terms, ${guideCount} chapter guides, ${scriptureCount} scripture references`);
      } catch (bmErr) {
        addLog(`⚠ Back matter generation failed — continuing without it: ${bmErr instanceof Error ? bmErr.message : String(bmErr)}`);
      }

      // ── Quality Gate: fidelity + premium presentation checks ───────────
      addLog("Running quality review…");
      const quality = await postJson<QualityReport>(
        "/api/ebook/quality-check",
        { chapters: harmonizedManifest.chapters, contentMap, frontMatter: harmonizedManifest.frontMatter }
      );
      setQualityReport(quality);
      if (quality.pass) {
        addLog(`✓ Quality score: ${quality.score}/100`);
      } else {
        const warnings = quality.issues.slice(0, 3).map((i) => i.message).join(" | ");
        addLog(`⚠ Draft needs review (${quality.score}/100): ${warnings || "fidelity/style issues detected"}`);
      }

      // Draft is now ready for end-of-book human review; export is manual.
      acc.exportUrls = null;
      acc.chapters = harmonizedManifest.chapters;
      acc.frontMatter = harmonizedManifest.frontMatter;
      await checkpoint("complete");
      setStage("complete");
      setReviewContext({ contentMap, frontMatter: harmonizedManifest.frontMatter });
      syncCompletedManifest(harmonizedManifest);
      addLog(`✓ Draft ready for review — ${harmonizedTotal.toLocaleString()} words across ${harmonizedManifest.chapters.length} chapters`);

    } catch (err) {
      const msg = err instanceof Error && err.message.trim() ? err.message : "Pipeline failed";
      // Log full stack to browser console for debugging
      console.error("[EbookPipeline] runPipeline crash:", err);
      const stackHint = err instanceof Error && err.stack
        ? ` [at: ${err.stack.split("\n").slice(1, 3).join(" → ").replace(/\s+/g, " ").slice(0, 120)}]`
        : "";
      setError(msg + stackHint);
      acc.status = "failed";
      acc.currentStage = "failed";
      acc.errorLog = logRef.current;
      acc.updatedAt = new Date().toISOString();
      const persistableFailure = sanitizeJobStateForPersistence({ ...acc });
      try { 
        await saveEbookJob({ ...persistableFailure }); 
      } catch (err) {
        addLog(`⚠ Front matter save failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
      // Update savedJobRef so the Resume button has the partial state
      savedJobRef.current = { ...persistableFailure };
      onJobStateChange?.({ ...persistableFailure });
      setStage("failed");
      addLog(`✗ Error: ${msg}`);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  const isRunning = stage !== "idle" && stage !== "complete" && stage !== "failed";
  const hasResumableState = Boolean(
    savedJobRef.current && (
      savedJobRef.current.masterTranscript ||
      savedJobRef.current.transcripts.length > 0 ||
      savedJobRef.current.voiceDNA ||
      savedJobRef.current.contentMap ||
      savedJobRef.current.architecture ||
      savedJobRef.current.sectionAssignments.length > 0 ||
      savedJobRef.current.sections.length > 0 ||
      savedJobRef.current.chapters.length > 0 ||
      savedJobRef.current.frontMatter
    )
  );

  return (
    <div className="flex flex-col gap-5 pb-2 lg:pb-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Ebook Production</h2>
          <p className="text-xs text-slate-400 mt-0.5 leading-snug max-w-sm">
            Upload up to 4 hours of audio. Your voice and content — no additions, no fabrication.
          </p>
        </div>
        {/* Save Project button — visible once the pipeline has started */}
        {onSaveProject && stage !== "idle" && (
          <button
            type="button"
            onClick={() => {
              setSaveName(completedManifest?.bookTitle ?? "My Ebook");
              setShowSaveBar((v) => !v);
              setSavedConfirm(false);
            }}
            className="flex shrink-0 items-center gap-1.5 min-h-[44px] rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-300 hover:bg-cyan-500/20 transition"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M17 21v-8H7v8M7 3v5h8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Save Project
          </button>
        )}
      </div>

      {/* Inline save bar */}
      {showSaveBar && onSaveProject && (
        <div className="flex items-center gap-2 rounded-xl border border-cyan-500/25 bg-slate-900/80 px-4 py-3">
          <input
            autoFocus
            value={saveName}
            onChange={(e) => { setSaveName(e.target.value); setSavedConfirm(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && saveName.trim()) {
                onSaveProject(saveName.trim());
                setSavedConfirm(true);
              } else if (e.key === "Escape") {
                setShowSaveBar(false);
              }
            }}
            placeholder="Project name…"
            className="flex-1 min-h-[48px] rounded-xl border border-slate-600 bg-slate-800 px-4 text-base text-slate-100 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={!saveName.trim()}
            onClick={() => {
              if (saveName.trim()) {
                onSaveProject(saveName.trim());
                setSavedConfirm(true);
              }
            }}
            className="min-h-[48px] rounded-xl bg-cyan-600 px-5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-40"
          >
            {savedConfirm ? "✓ Saved" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setShowSaveBar(false)}
            className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl border border-slate-600 text-slate-400 hover:text-slate-200"
          >×</button>
        </div>
      )}

      {/* Audio + Transcript Upload Grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <AudioCard
            key={i}
            index={i}
            file={audioFiles[i]}
            onFile={(f) => setAudio(i, f)}
            transcriptFile={transcriptFiles[i]}
            onTranscriptFile={(f) => setTranscript(i, f)}
            disabled={isRunning}
          />
        ))}
      </div>

      {/* Book Configuration Panel */}
      <div className="rounded-2xl border border-violet-500/15 bg-slate-900/60 overflow-hidden">
        <div className="border-b border-violet-500/10 px-4 py-3">
          <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-300">Book Configuration</h3>
          <p className="text-xs text-slate-500 mt-0.5">Shape how your book is written before the pipeline begins.</p>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Target Audience</label>
            <input
              type="text"
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              placeholder="e.g. Pentecostal believers, new Christians, church leaders…"
              className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 placeholder:text-slate-600 outline-none focus:border-violet-500/40"
              disabled={isRunning}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Writing Instructions <span className="ml-1 text-slate-600 normal-case font-normal">(optional)</span>
            </label>
            <textarea
              value={authorInstructions}
              onChange={(e) => setAuthorInstructions(e.target.value)}
              placeholder="e.g. Keep a warm, conversational tone. Use simple language suitable for first-generation believers. Emphasize practical application over theological theory…"
              rows={4}
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 placeholder:text-slate-600 outline-none focus:border-violet-500/40 resize-none"
              disabled={isRunning}
            />
            <p className="mt-1 text-[10px] text-slate-600">Tell the AI how you want your book to read. Be specific about tone, vocabulary level, and style.</p>
          </div>

          {/* Chapter mode toggle — entire row is the tap target */}
          <div
            role="switch"
            aria-checked={oneChapterPerUpload}
            onClick={() => !isRunning && setOneChapterPerUpload((v) => !v)}
            className={[
              "flex items-center gap-3 min-h-[52px] rounded-xl border border-slate-700/40 bg-slate-950/50 px-3 py-3",
              !isRunning ? "cursor-pointer" : "cursor-not-allowed opacity-60",
            ].join(" ")}
          >
            {/* visual switch — pointer-events:none so clicks fall through to the row div */}
            <div
              className={[
                "flex-shrink-0 w-9 h-5 rounded-full transition-colors pointer-events-none",
                oneChapterPerUpload ? "bg-violet-500" : "bg-slate-700",
              ].join(" ")}
            >
              <span
                className={[
                  "block w-4 h-4 rounded-full bg-white shadow transition-transform mx-0.5 mt-0.5",
                  oneChapterPerUpload ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </div>
            <div className="select-none">
              <p className="text-sm font-medium text-slate-200 leading-tight">One chapter per upload</p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                When on, each audio file becomes exactly one chapter — the AI won't reorganize or split content across audio boundaries.
              </p>
            </div>
          </div>

          {/* Chapter Writer toggle — entire row is the tap target */}
          <div
            role="switch"
            aria-checked={useChapterWriter}
            onClick={() => !isRunning && setUseChapterWriter((v) => !v)}
            className={[
              "flex items-center gap-3 min-h-[52px] rounded-xl border border-slate-700/40 bg-slate-950/50 px-3 py-3",
              !isRunning ? "cursor-pointer" : "cursor-not-allowed opacity-60",
            ].join(" ")}
          >
            <div
              className={[
                "flex-shrink-0 w-9 h-5 rounded-full transition-colors pointer-events-none",
                useChapterWriter ? "bg-cyan-500" : "bg-slate-700",
              ].join(" ")}
            >
              <span
                className={[
                  "block w-4 h-4 rounded-full bg-white shadow transition-transform mx-0.5 mt-0.5",
                  useChapterWriter ? "translate-x-4" : "translate-x-0",
                ].join(" ")}
              />
            </div>
            <div className="select-none">
              <p className="text-sm font-medium text-slate-200 leading-tight">Single-pass chapter writer</p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                When on, all sections in a chapter are written in one AI call — the model sees earlier sections while writing later ones, reducing repetition. Does not affect chapter structure.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Start Button OR Start-fresh banner when a run is restored */}
      {stage === "idle" && (
        <button
          type="button"
          disabled={!canStart}
          onClick={runPipeline}
          className={[
            "w-full min-h-[52px] rounded-xl font-semibold text-base transition-all",
            canStart
              ? "bg-gradient-to-r from-cyan-500 to-violet-500 text-white hover:opacity-90 active:scale-[0.98]"
              : "bg-slate-700/50 text-slate-500 cursor-not-allowed",
          ].join(" ")}
        >
          {canStart
            ? `Begin Ebook Production (${activeSlotCount} slot${activeSlotCount > 1 ? "s" : ""})`
            : "Add at least one audio or transcript to begin"}
        </button>
      )}

      {/* Stage Tracker */}
      {stage !== "idle" && (
        <EbookStageTracker
          current={stage}
          progress={progress}
          signalFilterState={signalFilterState}
          signalFilterDetail={signalFilterDetail}
        />
      )}

      {/* Writing progress ring */}
      {stage === "writing" && progress.total > 0 && (
        <div className="flex items-center gap-4 px-1">
          <EbookProgressRing total={progress.total} completed={progress.completed} label="Sections" size={72} />
          <div>
            <p className="text-sm font-medium text-slate-200">Writing sections…</p>
            <p className="text-xs text-slate-500 tabular-nums mt-0.5">{progress.completed} of {progress.total} complete</p>
          </div>
        </div>
      )}

        {completedManifest && reviewContext && (
          <ProseToolbarProvider>
          <div className="rounded-2xl border border-cyan-500/15 bg-slate-900/60 p-4 shadow-panel space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Final Review</p>
                <div className="mt-1 flex items-center gap-3 flex-wrap">
                  {totalWords > 0 && (
                    <span className="text-xl font-bold text-cyan-400 tabular-nums">{totalWords.toLocaleString()} <span className="text-sm font-normal text-slate-400">words</span></span>
                  )}
                  <p className="text-sm text-slate-300">Edit chapter by chapter, then export when ready.</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Template picker — compact button that expands a card grid */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowTemplatePicker((v) => !v)}
                    className="min-h-[48px] rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:border-cyan-500/60 hover:bg-slate-700 transition-colors flex items-center gap-2"
                    aria-label="Choose book layout template"
                  >
                    <span className="font-semibold text-cyan-300">Layout:</span>
                    <span>{BOOK_TEMPLATES[completedManifest?.selectedTemplate ?? "devotional"].name}</span>
                    <span className="text-[10px] rounded-full border border-slate-600 bg-slate-700 px-1.5 py-0.5 text-slate-400">
                      {BOOK_TEMPLATES[completedManifest?.selectedTemplate ?? "devotional"].badge}
                    </span>
                    <svg className={`h-3.5 w-3.5 text-slate-400 transition-transform ${showTemplatePicker ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>

                  {showTemplatePicker && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-[640px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-600/60 bg-slate-900 p-3 shadow-2xl">
                      <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Choose a layout template</p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-2">
                        {BOOK_TEMPLATE_IDS.map((id) => {
                          const tpl = BOOK_TEMPLATES[id];
                          const isActive = (completedManifest?.selectedTemplate ?? "devotional") === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                updateCompletedManifest((cur) => ({ ...cur, selectedTemplate: id }));
                                setShowTemplatePicker(false);
                              }}
                              className={[
                                "rounded-xl border p-3 text-left transition-all",
                                isActive
                                  ? "border-cyan-400/50 bg-cyan-500/10 ring-1 ring-cyan-400/30"
                                  : "border-slate-700/60 bg-slate-800/60 hover:border-slate-500 hover:bg-slate-800",
                              ].join(" ")}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className={`text-sm font-semibold ${isActive ? "text-cyan-200" : "text-slate-200"}`}>
                                  {tpl.name}
                                </span>
                                {isActive && (
                                  <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                                )}
                              </div>
                              <span className="mt-0.5 block text-[10px] font-medium text-slate-500">{tpl.badge}</span>
                              <span className="mt-1 block text-[11px] leading-snug text-slate-400">{tpl.description}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void runAudit()}
                  disabled={auditRunning || exportingBook || applyingAudit}
                  className="min-h-[48px] rounded-xl border border-amber-400/30 bg-amber-400/8 px-4 py-2.5 text-sm font-semibold text-amber-200 transition-all hover:bg-amber-400/15 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {auditRunning ? "Auditing…" : "Audit Book"}
                </button>
                <button
                  type="button"
                  onClick={() => void exportFinalBook()}
                  disabled={exportingBook || auditRunning || applyingAudit}
                  className="min-h-[48px] rounded-xl bg-gradient-to-r from-cyan-500 to-violet-500 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {exportingBook ? "Exporting…" : "Export Final Book"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-700/40 bg-slate-900/50 p-1.5">
              <button
                type="button"
                onClick={() => setReviewTab("manuscript")}
                className={[
                  "min-h-[48px] rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                  reviewTab === "manuscript"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-700/50 bg-slate-900/60 text-slate-300",
                ].join(" ")}
              >
                Manuscript
              </button>
              <button
                type="button"
                onClick={() => setReviewTab("source-map")}
                className={[
                  "min-h-[48px] rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                  reviewTab === "source-map"
                    ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
                    : "border-slate-700/50 bg-slate-900/60 text-slate-300",
                ].join(" ")}
              >
                Source Map
              </button>
              <button
                type="button"
                onClick={() => setReviewTab("audio-sources")}
                className={[
                  "min-h-[48px] rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
                  reviewTab === "audio-sources"
                    ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                    : "border-slate-700/50 bg-slate-900/60 text-slate-300",
                ].join(" ")}
              >
                Audio Sources
              </button>
            </div>

            {completedManifest.backMatter ? (
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-100">
                Back Matter ready: {(completedManifest.backMatter.glossary?.length ?? 0)} glossary terms, {(completedManifest.backMatter.readingGroupGuide?.length ?? 0)} chapter guides, {(completedManifest.backMatter.scriptureIndex?.length ?? 0)} scripture references.
              </div>
            ) : (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-xs text-amber-100 flex flex-wrap items-center justify-between gap-2">
                <span>Back Matter is missing for this run.</span>
                <button
                  type="button"
                  onClick={() => void regenerateBackMatter()}
                  disabled={regeneratingBackMatter || exportingBook}
                  className="min-h-[44px] rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {regeneratingBackMatter ? "Regenerating…" : "Regenerate Back Matter"}
                </button>
              </div>
            )}

            {reviewTab === "manuscript" && (
              <>

            {/* Shared word processor toolbar — one bar for all editors */}
            <SharedProseToolbar className="sticky top-0 z-20" />

            {/* Print Specification Toggle */}
            <PrintSpecPanel
              trimSize={printSpec.trimSize}
              runningHeaders={printSpec.runningHeaders}
              folioStyle={printSpec.folioStyle}
              frontMatterNumbering={printSpec.frontMatterNumbering}
              sectionOrnament={printSpec.sectionOrnament}
              bodyTextAlign={printSpec.bodyTextAlign}
              bodyFontFamily={printSpec.bodyFontFamily}
              fontSizeScale={printSpec.fontSizeScale}
              onChange={setPrintSpec}
            />

            {qualityReport && (
              <div className={`rounded-xl border px-4 py-3 ${qualityReport.pass ? "border-emerald-400/20 bg-emerald-400/5" : "border-amber-400/20 bg-amber-400/5"}`}>
                <div className="flex items-center justify-between gap-3">
                  <p className={`text-sm font-semibold ${qualityReport.pass ? "text-emerald-300" : "text-amber-300"}`}>
                    Quality score: {qualityReport.score}/100
                  </p>
                  <p className="text-xs text-slate-400">{qualityReport.pass ? "Pass" : "Needs review"}</p>
                </div>
                {qualityReport.issues.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-300">
                    {qualityReport.issues.slice(0, 4).map((issue, index) => (
                      <li key={index} className={issue.severity === "error" ? "text-red-300" : "text-amber-200"}>
                        • {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="grid gap-3 md:grid-cols-3">
              <ProseEditor
                label="Preface"
                value={completedManifest.frontMatter.preface}
                onChange={(v) => updateCompletedManifest((current) => ({ ...current, frontMatter: { ...current.frontMatter, preface: v } }))}
                rows={5}
                placeholder="Book preface…"
              />
              <ProseEditor
                label="Introduction"
                value={completedManifest.frontMatter.introduction}
                onChange={(v) => updateCompletedManifest((current) => ({ ...current, frontMatter: { ...current.frontMatter, introduction: v } }))}
                rows={5}
                placeholder="Book introduction…"
              />
              <ProseEditor
                label="Conclusion"
                value={completedManifest.frontMatter.conclusion}
                onChange={(v) => updateCompletedManifest((current) => ({ ...current, frontMatter: { ...current.frontMatter, conclusion: v } }))}
                rows={5}
                placeholder="Book conclusion…"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ProseEditor
                label="About Author"
                value={completedManifest.frontMatter.aboutAuthor ?? ""}
                onChange={(v) => updateCompletedManifest((current) => ({ ...current, frontMatter: { ...current.frontMatter, aboutAuthor: v.trim() ? v : null } }))}
                rows={4}
                placeholder="Author bio…"
              />
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">Resources</label>
                <textarea
                  value={completedManifest.frontMatter.resourcesList.join("\n")}
                  onChange={(e) => updateCompletedManifest((current) => ({
                    ...current,
                    frontMatter: {
                      ...current.frontMatter,
                      resourcesList: e.target.value.split(/\n+/).map((item) => item.trim()).filter(Boolean),
                    },
                  }))}
                  rows={4}
                  className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>

            {/* Back Matter — only shown when the back matter generation stage has completed */}
            {completedManifest.backMatter && (
              <div className="border-t border-slate-700/40 pt-4 space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Back Matter</p>

                {/* Glossary */}
                {(completedManifest.backMatter.glossary?.length ?? 0) > 0 && (
                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Glossary ({completedManifest.backMatter.glossary.length} terms)
                    </label>
                    <div className="space-y-2 max-h-56 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2">
                      {completedManifest.backMatter.glossary.map((entry, i) => (
                        <div key={i} className="border-b border-slate-800/60 pb-2 last:border-0 last:pb-0">
                          <p className="text-xs font-semibold text-slate-200">{entry.term}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{entry.definition}</p>
                          <p className="text-[10px] text-slate-600 mt-0.5 italic">{entry.firstAppearance}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Reading Group Guide */}
                {(completedManifest.backMatter.readingGroupGuide?.length ?? 0) > 0 && (
                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Reading Group Guide ({completedManifest.backMatter.readingGroupGuide.length} chapters)
                    </label>
                    <div className="space-y-3 max-h-64 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2">
                      {completedManifest.backMatter.readingGroupGuide.map((chapter, i) => (
                        <div key={i} className="border-b border-slate-800/60 pb-3 last:border-0 last:pb-0">
                          <p className="text-xs font-semibold text-slate-300 mb-1">
                            Ch {chapter.chapterNumber}: {chapter.chapterTitle}
                          </p>
                          <ol className="list-decimal list-inside space-y-1">
                            {chapter.questions.map((q, qi) => (
                              <li key={qi} className="text-xs text-slate-400">{q}</li>
                            ))}
                          </ol>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Scripture Index */}
                {(completedManifest.backMatter.scriptureIndex?.length ?? 0) > 0 && (
                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      Scripture Index ({completedManifest.backMatter.scriptureIndex.length} references)
                    </label>
                    <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 space-y-1">
                      {completedManifest.backMatter.scriptureIndex.map((entry, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className="font-semibold text-slate-300 shrink-0">{entry.reference}</span>
                          <span className="text-slate-500">({entry.translation})</span>
                          <span className="text-slate-600 ml-auto shrink-0">Ch. {entry.chapters.join(", ")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Audit Results */}
            {(auditReport || auditRunning) && (
              <div className="border-t border-slate-700/40 pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold uppercase tracking-widest text-amber-300">Audit Results</p>
                  {auditRunning && (
                    <span className="text-[10px] text-slate-500 animate-pulse">Analysing manuscript…</span>
                  )}
                  {auditReport && !auditRunning && (
                    <button
                      type="button"
                      onClick={() => void runAudit()}
                      className="text-[10px] text-slate-500 underline min-h-[44px] px-1"
                    >
                      Re-run
                    </button>
                  )}
                </div>
                {auditReport && (
                  <AuditPanel
                    report={auditReport}
                    onApplyToManuscript={(keys) => void applyAuditToManuscript(keys)}
                    applyingAudit={applyingAudit}
                  />
                )}
              </div>
            )}

            {/* Chapter Cards — inside Final Review so everything is co-located */}
            {chapters.length > 0 && (
              <div className="border-t border-slate-700/40 pt-4 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Chapters</p>
                {chapters.map((ch) => (
                  <ChapterCard
                    key={ch.number}
                    chapter={ch}
                    editable
                    onChange={(next) => {
                      updateCompletedManifest((current) => ({
                        ...current,
                        chapters: current.chapters.map((chapter) => (chapter.number === next.number ? next : chapter)),
                      }));
                    }}
                  />
                ))}
              </div>
            )}

            {/* Voice Studio — audiobook narration */}
            <VoiceStudio manifest={completedManifest} slug={completedManifest.jobId} />

            </>
            )}

            {reviewTab === "source-map" && (
              <>
                <div className="rounded-xl border border-slate-700/40 bg-slate-900/45 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-300">
                      Source Map fallback tools
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={downloadSourceMap}
                        className="min-h-[48px] rounded-xl border border-violet-400/35 bg-violet-500/10 px-3 py-2 text-sm font-semibold text-violet-100"
                      >
                        Download Source Map
                      </button>
                      <button
                        type="button"
                        onClick={() => sourceMapImportRef.current?.click()}
                        className="min-h-[48px] rounded-xl border border-cyan-400/35 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100"
                      >
                        Upload Source Map
                      </button>
                      <input
                        ref={sourceMapImportRef}
                        type="file"
                        accept="application/json,.json"
                        className="sr-only"
                        onChange={(event) => {
                          void handleSourceMapUpload(event);
                        }}
                      />
                    </div>
                  </div>
                </div>

                <TranscriptSourceMapPanel
                  chapters={chapters}
                  sectionAssignments={sectionAssignments}
                  transcriptEntries={sourceTranscripts}
                  authorConfig={{ instructions: authorInstructions, targetAudience }}
                  onSectionBodyChange={(chapterNumber, sectionNumber, body) => {
                    updateCompletedManifest((current) => ({
                      ...current,
                      chapters: current.chapters.map((chapter) => {
                        if (chapter.number !== chapterNumber) return chapter;
                        return {
                          ...chapter,
                          sections: chapter.sections.map((section) => (
                            section.sectionNumber === sectionNumber
                              ? { ...section, body, wordCount: countWords(body) }
                              : section
                          )),
                        };
                      }),
                    }));
                    void persistSourceMapState(sectionAssignments);
                  }}
                />
              </>
            )}

            {/* Audio Sources Tab */}
            {reviewTab === "audio-sources" && (
              <>
                <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-widest text-amber-300 mb-1">Audio Source Management</p>
                  <p className="text-xs text-slate-300">
                    Upload new transcripts or regenerate manuscript sections from individual audio sources.
                  </p>
                </div>

                <AudioSourceManager
                  audioSources={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => {
                    const label = `Slot-${i + 1}`;
                    const sourceId = `audio-${i + 1}` as `audio-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
                    const transcript = sourceTranscripts.find((t) => t.label === label);
                    
                    // Count sections assigned to this source - check both segment IDs and source audio
                    const assignedSectionCount = sectionAssignments.filter((assignment) => {
                      // Check if any segment IDs reference this source
                      const hasSourceInSegments = (assignment.sourceSegmentIds ?? []).some((segId) => {
                        return segId.includes(sourceId) || segId.startsWith(`${sourceId}-`);
                      });
                      
                      // Also check transcript excerpts - if this slot has a transcript and the assignment uses it
                      const hasTranscriptMatch = transcript?.text && 
                        (assignment.transcriptExcerpts ?? []).some((excerpt) => 
                          excerpt && transcript.text.includes(excerpt.slice(0, 100))
                        );
                      
                      return hasSourceInSegments || hasTranscriptMatch;
                    }).length;
                    
                    return {
                      slot: i,
                      label,
                      audioFile: audioFiles[i],
                      transcriptFile: transcriptFiles[i],
                      currentTranscript: transcript?.text ?? "",
                      status: audioSourceStatuses[i],
                      wordCount: countWords(transcript?.text ?? ""),
                      assignedSectionCount,
                    };
                  })}
                  onRegenerateSource={handleRegenerateSource}
                  onTranscriptEdit={handleTranscriptEdit}
                  onRemoveSource={handleRemoveSource}
                />
              </>
            )}

            {/* Start new project */}
            <div className="border-t border-slate-700/40 pt-3 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setStage("idle");
                  setChapters([]);
                  setLog([]);
                  logRef.current = [];
                  setExportUrls(null);
                  setCompletedManifest(null);
                  setTotalWords(0);
                  setProgress({ total: 0, completed: 0 });
                  setSectionAssignments([]);
                  setSourceTranscripts([]);
                  setReviewTab("manuscript");
                  jobIdRef.current = newJobId();
                  autoDownloadedRef.current = false;
                  localStorage.removeItem(JOB_STORAGE_KEY);
                  localStorage.removeItem(JOB_STATE_KEY);
                }}
                className="text-xs text-slate-500 underline min-h-[44px] px-2"
              >
                Start new project
              </button>
            </div>
          </div>
          </ProseToolbarProvider>
        )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3 space-y-3">
          <div>
            <p className="text-xs font-semibold text-red-400 mb-1">Pipeline Error</p>
            <pre className="whitespace-pre-wrap break-words font-sans text-xs text-red-300/80 leading-relaxed">{error}</pre>
          </div>
          {/* Resume button — only show when we have partial data to resume from */}
          {hasResumableState && (
            <button
              type="button"
              onClick={() => {
                const saved = savedJobRef.current!;
                setError(null);
                setSignalFilterState(parseSignalFilterLog(saved.errorLog ?? []).state);
                setSignalFilterDetail(parseSignalFilterLog(saved.errorLog ?? []).detail);
                // Determine which stage to label the resume from
                const resumeStage = saved.contentMap
                  ? saved.architecture ? "writing" : "architecting"
                  : saved.voiceDNA ? "content mapping" : "voice DNA";
                addLog(`↩ Resuming from ${resumeStage}…`);
                void runPipeline(saved);
              }}
              className="w-full min-h-[48px] rounded-xl bg-gradient-to-r from-amber-500/80 to-orange-500/80 text-white font-semibold text-sm active:scale-[0.98] transition-all"
            >
              {(() => {
                const saved = savedJobRef.current!;
                if (!saved.voiceDNA) return "Resume — retry from Voice DNA";
                if (!saved.contentMap) return "Resume — retry from Content Map";
                if (!saved.architecture) return "Resume — retry from Chapter Design";
                if (saved.sectionAssignments.length === 0) return "Resume — retry from Assign Segments";
                if (saved.sections.length < (saved.sectionAssignments.length || 1)) return `Resume — continue writing (${saved.sections.length} / ${saved.sectionAssignments.length} sections done)`;
                if (!saved.frontMatter) return "Resume — retry from Front Matter";
                return "Resume pipeline";
              })()}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setStage("idle");
              setError(null);
              setReviewTab("manuscript");
              setSignalFilterState("idle");
              setSignalFilterDetail(null);
              setChapters([]);
              setSectionAssignments([]);
              setSourceTranscripts([]);
              setLog([]);
              logRef.current = [];
              setExportUrls(null);
              setCompletedManifest(null);
              setTotalWords(0);
              setProgress({ total: 0, completed: 0 });
              savedJobRef.current = null;
              jobIdRef.current = newJobId();
              autoDownloadedRef.current = false;
              localStorage.removeItem(JOB_STORAGE_KEY);
              localStorage.removeItem(JOB_STATE_KEY);
            }}
            className="text-xs text-slate-500 underline min-h-[44px] flex items-center"
          >
            Start over (discard progress)
          </button>
        </div>
      )}

      {/* Download Buttons */}
      {exportUrls && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/6 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-emerald-400 uppercase tracking-widest">
              Your Ebook Is Ready
            </p>
            <span className="text-[10px] text-slate-500">PDF auto-downloaded</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            {exportUrls.pdfUrl && (
              <a
                href={exportUrls.pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                download
                className="flex-1 min-h-[52px] flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-white font-semibold text-sm hover:opacity-90 active:scale-[0.98] transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <path d="M12 17V3M5 10l7 7 7-7M3 20h18" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download PDF
              </a>
            )}
            {exportUrls.epubUrl && (
              <a
                href={exportUrls.epubUrl}
                target="_blank"
                rel="noopener noreferrer"
                download
                className="flex-1 min-h-[52px] flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-violet-600 text-white font-semibold text-sm hover:opacity-90 active:scale-[0.98] transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <path d="M12 17V3M5 10l7 7 7-7M3 20h18" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download EPUB
              </a>
            )}
            {exportUrls.docxUrl && (
              <a
                href={exportUrls.docxUrl}
                target="_blank"
                rel="noopener noreferrer"
                download
                className="flex-1 min-h-[52px] flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-sky-600 text-white font-semibold text-sm hover:opacity-90 active:scale-[0.98] transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                  <path d="M12 17V3M5 10l7 7 7-7M3 20h18" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download Word
              </a>
            )}
          </div>
          {/* Project File backup — lets user save full structured manifest locally */}
          {completedManifest && (
            <button
              type="button"
              onClick={() => {
                const slug = completedManifest.bookTitle.replace(/\s+/g, "-").toLowerCase().slice(0, 60);
                const blob = new Blob([JSON.stringify(completedManifest, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${slug}-project.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 2000);
              }}
              className="w-full min-h-[48px] flex items-center justify-center gap-2 rounded-xl border border-slate-600/50 bg-slate-800/60 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-slate-100 active:scale-[0.98] transition-all"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 flex-shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points="14,2 14,8 20,8" />
                <line x1="12" y1="18" x2="12" y2="12" strokeLinecap="round" />
                <polyline points="9,15 12,18 15,15" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Save Project File (.json)
            </button>
          )}
        </div>
      )}

      {/* Chapter Cards — live updates during writing (before manifest is ready) */}
      {chapters.length > 0 && !completedManifest && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest px-1">
            Chapters ({chapters.length})
          </p>
          {chapters.map((ch) => (
            <ChapterCard
              key={ch.number}
              chapter={ch}
              editable={false}
            />
          ))}
        </div>
      )}

      {/* Agent Activity Log */}
      {log.length > 0 && (
        <AgentActivityLog entries={log} isRunning={isRunning} />
      )}
    </div>
  );
}
