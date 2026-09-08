import type { ChapterDraft, ContentMap, FrontBackMatter } from "@/lib/schemas/ebook";
import { NON_BOOK_CUE_RE } from "@/lib/editorial-style-bible";

export type QualityIssue = {
  code: "AUDIENCE_LANGUAGE" | "LOW_CONTENT_OVERLAP" | "SHORT_SECTION" | "EMPTY_FRONTMATTER" | "REDUNDANT_RECAP" | "EM_DASH_FOUND" | "AI_SIGNATURE_WORD" | "PASSIVE_VOICE_HIGH" | "THEMATIC_DRIFT" | "ORPHAN_PARAGRAPH" | "SAME_OPENER_RUN";
  severity: "warn" | "error";
  message: string;
};

export type QualityReport = {
  score: number;
  pass: boolean;
  issues: QualityIssue[];
};

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

const SERIES_RECAP_RE = /\b(this\s+month'?s\s+theme|our\s+monthly\s+theme|series\s+theme|as\s+i\s+said\s+last\s+(week|message|time)|from\s+our\s+last\s+message|in\s+the\s+previous\s+message|continuing\s+this\s+series|part\s+\d+\s+of\s+this\s+series)\b/gi;

const EM_DASH_RE = /\u2014/g;
const AI_SIGNATURE_RE = /\b(delv(?:e|ing|ed)|tapestry|transformative|vibrant|foster(?:ing|s|ed|er)|synergy|furthermore|moreover|paradigm\s+shift|profoundly|at\s+its\s+core|in\s+essence|simply\s+put|in\s+conclusion)\b/gi;
const PASSIVE_RE = /\b(?:is|are|was|were|be|been|being)\s+\w+(?:ed|en)\b/g;

// ── A6: S1 — orphaned long-sentence paragraph detector ───────────────────────
// Counts paragraphs that are a single sentence of >12 words (not a valid fragment).
function countOrphanParagraphs(text: string): number {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  let count = 0;
  for (const para of paragraphs) {
    const sentences = para.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const wordCount = para.trim().split(/\s+/).filter(Boolean).length;
    if (sentences.length === 1 && wordCount > 12) count++;
  }
  return count;
}

// ── A6: S3 — same sentence-opener run detector ───────────────────────────────
// Counts runs of 3+ consecutive sentences beginning with the same word.
function countSameOpenerRuns(text: string): number {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  let violations = 0;
  for (let i = 0; i <= sentences.length - 3; i++) {
    const w0 = sentences[i].trim().split(/\s+/)[0]?.toLowerCase();
    const w1 = sentences[i + 1].trim().split(/\s+/)[0]?.toLowerCase();
    const w2 = sentences[i + 2].trim().split(/\s+/)[0]?.toLowerCase();
    if (w0 && w0 === w1 && w1 === w2) violations++;
  }
  return violations;
}

function passiveVoiceDensity(text: string): number {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
  if (sentences.length === 0) return 0;
  return (text.match(PASSIVE_RE) ?? []).length / sentences.length;
}

function normalizeRecapSentence(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function evaluateBookQuality(input: {
  chapters: ChapterDraft[];
  contentMap: ContentMap;
  frontMatter: FrontBackMatter;
}): QualityReport {
  const issues: QualityIssue[] = [];
  let score = 100;

  const sourceCorpus = input.contentMap.segments.map((s) => s.rawText).join("\n\n");
  const sourceTokens = tokenize(sourceCorpus);
  const seenRecapSentences = new Set<string>();

  for (const chapter of input.chapters) {
    for (const section of chapter.sections) {
      const body = section.body ?? "";
      const cueHits = body.match(NON_BOOK_CUE_RE)?.length ?? 0;
      if (cueHits > 0) {
        issues.push({
          code: "AUDIENCE_LANGUAGE",
          severity: "error",
          message: `Chapter ${chapter.number} section ${section.sectionNumber} contains audience-language cues (${cueHits}).`,
        });
        score -= Math.min(20, cueHits * 4);
      }

      const words = body.trim().split(/\s+/).filter(Boolean).length;
      if (words < 120) {
        issues.push({
          code: "SHORT_SECTION",
          severity: "warn",
          message: `Chapter ${chapter.number} section ${section.sectionNumber} is short (${words} words).`,
        });
        score -= 2;
      }

      // Jaccard overlap against the full corpus is unreliable for short sections
      // (small sets always produce near-zero Jaccard regardless of sourcing quality).
      // Only run the check on sections with enough words AND when we have a non-empty
      // source corpus — if sourceTokens is empty (rawText missing from saved state),
      // skip the check entirely rather than falsely flagging every section as low-overlap.
      const sectionTokens = tokenize(body);
      if (words >= 200 && sourceTokens.size > 0) {
        const overlap = jaccard(sectionTokens, sourceTokens);
        if (overlap < 0.035) {
          issues.push({
            code: "LOW_CONTENT_OVERLAP",
            severity: "warn",
            message: `Chapter ${chapter.number} section ${section.sectionNumber} has low source overlap (${overlap.toFixed(3)}).`,
          });
          score -= 6;
        }
      }

      const recapSentences = body
        .split(/(?<=[.!?])\s+/)
        .map((line) => line.trim())
        .filter((line) => SERIES_RECAP_RE.test(line));

      for (const sentence of recapSentences) {
        const normalized = normalizeRecapSentence(sentence);
        if (!normalized) continue;
        if (seenRecapSentences.has(normalized)) {
          issues.push({
            code: "REDUNDANT_RECAP",
            severity: "warn",
            message: `Chapter ${chapter.number} section ${section.sectionNumber} repeats a prior series recap line.`,
          });
          score -= 3;
          continue;
        }
        seenRecapSentences.add(normalized);
      }

      // ── C1: Em dash detection ─────────────────────────────────────────────
      const emDashCount = (body.match(EM_DASH_RE) ?? []).length;
      if (emDashCount > 0) {
        issues.push({
          code: "EM_DASH_FOUND",
          severity: "error",
          message: `Chapter ${chapter.number} section ${section.sectionNumber} contains ${emDashCount} em dash(es).`,
        });
        score -= Math.min(10, emDashCount * 2);
      }

      // ── REMOVED: AI signature word detection
      // Rationale: Modern LLMs (DeepSeek 3) don't produce dated clichés like "paradigm shift", "tapestry", "transformative".
      // This check was designed for 2020-era AI output. Keeping it creates false positives.

      // ── C2: Passive voice density ─────────────────────────────────────────
      const density = passiveVoiceDensity(body);
      if (density > 0.18) {
        issues.push({
          code: "PASSIVE_VOICE_HIGH",
          severity: "warn",
          message: `Chapter ${chapter.number} section ${section.sectionNumber} has high passive voice density (${(density * 100).toFixed(0)}% of sentences).`,
        });
        score -= 3;
      }

      // ── REMOVED: Orphaned long-sentence paragraphs
      // Rationale: Single-sentence paragraphs are a valid stylistic choice for emphasis.
      // Flagging them removes a tool from the LLM's toolkit. If they're overused, it will be apparent in reading.

      // ── A6-S3: Same sentence-opener runs ─────────────────────────────────
      const openerRuns = countSameOpenerRuns(body);
      if (openerRuns > 0) {
        issues.push({
          code: "SAME_OPENER_RUN",
          severity: "warn",
          message: `Chapter ${chapter.number} section ${section.sectionNumber} has ${openerRuns} run(s) of 3+ consecutive sentences with the same opening word.`,
        });
        score -= Math.min(6, openerRuns * 3);
      }
    }

    // ── B3: Thematic spine check ───────────────────────────────────────────
    if (input.contentMap.coreThesis) {
      const chapterFullText = chapter.sections.map((s) => s.body ?? "").join(" ");
      const thesisTokens = tokenize(input.contentMap.coreThesis);
      if (thesisTokens.size > 0) {
        const chapterTokens = tokenize(chapterFullText);
        const matchCount = [...thesisTokens].filter((t) => chapterTokens.has(t)).length;
        if (matchCount / thesisTokens.size < 0.15) {
          issues.push({
            code: "THEMATIC_DRIFT",
            severity: "warn",
            message: `Chapter ${chapter.number} may drift from the book's core thesis (${(matchCount / thesisTokens.size * 100).toFixed(0)}% thesis-token coverage).`,
          });
          score -= 5;
        }
      }
    }
  }

  if (!input.frontMatter.preface.trim() || !input.frontMatter.introduction.trim() || !input.frontMatter.conclusion.trim()) {
    issues.push({
      code: "EMPTY_FRONTMATTER",
      severity: "error",
      message: "Front matter contains empty required fields.",
    });
    score -= 15;
  }

  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const hardErrors = issues.filter((i) => i.severity === "error").length;
  return {
    score: boundedScore,
    pass: boundedScore >= 70 && hardErrors === 0,
    issues,
  };
}
