import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { env } from "@/lib/env";
import { ArchitectRequestSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── Upgrade helpers ───────────────────────────────────────────────────────────

type ArcRole = "hook" | "context" | "mechanism" | "application" | "untagged";

// U1 — Arc scoring: classify a section heading + keyPoints into an arc role
const ARC_KEYWORDS: Record<ArcRole, string[]> = {
  hook:        ["problem", "question", "why", "challenge", "crisis", "struggle", "pain", "trap", "lie", "broken", "need", "call", "open", "begin", "what if"],
  context:     ["because", "reason", "background", "history", "context", "understand", "foundation", "basis", "root", "origin", "means", "definition", "explains"],
  mechanism:   ["how", "principle", "law", "process", "method", "key", "secret", "truth", "power", "strategy", "framework", "step", "way", "work", "operate"],
  application: ["apply", "response", "action", "do", "practice", "live", "walk", "obey", "commit", "decide", "choose", "result", "fruit", "outcome", "change", "now"],
  untagged:    [],
};

function scoreArcRole(heading: string, keyPoints: string[]): ArcRole {
  const text = [heading, ...keyPoints].join(" ").toLowerCase();
  const scores: Record<ArcRole, number> = { hook: 0, context: 0, mechanism: 0, application: 0, untagged: 0 };
  for (const [role, keywords] of Object.entries(ARC_KEYWORDS) as [ArcRole, string[]][]) {
    for (const kw of keywords) {
      if (text.includes(kw)) scores[role]++;
    }
  }
  const best = (Object.entries(scores) as [ArcRole, number][])
    .filter(([role]) => role !== "untagged")
    .sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "untagged";
}

function buildArcFlags(sections: { arcRole: ArcRole }[], chapterTitle: string): string[] {
  const flags: string[] = [];
  const roles = sections.map((s) => s.arcRole);
  if (!roles.includes("hook")) flags.push(`Ch "${chapterTitle}": no hook section — consider making the opening section more provocative`);
  if (!roles.includes("application")) flags.push(`Ch "${chapterTitle}": no application section — readers need a landing point`);
  const mechanismCount = roles.filter((r) => r === "mechanism").length;
  if (mechanismCount >= 3) flags.push(`Ch "${chapterTitle}": ${mechanismCount} consecutive mechanism sections — consider consolidating or adding application`);
  return flags;
}

// U2 — Cross-chapter section overlap: keyword token overlap between section headings
function keywordTokens(text: string): Set<string> {
  const stopWords = new Set(["a","an","the","and","or","of","in","to","for","with","by","is","are","was","were","be","it","its","this","that","these","those","on","at","as","from","up","about","how","what","which","who"]);
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stopWords.has(w))
  );
}

function sectionKeywordOverlap(a: string, b: string): number {
  const setA = keywordTokens(a);
  const setB = keywordTokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) { if (setB.has(w)) shared++; }
  return shared / Math.min(setA.size, setB.size);
}

const ARCHITECT_OVERLAP_THRESHOLD = 0.60;

// U3 — Word budget calibration: quality multiplier from segment density
function segmentQualityMultiplier(keyPointsCount: number, quotesCount: number): number {
  const density = keyPointsCount + quotesCount * 0.5;
  if (density >= 5) return 1.2;
  if (density <= 1) return 0.7;
  return 1.0;
}

// U5 — Chapter premise line: derive from keyTheme + first section heading
function deriveChapterPremise(
  chapterTitle: string,
  keyTheme: string,
  coreThesis: string,
  firstSectionHeading: string
): string {
  // Use the most specific available signal in priority order
  const theme = keyTheme.trim() || coreThesis.trim() || chapterTitle.trim();
  const hook = firstSectionHeading.trim();
  if (theme && hook && theme.toLowerCase() !== hook.toLowerCase()) {
    return `${theme}: ${hook.replace(/[.!?]+$/, "").trim()}.`;
  }
  return theme ? `${theme}.` : `${chapterTitle}.`;
}

// U7 — Series arc: find shared keyword thread between adjacent chapter conclusions and openings
function deriveBridgeConcept(
  fromLastSection: { heading: string; keyPoints: string[] },
  toFirstSection: { heading: string; keyPoints: string[] }
): string {
  const fromText = [fromLastSection.heading, ...fromLastSection.keyPoints].join(" ");
  const toText = [toFirstSection.heading, ...toFirstSection.keyPoints].join(" ");
  const fromTokens = keywordTokens(fromText);
  const toTokens = keywordTokens(toText);
  const shared: string[] = [];
  for (const w of fromTokens) { if (toTokens.has(w)) shared.push(w); }
  if (shared.length > 0) return shared.slice(0, 3).join(", ");
  // Fall back to stating the thematic direction
  return `${fromLastSection.heading.split(/\s+/).slice(0, 4).join(" ")} → ${toFirstSection.heading.split(/\s+/).slice(0, 4).join(" ")}`;
}

// ── Absolute minimum schema — no keyPoints, no quotes, no nested arrays ──────
// Everything gets rehydrated server-side from the contentMap after generation.
const MinimalSectionSchema = z.object({
  sectionNumber: z.number().default(1),
  heading: z.string().default(""),
  sourceSegmentIds: z.array(z.string()).default([]),
  targetWordCount: z.number().default(0),
});

const MinimalChapterSchema = z.object({
  number: z.number().default(1),
  title: z.string().default(""),
  keyTheme: z.string().default(""),
  sections: z.array(MinimalSectionSchema).default([]),
});

const MinimalArchitectureSchema = z.object({
  bookTitle: z.string().default("Untitled Teaching Manuscript"),
  subtitle: z.string().default(""),
  authorName: z.string().default("the Author"),
  estimatedTotalWords: z.number().default(0),
  frontMatterNotes: z.string().default(""),
  backMatterNotes: z.string().default(""),
  chapters: z.array(MinimalChapterSchema).default([]),
});

// ── Deterministic section grouper (error fallback only) ─────────────────────
// Used only when the per-audio LLM call fails.
function groupSegmentsIntoSections(
  segs: Array<{ id: string; topic: string; keyPoints: string[]; estimatedWordCount: number }>,
  maxSections = 5,
): Array<{ heading: string; sourceSegmentIds: string[]; targetWordCount: number }> {
  if (segs.length === 0) return [];
  if (segs.length <= maxSections) {
    // Each segment gets its own section — derive heading from keyPoints
    return segs.map((seg) => ({
      heading: deriveSectionHeading(seg.topic, seg.keyPoints),
      sourceSegmentIds: [seg.id],
      targetWordCount: Math.max(seg.estimatedWordCount || 0, 250),
    }));
  }

  // Greedily merge consecutive segments when they share topic keywords.
  // Always produce between 3 and maxSections buckets.
  const minSections = Math.min(3, segs.length);
  const buckets: typeof segs[] = [];
  let current: typeof segs = [segs[0]];

  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const remaining = segs.length - i;
    const slotsLeft = maxSections - buckets.length - 1; // -1 for current open bucket

    // Always merge if we'd exceed maxSections by splitting
    const mustMerge = slotsLeft <= remaining;
    // Split if the topic diverges enough AND we still have room for more sections
    const shouldSplit = !mustMerge && sectionKeywordOverlap(
      [current[0].topic, ...current[0].keyPoints].join(" "),
      [seg.topic, ...seg.keyPoints].join(" ")
    ) < 0.25;

    if (shouldSplit && buckets.length + 1 < maxSections) {
      buckets.push(current);
      current = [seg];
    } else {
      current.push(seg);
    }
  }
  buckets.push(current);

  // If we ended up with fewer than minSections, split the largest bucket
  while (buckets.length < minSections) {
    const largestIdx = buckets.reduce((best, b, i) => b.length > buckets[best].length ? i : best, 0);
    if (buckets[largestIdx].length < 2) break;
    const half = Math.ceil(buckets[largestIdx].length / 2);
    const [left, right] = [buckets[largestIdx].slice(0, half), buckets[largestIdx].slice(half)];
    buckets.splice(largestIdx, 1, left, right);
  }

  return buckets.map((group) => {
    const allKeyPoints = group.flatMap((s) => s.keyPoints ?? []);
    const heading = deriveSectionHeading(group[0].topic, allKeyPoints);
    const totalWords = group.reduce((sum, s) => sum + (s.estimatedWordCount || 0), 0);
    return {
      heading,
      sourceSegmentIds: group.map((s) => s.id),
      targetWordCount: Math.max(totalWords, 250),
    };
  });
}

/** Compress a heading to 6 words max — cuts at the first conjunction/clause break. */
function compressHeading(heading: string): string {
  const words = heading.trim().split(/\s+/);
  if (words.length <= 6) return heading.trim();
  // Cut at the first "soft" word after position 3 (conjunctions, relative pronouns, prepositions)
  const SOFT = /^(and|but|that|as|so|which|who|when|where|while|because|until|after|before|though|although|if|or|–|—|-|,)$/i;
  let cutAt = words.length;
  for (let i = 3; i < words.length; i++) {
    const clean = words[i].replace(/[,;:–—]$/, "");
    if (SOFT.test(clean) || words[i].endsWith(",") || words[i].endsWith(";")) {
      cutAt = i;
      break;
    }
  }
  const cut = words.slice(0, Math.min(cutAt, 6)).join(" ").replace(/[,;:–—]+$/, "").trim();
  return cut || words.slice(0, 5).join(" ");
}

/** Pick the best heading from a segment's topic + keyPoints — never fabricates, uses transcript data only. */
function deriveSectionHeading(topic: string, keyPoints: string[]): string {
  const BANNED = /^(introduction|intro|overview|opening|summary|conclusion|section|part|chapter)\s*[:\-]?\s*/i;
  const candidates = [topic, ...(keyPoints ?? [])]
    .map((s) => s.replace(BANNED, "").trim())
    .filter((s) => s.length > 8);
  // Pick the shortest candidate that is still meaningful (avoids pulling full sermon sentences)
  const best = candidates.sort((a, b) => a.length - b.length)[0];
  const raw = best || topic.replace(BANNED, "").trim() || "Core Teaching";
  return compressHeading(raw);
}

// ── Per-audio LLM chapter architect (oneChapterPerUpload) ────────────────────
// One call per audio file, receiving the full rawText so the LLM can make
// premium structural decisions grounded entirely in the actual transcript.
// SOURCE_LOCK_RULES enforces zero fabrication.

const SingleChapterPlanSchema = z.object({
  title: z.string().default(""),
  keyTheme: z.string().default(""),
  sections: z.array(z.object({
    heading: z.string().default(""),
    sourceSegmentIds: z.array(z.string()).default([]),
    targetWordCount: z.number().default(0),
  })).default([]),
});

async function architectOneChapterFromTranscript(
  segments: Array<{ id: string; topic: string; rawText: string; keyPoints: string[]; estimatedWordCount: number }>,
  chapterHint: string,
  coreThesis: string,
  teachingArc: string,
  voiceDNATone: string,
): Promise<z.infer<typeof SingleChapterPlanSchema>> {
  const MAX_RAW_WORDS_PER_SEGMENT = 1200;
  const transcriptBlock = segments.map((seg) => {
    const rawWords = (seg.rawText ?? "").split(/\s+/);
    const rawTruncated = rawWords.length > MAX_RAW_WORDS_PER_SEGMENT
      ? rawWords.slice(0, MAX_RAW_WORDS_PER_SEGMENT).join(" ") + " […]"
      : (seg.rawText ?? "");
    return [
      `[SEGMENT ${seg.id}]`,
      `TOPIC: ${seg.topic}`,
      `KEY POINTS:\n${(seg.keyPoints ?? []).map((p) => `  • ${p}`).join("\n")}`,
      `WORD COUNT: ${seg.estimatedWordCount}`,
      `TRANSCRIPT:\n${rawTruncated}`,
    ].join("\n");
  }).join("\n\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n");

  const { object } = await generateObject({
    model: deepSeekReasonerModel,
    schema: SingleChapterPlanSchema,
    mode: "json",
    temperature: 1,
    maxTokens: 8000,
    system: `You are a senior structural editor turning one teaching message into a premium book chapter.

SOURCE-LOCK — ABSOLUTE RULE:
Every title, section heading, and key theme you write MUST derive word-for-word or idea-for-idea from the transcript segments below. You may NOT invent, assume, or extrapolate anything not explicitly present in the provided text.

CHAPTER TITLE RULE:
- 4–7 words. Punchy. Sounds like a book you would buy, not an academic paper.
- Use the speaker's actual words or a natural distillation of their central claim.
- Must be a COMPLETE, self-contained phrase — no dangling prepositions, no dangling conjunctions.
- FORBIDDEN formats: "The [abstract noun] of X and Y" | "The [adjective] link between X and Y" | "The [noun] dimensions of X (parenthetical list)" | anything with a parenthetical aside.
- GOOD: "When Prayer Changes the Pray-er" | "The Glory That Prayer Reveals" | "Righteous Living Fuels Effectual Prayer"
- BAD: "Prayer as a transformative encounter that reveals hidden glory" (sentence, not a title) | "The inseparable link between righteous living and effective prayer" (academic) | "The communal dimensions of prayer (personal, elders, interpersonal)" (parenthetical)

SECTION HEADING RULES:
- Each heading must name a specific truth, claim, or action the speaker made in that segment — drawn directly from the keyPoints or transcript.
- 4–8 words. Complete phrase — NEVER cut a thought mid-clause or leave a dangling word.
- Title case. No punctuation at the end.
- The heading must be able to stand alone and make sense to a reader who has not heard the sermon.
- BANNED prefixes: Introduction, Intro, Overview, Opening, Summary, Conclusion, Part, Chapter, Section
- FORBIDDEN: any heading that ends with a preposition ("to", "our", "the", "in", "for", "on"), a conjunction ("and", "but", "or"), or a pronoun without its noun ("it", "them", "their", "its").
- GOOD: "Prayer Reveals Hidden Glory" | "Moses Held the Nation by Prayer" | "The Righteous Life Powers Prayer"
- BAD: "Pray until you are no longer" (dangling) | "You need a Joshua 2.0 to" (dangling) | "When we open up our" (dangling) | "Is any among you afflicted? Let" (question fragment)

STRUCTURE RULES:
- Produce exactly 3–5 sections
- Group segments that develop the same point; split when the topic clearly shifts
- sourceSegmentIds must ONLY reference IDs from the AVAILABLE SEGMENTS list
- Every provided segment ID must appear in exactly one section — none may be skipped
- targetWordCount = sum of assigned segments' word counts
- Apply a natural teaching arc: Hook → Context → Core Mechanism → Application → Landing

${SOURCE_LOCK_RULES}`,
    prompt: `AVAILABLE SEGMENT IDs: ${segments.map((s) => s.id).join(", ")}
CHAPTER THEME HINT: ${chapterHint}
CORE THESIS: ${coreThesis}
TEACHING ARC: ${teachingArc}
VOICE TONE: ${voiceDNATone}

${transcriptBlock}`,
  });
  return object;
}

function fallbackArchitecture(input: z.infer<typeof ArchitectRequestSchema>) {
  // Group segments by sourceAudio to produce one chapter per message in series order
  const audioOrder = ["audio-1", "audio-2", "audio-3", "audio-4", "audio-5", "audio-6", "audio-7", "audio-8", "audio-9", "audio-10"];
  const segmentsByAudio = new Map<string, typeof input.contentMap.segments>();
  for (const seg of input.contentMap.segments) {
    const bucket = segmentsByAudio.get(seg.sourceAudio) ?? [];
    bucket.push(seg);
    segmentsByAudio.set(seg.sourceAudio, bucket);
  }

  const audioKeys = audioOrder.filter((k) => segmentsByAudio.has(k));
  const chapters = audioKeys.map((audioKey, chapterIndex) => {
    const segs = segmentsByAudio.get(audioKey)!;
    // Use the content-map theme for this audio slot as the chapter title (already extracted
    // from the transcript by the content-map step — no fabrication risk).
    const chapterTitle = (input.contentMap.overarchingThemes[chapterIndex] || "").trim()
      || segs.map((s) => s.topic).sort((a, b) => b.length - a.length)[0]
      || `Chapter ${chapterIndex + 1}`;
    const keyTheme = chapterTitle;
    // Group segments intelligently into 3–5 sections
    const rawSections = groupSegmentsIntoSections(segs, 5);
    const sections = rawSections.map((sec, i) => ({
      sectionNumber: i + 1,
      heading: sec.heading,
      sourceSegmentIds: sec.sourceSegmentIds,
      targetWordCount: sec.targetWordCount,
    }));
    return { number: chapterIndex + 1, title: chapterTitle, keyTheme, sections };
  });

  const fallbackChapters = chapters.length > 0 ? chapters : [{
    number: 1,
    title: input.contentMap.coreThesis || input.contentMap.overarchingThemes[0] || "Core Teaching",
    keyTheme: input.contentMap.coreThesis || input.contentMap.overarchingThemes[0] || input.contentMap.teachingArc || "Core teaching",
    sections: groupSegmentsIntoSections(input.contentMap.segments, 5).map((sec, i) => ({
      sectionNumber: i + 1,
      ...sec,
    })),
  }];

  return {
    bookTitle: input.contentMap.coreThesis || input.contentMap.overarchingThemes[0] || input.contentMap.segments[0]?.topic || "Untitled Teaching Manuscript",
    subtitle: input.contentMap.targetAudience || input.contentMap.teachingArc || "Drawn directly from the source teaching",
    authorName: "the Author",
    estimatedTotalWords: fallbackChapters.flatMap((c) => c.sections).reduce((sum, s) => sum + s.targetWordCount, 0),
    frontMatterNotes: input.contentMap.coreThesis || input.contentMap.segments[0]?.topic || "",
    backMatterNotes: input.contentMap.teachingArc || input.contentMap.segments.at(-1)?.topic || "",
    chapters: fallbackChapters,
  };
}

function normalizeArchitecture(
  minimal: z.infer<typeof MinimalArchitectureSchema>,
  input: z.infer<typeof ArchitectRequestSchema>,
) {
  const fallback = fallbackArchitecture(input);
  const validIds = new Set(input.contentMap.segments.map((s) => s.id));

  // Deduplicate segment IDs globally — each segment must feed exactly one section.
  // First-come-first-served: whichever section claims a segment first keeps it.
  const globalUsedSegIds = new Set<string>();

  const chapters = (minimal.chapters ?? [])
    .map((chapter, chapterIndex) => ({
      number: Math.max(1, Math.trunc(chapter.number || chapterIndex + 1)),
      title: (chapter.title || "").trim() || fallback.chapters[0].title,
      keyTheme: (chapter.keyTheme || "").trim() || fallback.chapters[0].keyTheme,
      sections: (chapter.sections ?? [])
        .map((section, sectionIndex) => {
          const uniqueIds = (section.sourceSegmentIds ?? [])
            .filter((id) => validIds.has(id) && !globalUsedSegIds.has(id));
          uniqueIds.forEach((id) => globalUsedSegIds.add(id));
          return {
            sectionNumber: Math.max(1, Math.trunc(section.sectionNumber || sectionIndex + 1)),
            heading: ((section.heading || "").trim() || `Section ${sectionIndex + 1}`).replace(/^(introduction|intro|overview|opening|summary|conclusion)\s*:\s*/i, "").trim() || `Section ${sectionIndex + 1}`,
            sourceSegmentIds: uniqueIds,
            targetWordCount: Math.max(0, Math.trunc(section.targetWordCount || 0)),
          };
        })
        .filter((section) => section.sourceSegmentIds.length > 0)
        // Renumber sequentially so no two sections in a chapter share a sectionNumber,
        // regardless of what the LLM returned. Duplicate sectionNumbers cause the pipeline
        // to write the same section twice because the dedup guard is keyed by this number.
        .map((section, si) => ({ ...section, sectionNumber: si + 1 })),
    }))
    .filter((chapter) => chapter.sections.length > 0);

  // ── Heading quality pass: warn-only, no mutation ────────────────────────────
  // We deliberately do NOT compress or truncate headings here. The AI is
  // instructed to produce complete 4–8 word phrases. Post-hoc truncation was
  // the root cause of dangling fragments like "Pray until you are no longer".
  // Warnings are logged for monitoring but headings are left as-is.
  const architectureWarnings: string[] = [];
  const allHeadingTokens: Array<{ heading: string; chapterNum: number; sectionNum: number }> = [];

  const DANGLING_END_RE = /\b(to|our|the|in|for|on|and|but|or|let|a|an|its|their|them|it)$/i;

  const targetChapters = chapters.length > 0 ? chapters : fallback.chapters;
  for (const chapter of targetChapters) {
    for (const section of chapter.sections) {
      const words = section.heading.trim().split(/\s+/);
      if (words.length > 8) {
        architectureWarnings.push(
          `Ch ${chapter.number} §${section.sectionNumber}: Heading too long (${words.length} words): "${section.heading}"`
        );
      }
      if (DANGLING_END_RE.test(section.heading.trim())) {
        architectureWarnings.push(
          `Ch ${chapter.number} §${section.sectionNumber}: Heading ends mid-thought: "${section.heading}"`
        );
      }
      allHeadingTokens.push({ heading: section.heading, chapterNum: chapter.number, sectionNum: section.sectionNumber });
    }
  }

  // Global cross-chapter dedup (check ALL chapter pairs, not just adjacent)
  for (let i = 0; i < allHeadingTokens.length; i++) {
    for (let j = i + 1; j < allHeadingTokens.length; j++) {
      if (allHeadingTokens[i].chapterNum === allHeadingTokens[j].chapterNum) continue; // same-chapter already caught
      const overlap = sectionKeywordOverlap(allHeadingTokens[i].heading, allHeadingTokens[j].heading);
      if (overlap >= 0.55) {
        architectureWarnings.push(
          `Possible duplicate headings across chapters: Ch${allHeadingTokens[i].chapterNum} §${allHeadingTokens[i].sectionNum} vs Ch${allHeadingTokens[j].chapterNum} §${allHeadingTokens[j].sectionNum} — "${allHeadingTokens[i].heading}" / "${allHeadingTokens[j].heading}"`
        );
      }
    }
  }

  if (architectureWarnings.length > 0) {
    console.warn("[architect] Heading quality warnings:", architectureWarnings);
  }

  return {
    bookTitle: (minimal.bookTitle || "").trim() || fallback.bookTitle,
    subtitle: (minimal.subtitle || "").trim(),
    authorName: (minimal.authorName || "").trim() || fallback.authorName,
    estimatedTotalWords: Math.max(0, Math.trunc(minimal.estimatedTotalWords || 0)) || fallback.estimatedTotalWords,
    frontMatterNotes: (minimal.frontMatterNotes || "").trim() || fallback.frontMatterNotes,
    backMatterNotes: (minimal.backMatterNotes || "").trim() || fallback.backMatterNotes,
    chapters: chapters.length > 0 ? chapters : fallback.chapters,
    architectureWarnings,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = ArchitectRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  // Build segment + quote lookups for rehydration
  const segmentMap = Object.fromEntries(input.contentMap.segments.map((s) => [s.id, s]));
  const validSegmentIds = new Set(input.contentMap.segments.map((s) => s.id));
  const quoteMap = Object.fromEntries((input.contentMap.allQuotes ?? []).map((q) => [q.id, q]));

  // Trim input to only what the LLM needs for architecture decisions
  const segmentsLite = input.contentMap.segments.map((s) => ({
    id: s.id,
    sourceAudio: s.sourceAudio,
    topic: s.topic,
    keyPoints: (s.keyPoints ?? []).slice(0, 3), // first 3 only
    estimatedWordCount: s.estimatedWordCount,
  }));

  try {
    let minimal: z.infer<typeof MinimalArchitectureSchema>;
    try {
      if (input.oneChapterPerUpload) {
        // ── Per-audio parallel LLM calls (oneChapterPerUpload) ────────────────
        // Each audio file gets its own focused LLM call with full transcript text.
        // The LLM produces premium structure entirely from the provided transcript.
        const audioOrder = ["audio-1", "audio-2", "audio-3", "audio-4", "audio-5", "audio-6", "audio-7", "audio-8", "audio-9", "audio-10"] as const;
        const segsByAudio = new Map<string, typeof input.contentMap.segments>();
        for (const seg of input.contentMap.segments) {
          const bucket = segsByAudio.get(seg.sourceAudio) ?? [];
          bucket.push(seg);
          segsByAudio.set(seg.sourceAudio, bucket);
        }
        const audioKeys = audioOrder.filter((k) => segsByAudio.has(k));

        const chapterPlans = await Promise.all(
          audioKeys.map((audioKey, idx) => {
            const segs = segsByAudio.get(audioKey)!;
            const chapterHint = (input.contentMap.overarchingThemes[idx] || "").trim()
              || segs.map((s) => s.topic).sort((a, b) => b.length - a.length)[0]
              || "";
            return architectOneChapterFromTranscript(
              segs,
              chapterHint,
              input.contentMap.coreThesis,
              input.contentMap.teachingArc,
              input.voiceDNA.toneProfile,
            ).catch(() => null);
          })
        );

        const validIds = new Set(input.contentMap.segments.map((s) => s.id));
        const chapters = chapterPlans.map((plan, idx) => {
          const segs = segsByAudio.get(audioKeys[idx])!;
          const themeHint = (input.contentMap.overarchingThemes[idx] || segs[0]?.topic || `Chapter ${idx + 1}`).trim();
          if (!plan || plan.sections.length === 0) {
            const grouped = groupSegmentsIntoSections(segs, 5);
            return {
              number: idx + 1,
              title: themeHint,
              keyTheme: themeHint,
              sections: grouped.map((sec, si) => ({ sectionNumber: si + 1, ...sec })),
            };
          }
          return {
            number: idx + 1,
            title: (plan.title || themeHint).trim(),
            keyTheme: (plan.keyTheme || plan.title || themeHint).trim(),
            sections: plan.sections
              .map((sec, si) => ({
                sectionNumber: si + 1,
                heading: sec.heading,
                sourceSegmentIds: (sec.sourceSegmentIds ?? []).filter((id) => validIds.has(id)),
                targetWordCount: sec.targetWordCount || 0,
              }))
              .filter((sec) => sec.sourceSegmentIds.length > 0),
          };
        });

        // Extract short book title from themes or first chapter (not coreThesis which is a long paragraph)
        const shortBookTitle = (
          input.contentMap.overarchingThemes[0] ||
          chapters[0]?.title ||
          input.contentMap.segments[0]?.topic ||
          "Untitled Teaching Manuscript"
        ).trim().split(".")[0].slice(0, 100);

        minimal = {
          bookTitle: shortBookTitle,
          subtitle: input.contentMap.targetAudience || input.contentMap.teachingArc || "Drawn directly from the source teaching",
          authorName: "the Author",
          estimatedTotalWords: chapters.flatMap((c) => c.sections).reduce((sum, s) => sum + (s.targetWordCount || 0), 0),
          frontMatterNotes: input.contentMap.coreThesis || input.contentMap.segments[0]?.topic || "",
          backMatterNotes: input.contentMap.teachingArc || input.contentMap.segments.at(-1)?.topic || "",
          chapters,
        };
      } else {
      {
        const result = await generateObject({
        model: deepSeekReasonerModel,
        schema: MinimalArchitectureSchema,
        mode: "json",
        maxTokens: 16000,
        system: `# ROLE
You are an elite structural editor for a top-tier publishing house. Your job is to map raw, sanitized audio transcript segments into a clean chapter architecture for a published book series.

# OBJECTIVE
This content is a sermon series. The author's preaching sequence IS the book's sequence. Your job is to give each message a strong chapter structure — not to reorganize which ideas belong in which message.

# STRICT EDITORIAL INSTRUCTIONS
1. SEQUENCE PRESERVATION — NON-NEGOTIABLE: Chapters must follow the source audio order (audio-1 before audio-2 before audio-3, etc.). A single audio source may produce more than one chapter if the content depth warrants it — but all chapters from audio-1 must appear consecutively before any chapter from audio-2. Never interleave chapters from different audio sources. Never place a segment from audio-2 into a chapter that also contains segments from audio-1.
2. WITHIN-CHAPTER ORDER = TRANSCRIPT ORDER — NON-NEGOTIABLE: Sections within a chapter must appear in the exact same order that their segments appear in the transcript. The segment that appears earliest in the transcript goes to the first section; the segment that appears latest goes to the last section. Do NOT reorder sections to fit any narrative arc, thematic grouping, or editorial framework. The speaker's own sequence IS the structure. If the speaker introduced a concept late, that concept belongs in a late section — not moved to the front because it sounds like a "hook." Never rearrange sections based on content density, topic similarity, or any structural model.
3. SAME-TOPIC CONSOLIDATION (conservative): If the speaker revisited the exact same point in two segments that are adjacent or nearly adjacent, you may consolidate them into one section. Do not reach across the transcript to pull distant segments together by theme — that reorders content. Each section's segments must be a contiguous or near-contiguous run from the transcript.
4. WITHIN-CHAPTER DEDUPLICATION ONLY: Within a single message, pure title-restatement recap lines (e.g., "our series this month is...") with zero new substance may be collapsed. Do not discard content that transitions the series narrative forward.

# PIPELINE RULES — REQUIRED FOR OUTPUT VALIDITY
- sourceSegmentIds MUST reference actual segment IDs from the provided segment list (e.g. "seg-1"). Never invent IDs.
- SEGMENT UNIQUENESS — NON-NEGOTIABLE: Each segment ID must appear in EXACTLY ONE section across the entire book. Never assign the same segment ID to two or more sections or chapters. If two sections seem to need the same content, merge them into one section.
- Each chapter must draw segments from only one sourceAudio. A single sourceAudio may produce multiple consecutive chapters if the content depth warrants it.
- Each chapter: 3–5 sections; each section covers one focused teaching point.
- targetWordCount per section = sum of that section's segments' estimatedWordCount.
- bookTitle and authorName must come from the content; use "the Author" if name is unknown.
- estimatedTotalWords = sum of all section targetWordCounts.
- Always return every required field, even if some strings are brief.
- Never leave sections empty; every chapter must have at least one section with at least one sourceSegmentId.
- SECTION HEADING BAN: Never start a section heading with "Introduction", "Intro", "Overview", "Opening", "Summary", or "Conclusion". These are structural labels, not teaching titles. Rename any such heading to the specific claim or truth the speaker made in that segment.
- SECTION HEADING STANDARD — NON-NEGOTIABLE: Every section heading must be a COMPLETE, self-contained phrase of 4–8 words. Full sentences are forbidden. A heading that ends mid-thought (dangling preposition, dangling conjunction, or incomplete clause) is a failure. FORBIDDEN endings: any heading that ends with "to", "our", "the", "in", "for", "on", "and", "but", "or", "let", "a". GOOD: "Prayer Reveals Hidden Glory" | "The Righteous Life Powers Prayer" | "God Listens to Those Who Pray" | BAD: "Pray until you are no longer" (dangling) | "When we open up our" (dangling) | "Is any among you afflicted? Let" (fragment).
- CHAPTER TITLE STANDARD: Chapter titles must be 4–7 words, punchy, and sound like a published book — not an academic description. FORBIDDEN: parenthetical asides in titles, the phrase "The [abstract noun] of X and Y", thesis-statement format. GOOD: "When Prayer Changes the Pray-er" | BAD: "Prayer as a transformative encounter that reveals hidden glory and changes the pray-er's internal state".`,
        prompt: `Design the chapter architecture.

      VOICE DNA TONE: ${input.voiceDNA.toneProfile}
      TEACHING ARC: ${input.contentMap.teachingArc}
      CORE THESIS: ${input.contentMap.coreThesis}
      TARGET AUDIENCE: ${input.contentMap.targetAudience}
      UNIQUE VOCABULARY: ${(input.contentMap.uniqueVocabulary ?? []).join(", ")}
      TONE MAP: ${input.contentMap.toneMap}
      THEMES: ${(input.contentMap.overarchingThemes ?? []).join(", ")}

      SEGMENTS:
      ${JSON.stringify(segmentsLite)}`,
        });
        minimal = result.object;
      } // end LLM block
      } // end else
    } catch {
      minimal = fallbackArchitecture(input);
    }

    const normalized = normalizeArchitecture(minimal, input);

    // ── Upgrade 6: Orphan segment recovery ──────────────────────────────────
    // Find segments not assigned to any section. Segments >150 words get assigned
    // to the most keyword-similar section. Thinner ones are logged as dropped.
    const assignedSegIds = new Set(
      normalized.chapters.flatMap((ch) => ch.sections.flatMap((s) => s.sourceSegmentIds))
    );
    const orphans = input.contentMap.segments.filter(
      (s) => !assignedSegIds.has(s.id) && !s.topic.includes("[NON-TEACHING")
    );
    const droppedSegments: string[] = [];

    if (orphans.length > 0) {
      // Build a flat list of all sections with their text for similarity scoring
      const allSectionEntries = normalized.chapters.flatMap((ch) =>
        ch.sections.map((sec) => ({
          chapterIdx: ch.number - 1,
          sectionIdx: sec.sectionNumber - 1,
          text: [sec.heading, ...sec.sourceSegmentIds.map((id) => segmentMap[id]?.topic ?? "")].join(" "),
        }))
      );

      for (const orphan of orphans) {
        if (orphan.estimatedWordCount < 150) {
          droppedSegments.push(orphan.id);
          continue;
        }
        // Find most similar section by keyword overlap with orphan topic + keyPoints
        const orphanText = [orphan.topic, ...(orphan.keyPoints ?? [])].join(" ");
        let bestScore = 0;
        let bestEntry: (typeof allSectionEntries)[0] | null = null;
        for (const entry of allSectionEntries) {
          const score = sectionKeywordOverlap(orphanText, entry.text);
          if (score > bestScore) { bestScore = score; bestEntry = entry; }
        }
        if (bestEntry && bestScore > 0.1) {
          normalized.chapters[bestEntry.chapterIdx].sections[bestEntry.sectionIdx].sourceSegmentIds.push(orphan.id);
          assignedSegIds.add(orphan.id);
        } else {
          droppedSegments.push(orphan.id);
        }
      }
    }

    // ── Rehydrate full BookArchitecture from minimal output ───────────────
    const hydratedChapters = normalized.chapters.map((ch) => {
      const chapterSegIds = [...new Set(ch.sections.flatMap((s) => s.sourceSegmentIds))];
      const chapterQuotes = chapterSegIds
        .flatMap((sid) => segmentMap[sid]?.quotes ?? [])
        .map((q) => quoteMap[q.id] ?? q)
        .filter((q, i, arr) => arr.findIndex((x) => x.id === q.id) === i);

      const rawSections = ch.sections.map((sec, secIdx) => {
        const safeSourceSegmentIds = sec.sourceSegmentIds.filter((id) => validSegmentIds.has(id));
        const secSegments = safeSourceSegmentIds.map((id) => segmentMap[id]).filter(Boolean);
        const secKeyPoints = secSegments.flatMap((s) => s?.keyPoints ?? []);
        const secQuotes = secSegments
          .flatMap((s) => s?.quotes ?? [])
          .map((q) => quoteMap[q.id] ?? q)
          .filter((q, i, arr) => arr.findIndex((x) => x.id === q.id) === i);

        // ── Upgrade 3: Word budget calibration ──────────────────────────
        const baseWordCount = sec.targetWordCount ||
          secSegments.reduce((sum, seg) => sum + (seg?.estimatedWordCount ?? 0), 0);
        const quotesCount = secQuotes.length;
        const multiplier = segmentQualityMultiplier(secKeyPoints.length, quotesCount);
        const calibratedWordCount = Math.max(250, Math.round(baseWordCount * multiplier));

        // ── Upgrade 1: Arc role scoring ──────────────────────────────────
        const arcRole = scoreArcRole(sec.heading, secKeyPoints);

        return {
          sectionNumber: sec.sectionNumber,
          heading: sec.heading,
          sourceSegmentIds: safeSourceSegmentIds,
          targetWordCount: calibratedWordCount,
          keyPoints: secKeyPoints,
          quotesInSection: secQuotes,
          arcRole,
          _contentDensity: secKeyPoints.length + quotesCount, // internal — used for U4
          _originalIdx: secIdx,                               // internal — used for U4
        };
      });

      // ── Transcript-order sort ────────────────────────────────────────────
      // Sort sections by the earliest segment index among their assigned segments
      // so the final section order always matches the speaker's presentation order.
      // Segment IDs are "seg-N"; extract N as the sort key.
      function segSortKey(id: string): number {
        const m = id.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : 999999;
      }
      const sections = [...rawSections].sort((a, b) => {
        const aMin = Math.min(...(a.sourceSegmentIds.length ? a.sourceSegmentIds.map(segSortKey) : [999999]));
        const bMin = Math.min(...(b.sourceSegmentIds.length ? b.sourceSegmentIds.map(segSortKey) : [999999]));
        return aMin - bMin;
      });
      // Renumber after sort so sectionNumber stays 1-based and contiguous
      sections.forEach((s, i) => { s.sectionNumber = i + 1; });

      // ── Upgrade 1: Arc flags ─────────────────────────────────────────────
      const arcFlags = buildArcFlags(sections, ch.title);

      // ── Upgrade 5: Chapter premise line ─────────────────────────────────
      const chapterPremise = deriveChapterPremise(
        ch.title,
        ch.keyTheme,
        input.contentMap.coreThesis,
        sections[0]?.heading ?? ""
      );

      // Strip internal fields before returning
      const cleanSections = sections.map(({ _contentDensity: _d, _originalIdx: _o, ...rest }) => rest);

      return {
        number: ch.number,
        title: ch.title,
        keyTheme: ch.keyTheme,
        sourceSegmentIds: chapterSegIds,
        quotesInChapter: chapterQuotes,
        chapterPremise,
        arcFlags,
        sections: cleanSections,
      };
    });

    // ── Upgrade 2: Cross-chapter section overlap check ───────────────────
    // Flag pairs of sections from different chapters with >60% keyword overlap
    const overlapWarnings: string[] = [];
    const allSectionFlat = hydratedChapters.flatMap((ch) =>
      ch.sections.map((s) => ({ chapterNum: ch.number, heading: s.heading, keyPoints: s.keyPoints }))
    );
    for (let i = 0; i < allSectionFlat.length; i++) {
      for (let j = i + 1; j < allSectionFlat.length; j++) {
        const a = allSectionFlat[i];
        const b = allSectionFlat[j];
        if (a.chapterNum === b.chapterNum) continue;
        const aText = [a.heading, ...a.keyPoints].join(" ");
        const bText = [b.heading, ...b.keyPoints].join(" ");
        const overlap = sectionKeywordOverlap(aText, bText);
        if (overlap >= ARCHITECT_OVERLAP_THRESHOLD) {
          overlapWarnings.push(
            `Ch ${a.chapterNum} §"${a.heading}" ↔ Ch ${b.chapterNum} §"${b.heading}" (${Math.round(overlap * 100)}% overlap)`
          );
        }
      }
    }

    if (env.EBOOK_STRICT_ARCHITECT_OVERLAP_GATE && overlapWarnings.length > 0) {
      return NextResponse.json({
        route: "ebook/architect",
        error: "Architecture overlap detected",
        details: "Architect found overlapping sections across chapters and stopped before drafting to avoid duplicated prose.",
        overlapWarnings,
        revertHint: "Set EBOOK_STRICT_ARCHITECT_OVERLAP_GATE=false to restore warning-only behavior.",
      }, { status: 409 });
    }

    // Attach overlap warnings as arcFlags on the affected chapters
    if (overlapWarnings.length > 0) {
      for (const warning of overlapWarnings) {
        const chNumMatch = warning.match(/^Ch (\d+)/);
        if (chNumMatch) {
          const chNum = parseInt(chNumMatch[1], 10);
          const ch = hydratedChapters.find((c) => c.number === chNum);
          if (ch) ch.arcFlags.push(`[OVERLAP] ${warning}`);
        }
      }
    }

    // ── Upgrade 7: Series arc connective tissue map ──────────────────────
    const seriesArc = hydratedChapters.slice(0, -1).map((ch, idx) => {
      const nextCh = hydratedChapters[idx + 1];
      const fromLastSection = ch.sections[ch.sections.length - 1];
      const toFirstSection = nextCh.sections[0];
      return {
        fromChapter: ch.number,
        toChapter: nextCh.number,
        bridgeConcept: deriveBridgeConcept(
          { heading: fromLastSection?.heading ?? "", keyPoints: fromLastSection?.keyPoints ?? [] },
          { heading: toFirstSection?.heading ?? "", keyPoints: toFirstSection?.keyPoints ?? [] }
        ),
      };
    });

    const hydrated = {
      bookTitle: normalized.bookTitle,
      subtitle: normalized.subtitle,
      authorName: normalized.authorName,
      estimatedTotalWords: normalized.estimatedTotalWords,
      frontMatterNotes: normalized.frontMatterNotes,
      backMatterNotes: normalized.backMatterNotes,
      chapters: hydratedChapters,
      seriesArc,
      droppedSegments,
    };

    return NextResponse.json(hydrated, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Architecture generation failed";
    return NextResponse.json({
      route: "ebook/architect",
      error: message,
      details: err instanceof Error && err.stack
        ? err.stack.split("\n").slice(0, 3).join(" | ")
        : undefined,
    }, { status: 500 });
  }
}
