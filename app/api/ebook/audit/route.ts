import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { z } from "zod";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest, VoiceDNA } from "@/lib/schemas/ebook";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","up","as",
  "is","are","was","were","be","been","being","have","has","had","do","does","did","will","would",
  "could","should","may","might","shall","that","this","these","those","it","its","he","she","they",
  "we","you","i","me","him","her","them","us","my","our","your","his","their",
  "not","no","so","if","then","when","there","where","what","which","who","how","why",
  "all","any","both","each","few","more","most","other","some","such","than","too","very",
  "can","just","into","over","after","before","about","through","during","without","also",
  "one","two","three","four","five","even","only","still","already","now","new","well","get",
  "like","said","say","know","want","need","make","made","see","let","here","think","going",
]);

// ── Shared types ──────────────────────────────────────────────────────────────

export type SegmentMeta = {
  id: string;
  chapterNumber: number;
  sectionNumber: number | null;
  location: string;
  text: string;
};

export type ConceptDuplicate = {
  type: "example" | "argument" | "concept" | "story" | "illustration" | "passage";
  title: string;           // brief label, e.g. "Prodigal Son illustration"
  description: string;     // what specifically is duplicated
  severity: "minor" | "major";
  locations: Array<{ location: string; excerpt: string }>;
  recommendation: string;
};

export type SimilarPair = {
  locationA: string;
  locationB: string;
  similarity: number;
  excerptA: string;
  excerptB: string;
};

export type RepetitionOccurrence = {
  chapterNumber: number;
  sectionNumber: number | null;
  location: string;
  context: string;
};

export type RepetitionEntry = {
  phrase: string;
  count: number;
  occurrences: RepetitionOccurrence[];
  reason: string | null;
  alternatives: string[];
};

export type OverusedWord = {
  word: string;
  count: number;
  frequency: string;
  alternatives: string[];
};

// ── Upgrade 4: Style bible violation ─────────────────────────────────────────
export type StyleViolation = {
  location: string;
  ruleType: "em-dash" | "forbidden-phrase" | "avoid-word";
  match: string;
  context: string;
  suggestion: string;
};

// ── Upgrade 5: Scripture issue ────────────────────────────────────────────────
export type ScriptureIssue = {
  location: string;
  issueType: "missing-translation" | "malformed-reference" | "duplicate-full-quote" | "inconsistent-format";
  reference: string;
  excerpt: string;
  recommendation: string;
};

// ── Upgrade 6: Readability metrics ───────────────────────────────────────────
export type SectionPacingNote = {
  location: string;
  wordCount: number;
  fleschGrade: number;
  avgSentenceLength: number;
  flag: "over-complex" | "under-developed" | "ok";
};

export type ReadabilityMetrics = {
  overallFleschGrade: number;
  overallAvgSentenceLength: number;
  sections: SectionPacingNote[];
};

export type AuditReport = {
  conceptDuplicates: ConceptDuplicate[];
  similarPairs: SimilarPair[];
  repetitions: RepetitionEntry[];
  overusedWords: OverusedWord[];
  styleViolations: StyleViolation[];
  scriptureIssues: ScriptureIssue[];
  readabilityMetrics: ReadabilityMetrics;
  totalConceptDuplicates: number;
  totalSimilarPairs: number;
  totalRepetitionPhrases: number;
  totalOverusedWords: number;
  totalStyleViolations: number;
  totalScriptureIssues: number;
  // Upgrade 9: cross-chapter contradiction detection
  contradictions: ContradictionIssue[];
  totalContradictions: number;
  // Upgrade 8: passive voice count aggregated across all sections
  totalPassiveVoiceHits: number;
};

// ── Upgrade 9: Cross-chapter contradiction type ───────────────────────────────
export type ContradictionIssue = {
  type: "factual" | "theological" | "instructional" | "tonal";
  description: string;       // What specifically contradicts what
  locationA: string;         // e.g. "Ch 2 §1: Heading"
  excerptA: string;          // 60-100 word excerpt showing claim A
  locationB: string;         // e.g. "Ch 7 §3: Heading"
  excerptB: string;          // 60-100 word excerpt showing claim B
  severity: "minor" | "major";
  recommendation: string;    // Concrete editorial fix
};

// ── Segment extraction ────────────────────────────────────────────────────────

function extractSegments(manifest: EbookManifest): SegmentMeta[] {
  const segs: SegmentMeta[] = [];
  let id = 0;

  const frontFields = [
    { label: "Preface", text: manifest.frontMatter.preface ?? "" },
    { label: "Introduction", text: manifest.frontMatter.introduction ?? "" },
    { label: "Conclusion", text: manifest.frontMatter.conclusion ?? "" },
  ];
  for (const f of frontFields) {
    if (f.text.trim().length > 80) {
      segs.push({ id: `fm-${id++}`, chapterNumber: 0, sectionNumber: null, location: `Front Matter – ${f.label}`, text: f.text });
    }
  }

  for (const chapter of manifest.chapters) {
    if (chapter.intro?.trim().length ?? 0 > 80) {
      segs.push({ id: `c${chapter.number}-intro`, chapterNumber: chapter.number, sectionNumber: null, location: `Ch ${chapter.number} intro`, text: chapter.intro! });
    }
    for (const section of chapter.sections) {
      if ((section.body?.trim().length ?? 0) > 80) {
        segs.push({
          id: `c${chapter.number}-s${section.sectionNumber}`,
          chapterNumber: chapter.number,
          sectionNumber: section.sectionNumber,
          location: `Ch ${chapter.number} § ${section.sectionNumber}: ${section.heading}`,
          text: section.body!,
        });
      }
    }
    if (chapter.conclusion?.trim().length ?? 0 > 80) {
      segs.push({ id: `c${chapter.number}-conc`, chapterNumber: chapter.number, sectionNumber: null, location: `Ch ${chapter.number} conclusion`, text: chapter.conclusion! });
    }
  }

  return segs;
}

// ── TF-IDF sparse vectors ─────────────────────────────────────────────────────

type SparseVec = Map<string, number>;

function tokenizeContent(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function buildTfidfVectors(segments: SegmentMeta[]): SparseVec[] {
  const N = segments.length;
  const tokenized = segments.map((s) => tokenizeContent(s.text));

  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  return tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec: SparseVec = new Map();
    for (const [term, count] of tf) {
      const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      vec.set(term, (count / Math.max(1, tokens.length)) * idf);
    }
    return vec;
  });
}

function cosineSparse(a: SparseVec, b: SparseVec): number {
  let dot = 0, normA = 0, normB = 0;
  for (const [term, val] of a) {
    dot += val * (b.get(term) ?? 0);
    normA += val * val;
  }
  for (const [, val] of b) normB += val * val;
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ── Pairwise similarity scan ──────────────────────────────────────────────────
// Flags cross-chapter pairs above threshold as structurally similar segments.

function findSimilarPairs(segments: SegmentMeta[], vectors: SparseVec[]): SimilarPair[] {
  const pairs: SimilarPair[] = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i];
      const b = segments[j];

      // Only flag cross-chapter pairs (intra-chapter similarity is expected)
      const isCrossChapter = a.chapterNumber !== b.chapterNumber;
      const threshold = isCrossChapter ? 0.32 : 0.55;

      const score = cosineSparse(vectors[i], vectors[j]);
      if (score < threshold) continue;

      const excerptA = a.text.trim().slice(0, 160) + (a.text.length > 160 ? "…" : "");
      const excerptB = b.text.trim().slice(0, 160) + (b.text.length > 160 ? "…" : "");
      pairs.push({ locationA: a.location, locationB: b.location, similarity: Math.round(score * 100) / 100, excerptA, excerptB });
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity).slice(0, 16);
}

// ── N-gram lexical repetition ─────────────────────────────────────────────────

function extractNgrams(text: string, n: number): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    const gram = words.slice(i, i + n);
    if (gram.filter((w) => !STOP_WORDS.has(w)).length < Math.ceil(n / 2)) continue;
    ngrams.push(gram.join(" "));
  }
  return ngrams;
}

function findLexicalRepetitions(segments: SegmentMeta[]): Omit<RepetitionEntry, "reason" | "alternatives">[] {
  const phraseMap = new Map<string, { count: number; occurrences: RepetitionOccurrence[] }>();

  for (const seg of segments) {
    const seen = new Set<string>();
    for (const phrase of [...extractNgrams(seg.text, 3), ...extractNgrams(seg.text, 4), ...extractNgrams(seg.text, 5)]) {
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      const sentences = seg.text.split(/(?<=[.!?])\s+/);
      const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const match = sentences.find((s) => re.test(s)) ?? "";
      const context = match.length > 130 ? match.slice(0, 127) + "…" : match;
      if (!phraseMap.has(phrase)) phraseMap.set(phrase, { count: 0, occurrences: [] });
      const entry = phraseMap.get(phrase)!;
      entry.count++;
      entry.occurrences.push({ chapterNumber: seg.chapterNumber, sectionNumber: seg.sectionNumber, location: seg.location, context });
    }
  }

  return Array.from(phraseMap.entries())
    .filter(([, v]) => v.count >= 2)
    .map(([phrase, v]) => ({ phrase, count: v.count, occurrences: v.occurrences }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

// ── Overused words ────────────────────────────────────────────────────────────

function findOverusedWords(manifest: EbookManifest): Omit<OverusedWord, "alternatives">[] {
  const total = manifest.totalWordCount || 1;
  const fullText = [
    manifest.frontMatter.preface ?? "",
    manifest.frontMatter.introduction ?? "",
    manifest.frontMatter.conclusion ?? "",
    ...manifest.chapters.flatMap((c) => [c.intro ?? "", ...c.sections.map((s) => s.body ?? ""), c.conclusion ?? ""]),
  ].join(" ");

  const counts = new Map<string, number>();
  for (const w of fullText.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)) {
    if (w.length > 4 && !STOP_WORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  const threshold = Math.max(8, Math.floor(total * 0.005));
  return Array.from(counts.entries())
    .filter(([, c]) => c >= threshold)
    .map(([word, count]) => ({ word, count, frequency: `${((count / total) * 100).toFixed(2)}%` }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ── Upgrade 4: Style Bible enforcement scan ─────────────────────────────────
// Deterministic pass: flags every em dash, forbidden editorial phrase, and
// author-specific avoidWord hit with exact location + surrounding context.

const STYLE_FORBIDDEN_PATTERNS: Array<{ source: string; flags: string; suggestion: string }> = [
  { source: "\u2014", flags: "g", suggestion: "Replace em dash with comma, colon, semicolon, or subordinate clause" },
  { source: " -- ", flags: "g", suggestion: "Replace spaced double-hyphen em dash with comma, colon, or semicolon" },
  { source: "\\bin conclusion\\b", flags: "gi", suggestion: "Remove \u2014 land the point directly" },
  { source: "\\bdelve[sd]?\\s+into\\b", flags: "gi", suggestion: "Use 'examine', 'explore', or 'address'" },
  { source: "\\ba tapestry of\\b", flags: "gi", suggestion: "Be specific \u2014 name what it is" },
  { source: "\\bnavigating (the )?(landscape|world|challenges|complexities|waters)\\b", flags: "gi", suggestion: "Rewrite with a concrete verb" },
  { source: "\\bit'?s important to note\\b", flags: "gi", suggestion: "Delete \u2014 the note speaks for itself" },
  { source: "\\bit is crucial (to|that)\\b", flags: "gi", suggestion: "Cut the throat-clearing; make the point" },
  { source: "\\bin today'?s fast-?paced world\\b", flags: "gi", suggestion: "Delete entirely" },
  { source: "\\bfurthermore[,.]?\\s", flags: "gi", suggestion: "Cut or restructure without a connector" },
  { source: "\\bmoreover[,.]?\\s", flags: "gi", suggestion: "Cut or restructure without a connector" },
  { source: "\\bit is worth noting\\b", flags: "gi", suggestion: "Delete \u2014 just say the thing" },
  { source: "\\bat the end of the day\\b", flags: "gi", suggestion: "Delete \u2014 land the actual point" },
  { source: "\\bgame[-\\s]?changer\\b", flags: "gi", suggestion: "Use a concrete description of the change" },
  { source: "\\bparadigm shift\\b", flags: "gi", suggestion: "Name the actual shift" },
  { source: "\\bdeep dive\\b", flags: "gi", suggestion: "Use 'close examination' or begin examining" },
  { source: "\\bunpack(s|ed|ing)?\\b", flags: "gi", suggestion: "Use 'explain', 'examine', 'break down'" },
  { source: "\\bmoving forward\\b", flags: "gi", suggestion: "Delete or state the next action directly" },
  { source: "\\brobust\\b", flags: "gi", suggestion: "Use 'thorough', 'complete', 'detailed'" },
  { source: "\\bleverag(e|es|ed|ing)\\b", flags: "gi", suggestion: "Use 'use', 'apply', 'draw on'" },
  { source: "\\bsynergy\\b", flags: "gi", suggestion: "Describe the actual relationship" },
  { source: "\\bit goes without saying\\b", flags: "gi", suggestion: "Delete \u2014 if it goes without saying, don't say it" },
  { source: "\\bthe truth is[,.]?\\s", flags: "gi", suggestion: "Delete the throat-clearing; state the truth" },
  { source: "\\bthe fact of the matter is\\b", flags: "gi", suggestion: "Delete \u2014 state the fact directly" },
  { source: "\\bindeed[,.]?\\s", flags: "gi", suggestion: "Delete \u2014 adds nothing" },
  { source: "\\bcertainly[,.]?\\s", flags: "gi", suggestion: "Delete \u2014 reads robotic" },
  { source: "\\bultimately[,.]?\\s", flags: "gi", suggestion: "Delete or rewrite without it" },
  { source: "\\bat its core[,.]?\\s", flags: "gi", suggestion: "State the core directly" },
  { source: "\\bin essence[,.]?\\s", flags: "gi", suggestion: "Delete \u2014 state the essence directly" },
  { source: "\\bsimply put[,.]?\\s", flags: "gi", suggestion: "Delete \u2014 the simplicity should be in the writing" },
  { source: "\\bnot just\\b.{1,60}?\\bbut\\b", flags: "gi", suggestion: "Rewrite: avoid 'not just\u2026but' frame" },
  { source: "\\bnot merely\\b.{1,60}?\\bbut\\b", flags: "gi", suggestion: "Rewrite: avoid 'not merely\u2026but' frame" },
  { source: "\\bthis is not merely\\b", flags: "gi", suggestion: "Rewrite: avoid 'this is not merely' frame" },
  { source: "\\bprofoundly\\b", flags: "gi", suggestion: "Show the depth; delete the label" },
  { source: "\\bdeeply meaningful\\b", flags: "gi", suggestion: "Show the meaning; delete the label" },
  { source: "\\btransformative\\b", flags: "gi", suggestion: "Describe the actual transformation" },
  { source: "\\bvibrant\\b", flags: "gi", suggestion: "Use a specific, concrete adjective" },
  { source: "\\bfostering\\b", flags: "gi", suggestion: "Use 'building', 'creating', 'developing'" },
  { source: "\\bthis means that\\b", flags: "gi", suggestion: "Land the implication directly" },
  { source: "\\bwhat this tells us is\\b", flags: "gi", suggestion: "State the lesson directly" },
  { source: "\\bso,? as we have seen\\b", flags: "gi", suggestion: "Delete mid-chapter summary transitions" },
  { source: "\\bto summarize\\b", flags: "gi", suggestion: "Delete \u2014 do not summarize mid-chapter" },
];

function styleBibleScan(
  segments: SegmentMeta[],
  voiceDNA?: VoiceDNA,
): StyleViolation[] {
  const violations: StyleViolation[] = [];

  for (const seg of segments) {
    const { text, location } = seg;
    const sentences = text.split(/(?<=[.!?])\s+/);

    function getContext(matchStart: number): string {
      let best = "";
      let bestDist = Infinity;
      for (const s of sentences) {
        const idx = text.indexOf(s);
        if (idx >= 0 && idx <= matchStart) {
          const dist = matchStart - idx;
          if (dist < bestDist) { bestDist = dist; best = s; }
        }
      }
      return best.slice(0, 120) + (best.length > 120 ? "\u2026" : "");
    }

    // ── Editorial forbidden patterns ───────────────────────────────────────
    for (const pat of STYLE_FORBIDDEN_PATTERNS) {
      const isEmDash = pat.suggestion.startsWith("Replace em dash") || pat.suggestion.startsWith("Replace spaced");
      const ruleType: StyleViolation["ruleType"] = isEmDash ? "em-dash" : "forbidden-phrase";
      const re = new RegExp(pat.source, pat.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        violations.push({ location, ruleType, match: m[0].trim(), context: getContext(m.index), suggestion: pat.suggestion });
      }
    }

    // ── Voice DNA: author-specific avoidWords (skip baseline clichés already covered) ──
    const authorSpecificAvoid = (voiceDNA?.avoidWords ?? []).slice(30);
    for (const word of authorSpecificAvoid) {
      if (word.length < 3) continue;
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = word.includes(" ")
        ? new RegExp(escaped, "gi")
        : new RegExp(`\\b${escaped}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        violations.push({
          location,
          ruleType: "avoid-word",
          match: m[0],
          context: getContext(m.index),
          suggestion: `"${word}" is in the author's voice DNA avoidWords \u2014 rewrite without it`,
        });
      }
    }
  }

  return violations;
}

// ── Upgrade 6: Readability + pacing metrics ───────────────────────────────────

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const reduced = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  const groups = reduced.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

function fleschKincaidGrade(text: string): { grade: number; avgSentenceLength: number } {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  const words = text.split(/\s+/).filter((w) => w.replace(/[^a-zA-Z]/g, "").length > 0);
  if (sentences.length === 0 || words.length === 0) return { grade: 0, avgSentenceLength: 0 };
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const asl = words.length / sentences.length;
  const asw = syllables / words.length;
  return {
    grade: Math.max(0, Math.round((0.39 * asl + 11.8 * asw - 15.59) * 10) / 10),
    avgSentenceLength: Math.round(asl * 10) / 10,
  };
}

function computeReadabilityMetrics(segments: SegmentMeta[]): ReadabilityMetrics {
  const sectionNotes: SectionPacingNote[] = [];
  const allTexts: string[] = [];

  for (const seg of segments) {
    const { grade, avgSentenceLength } = fleschKincaidGrade(seg.text);
    const wordCount = seg.text.split(/\s+/).filter(Boolean).length;
    let flag: SectionPacingNote["flag"] = "ok";
    if (grade > 14 || avgSentenceLength > 32) flag = "over-complex";
    else if (wordCount < 80) flag = "under-developed";
    sectionNotes.push({ location: seg.location, wordCount, fleschGrade: grade, avgSentenceLength, flag });
    allTexts.push(seg.text);
  }

  const overall = fleschKincaidGrade(allTexts.join(" "));
  return {
    overallFleschGrade: overall.grade,
    overallAvgSentenceLength: overall.avgSentenceLength,
    sections: sectionNotes,
  };
}

// ── Upgrade 5: Scripture & reference consistency audit ────────────────────────
// LLM pass: cross-checks every scripture quote for missing translation labels,
// malformed references, duplicate full quotes, and format inconsistency.

async function runScriptureAudit(segments: SegmentMeta[]): Promise<ScriptureIssue[]> {
  const scriptureRe = /[A-Z][a-z]+\s+\d+:\d+|(?:NIV|KJV|ESV|NKJV|NLT|NASB|AMP|MSG|translation unspecified)/;
  const relevant = segments.filter((s) => scriptureRe.test(s.text));
  if (relevant.length === 0) return [];

  const index = relevant
    .map((s) => `[${s.location}]\n${s.text.trim().slice(0, 600)}${s.text.length > 600 ? "\u2026" : ""}`)
    .join("\n\n---\n\n");

  try {
    const { text } = await generateText({
      model: deepSeekReasonerModel,
      maxTokens: 4096,
      prompt: `You are a manuscript editor specializing in scripture citation accuracy. Review the passages below and identify ONLY genuine issues:

1. MISSING TRANSLATION: A scripture is quoted with a Bible reference but no translation label (NIV, KJV, ESV, NKJV, NLT, NASB, AMP, MSG, etc.)
2. MALFORMED REFERENCE: A Bible reference with missing verse number, missing space, or non-standard format (e.g. "John3:16" or "John 3" without a verse)
3. DUPLICATE FULL QUOTE: The exact same scripture verse text is quoted in full in more than one location — only the reference should appear after first use
4. INCONSISTENT FORMAT: The same scripture appears as inline in one place and as a blockquote in another

PASSAGES:
${index}

Return ONLY valid JSON — no markdown fences, no commentary:
{
  "issues": [
    {
      "location": "exact location label from input",
      "issueType": "missing-translation|malformed-reference|duplicate-full-quote|inconsistent-format",
      "reference": "the scripture reference e.g. John 3:16",
      "excerpt": "40-80 word excerpt showing the issue",
      "recommendation": "specific editorial fix"
    }
  ]
}`,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { issues?: ScriptureIssue[] };
    return Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch {
    return [];
  }
}

// ── LLM: semantic concept duplicate analysis ──────────────────────────────────
// This is the core new capability: the LLM reads ALL section summaries and
// identifies conceptually duplicated content regardless of surface wording.

async function runSemanticAudit(
  segments: SegmentMeta[],
  similarPairs: SimilarPair[],
  lexicalRepetitions: Omit<RepetitionEntry, "reason" | "alternatives">[],
  overusedWords: Omit<OverusedWord, "alternatives">[]
): Promise<{
  conceptDuplicates: ConceptDuplicate[];
  phraseAmendments: Array<{ phrase: string; reason: string; alternatives: string[] }>;
  wordAmendments: Array<{ word: string; alternatives: string[] }>;
}> {
  // Build a compact section index for the LLM — location label + first 280 chars
  const sectionIndex = segments
    .map((s, i) => `[${i + 1}] ${s.location}\n${s.text.trim().slice(0, 300)}${s.text.length > 300 ? "…" : ""}`)
    .join("\n\n");

  // Summarise algorithmically flagged pairs so the LLM knows where to look
  const flaggedPairsText = similarPairs.length > 0
    ? similarPairs
        .slice(0, 6)
        .map((p) => `• ${p.locationA} ↔ ${p.locationB} (similarity ${Math.round(p.similarity * 100)}%)`)
        .join("\n")
    : "None detected algorithmically.";

  const lexicalText = lexicalRepetitions.slice(0, 10).map((r) => `"${r.phrase}" ×${r.count}`).join(", ");
  const wordText = overusedWords.slice(0, 8).map((w) => `"${w.word}" (${w.frequency})`).join(", ");

  const prompt = `You are a senior developmental editor auditing a book manuscript.
Your job is to identify CONCEPTUAL duplication — the same idea, example, story, illustration, argument, or passage appearing more than once across different sections, even when worded differently.

═══ SECTION INDEX (location + opening text) ═══
${sectionIndex}

═══ ALGORITHMICALLY FLAGGED SIMILAR PAIRS ═══
${flaggedPairsText}

═══ REPEATED PHRASES (surface-level) ═══
${lexicalText || "None"}

═══ OVERUSED WORDS ═══
${wordText || "None"}

SECTION TYPE RULES — apply these when deciding recommendations:
- BODY SECTIONS (location format "Ch X § Y: Heading") are the PRIMARY HOME for a concept. When a concept is fully developed in a body section, that section is PROTECTED — do not recommend cutting it.
- FRAME SECTIONS ("Front Matter – Introduction", "Front Matter – Conclusion", "Ch N intro", "Ch N conclusion") must only briefly mention/summarise a concept — they are NOT the place for full development. If a frame section duplicates content that already has a full treatment in a body section, the frame section is the CUT TARGET, not the body section.
- When a concept appears in both a body section and a frame section, the recommendation must always be: trim the frame section to a one-sentence mention and keep the body section intact.

Your tasks:
1. CONCEPT DUPLICATES: Identify every case where the same concept, example, story, illustration, argument, or extended passage appears in multiple sections. Be specific — name the example/concept. Flag both MINOR duplicates (a point briefly touched twice) and MAJOR ones (a full example or teaching repeated). Apply the SECTION TYPE RULES above to all recommendations.
2. PHRASE AMENDMENTS: For each repeated surface phrase above, give a short editorial reason + 2–3 rewrite alternatives.
3. WORD AMENDMENTS: For each overused word, give 2–3 precise alternatives.

Respond ONLY with valid JSON (no markdown fences, no commentary outside the JSON):
{
  "conceptDuplicates": [
    {
      "type": "example|argument|concept|story|illustration|passage",
      "title": "Brief label (e.g. 'The shepherd and lost sheep')",
      "description": "What specifically is duplicated and why it hurts the reader experience",
      "severity": "minor|major",
      "locations": [
        { "location": "Ch X § Y: Heading", "excerpt": "40-80 word excerpt showing the duplication" }
      ],
      "recommendation": "Concrete editorial action — e.g. keep in Ch 3, cut from Ch 6; or merge into one definitive treatment in Ch 4"
    }
  ],
  "phraseAmendments": [
    { "phrase": "...", "reason": "...", "alternatives": ["...", "..."] }
  ],
  "wordAmendments": [
    { "word": "...", "alternatives": ["...", "..."] }
  ]
}`;

  try {
    const { text } = await generateText({ model: deepSeekReasonerModel, prompt, maxTokens: 12000 });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { conceptDuplicates: [], phraseAmendments: [], wordAmendments: [] };
    return JSON.parse(jsonMatch[0]) as {
      conceptDuplicates: ConceptDuplicate[];
      phraseAmendments: Array<{ phrase: string; reason: string; alternatives: string[] }>;
      wordAmendments: Array<{ word: string; alternatives: string[] }>;
    };
  } catch {
    return { conceptDuplicates: [], phraseAmendments: [], wordAmendments: [] };
  }
}

// ── Upgrade 9: Cross-chapter contradiction detection ─────────────────────────
// Extracts key claims from each chapter and asks the LLM to identify cases where
// one chapter's assertion directly conflicts with another chapter's assertion.

async function runContradictionAudit(segments: SegmentMeta[]): Promise<ContradictionIssue[]> {
  // Only cross-chapter — group by chapter and take the most content-rich sections
  const byChapter = new Map<number, SegmentMeta[]>();
  for (const seg of segments) {
    if (!byChapter.has(seg.chapterNumber)) byChapter.set(seg.chapterNumber, []);
    byChapter.get(seg.chapterNumber)!.push(seg);
  }
  if (byChapter.size < 2) return [];

  // Build a compact claim index: chapter number + opening claim sentence from each section
  const claimIndex = Array.from(byChapter.entries())
    .map(([chNum, segs]) => {
      const claims = segs.map((s) => {
        const firstSentence = s.text.split(/(?<=[.!?])\s+/).filter(Boolean)[0] ?? "";
        return `  [${s.location}]: "${firstSentence.slice(0, 160).trim()}"`;
      }).join("\n");
      return `Chapter ${chNum}:\n${claims}`;
    })
    .join("\n\n");

  try {
    const { text } = await generateText({
      model: deepSeekReasonerModel,
      maxTokens: 6000,
      prompt: `You are a developmental editor checking a multi-chapter book manuscript for logical contradictions across chapters.

A contradiction is when Chapter A asserts X and Chapter B asserts the logical opposite or a significantly incompatible claim about the same topic, scripture, principle, or instruction.

TYPES of contradictions to flag:
- FACTUAL: Ch 2 says "David wrote all the Psalms" and Ch 7 says "The Psalms were written by multiple authors."
- THEOLOGICAL: Ch 1 teaches that healing is guaranteed by faith; Ch 4 implies suffering may be God's will.
- INSTRUCTIONAL: Ch 3 says to pray before making decisions; Ch 8 says to act first and pray after.
- TONAL: Ch 2 frames a concept with urgency and warning; Ch 6 treats the same concept as optional or casual.

DO NOT flag:
- Nuance and progression (where Ch 8 builds on and qualifies Ch 2 — this is development, not contradiction).
- Different aspects of the same topic (talking about grace in Ch 2 and works in Ch 5 is not a contradiction if no direct claim conflicts).
- Repetition (same idea said twice is not a contradiction).

CHAPTER CLAIM INDEX:
${claimIndex}

Return ONLY valid JSON — no markdown fences:
{
  "contradictions": [
    {
      "type": "factual|theological|instructional|tonal",
      "description": "What specifically contradicts what — name both claims explicitly",
      "locationA": "exact location label",
      "excerptA": "40-100 word excerpt showing claim A",
      "locationB": "exact location label",
      "excerptB": "40-100 word excerpt showing claim B",
      "severity": "minor|major",
      "recommendation": "Concrete editorial fix — e.g. qualify the claim in Ch 2, or add a bridging sentence in Ch 7"
    }
  ]
}`,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { contradictions?: ContradictionIssue[] };
    return Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  } catch {
    return [];
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

const AuditRequestSchema = z.object({ manifest: EbookManifestSchema });

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = AuditRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  try {
    const { manifest } = input;
    const segments = extractSegments(manifest);

    if (segments.length < 2) {
      return NextResponse.json({ error: "Not enough content to audit — complete the pipeline first." }, { status: 422 });
    }

    // Layer 1: algorithmic pairwise TF-IDF scan
    const vectors = buildTfidfVectors(segments);
    const similarPairs = findSimilarPairs(segments, vectors);

    // Layer 2: lexical n-gram repetitions
    const lexicalRepetitions = findLexicalRepetitions(segments);

    // Layer 3: overused words
    const overusedWordsRaw = findOverusedWords(manifest);

    // Layer 4: deterministic style bible enforcement scan (Upgrade 4)
    const styleViolations = styleBibleScan(segments, manifest.voiceDNA ?? undefined);

    // Layer 5: readability + pacing metrics (Upgrade 6)
    const readabilityMetrics = computeReadabilityMetrics(segments);

    // Layer 6 + 7 + 8: LLM semantic audit, scripture audit, contradiction audit run in parallel
    const [llm, scriptureIssues, contradictions] = await Promise.all([
      runSemanticAudit(segments, similarPairs, lexicalRepetitions, overusedWordsRaw),
      runScriptureAudit(segments),
      runContradictionAudit(segments),
    ]);

    // Merge LLM amendments into lexical repetitions
    const repetitions: RepetitionEntry[] = lexicalRepetitions.map((r) => {
      const a = llm.phraseAmendments?.find((x) => x.phrase === r.phrase);
      return { ...r, reason: a?.reason ?? null, alternatives: a?.alternatives ?? [] };
    });

    const overusedWords: OverusedWord[] = overusedWordsRaw.map((w) => {
      const a = llm.wordAmendments?.find((x) => x.word === w.word);
      return { ...w, alternatives: a?.alternatives ?? [] };
    });

    const report: AuditReport = {
      conceptDuplicates: llm.conceptDuplicates ?? [],
      similarPairs,
      repetitions,
      overusedWords,
      styleViolations,
      scriptureIssues,
      readabilityMetrics,
      contradictions,
      totalConceptDuplicates: (llm.conceptDuplicates ?? []).length,
      totalSimilarPairs: similarPairs.length,
      totalRepetitionPhrases: repetitions.length,
      totalOverusedWords: overusedWords.length,
      totalStyleViolations: styleViolations.length,
      totalScriptureIssues: scriptureIssues.length,
      totalContradictions: contradictions.length,
      totalPassiveVoiceHits: 0, // populated client-side from write-section passiveVoiceCount aggregate
    };

    return NextResponse.json(report, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audit failed" },
      { status: 500 }
    );
  }
}
