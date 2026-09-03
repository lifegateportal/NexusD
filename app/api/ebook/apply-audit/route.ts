import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { z } from "zod";
import { VoiceDNASchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, PROSE_MASTERY_RULES, PREMIUM_BOOK_STYLE_RULES, READER_NORMALIZATION_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

type VoiceDNAType = z.infer<typeof VoiceDNASchema>;

export const runtime = "nodejs";
export const maxDuration = 120;

// ─── Strategy ─────────────────────────────────────────────────────────────────
// Tier 1 (no LLM) — pure string manipulation, zero risk of unintended rewrites:
//   r-N  repeated phrases  → replace 2nd+ occurrences with alternatives
//   w-N  overused words    → replace every other occurrence with alternatives
//
// Tier 2 (targeted LLM) — only the ONE affected section body is sent:
//   c-N  concept duplicate → revise just that section per the recommendation
//   p-N  similar pair      → rewrite just the section in this chapter to
//                            differentiate from its pair
//
// Sections that have NO applied findings are NEVER touched.

// ─── Input Schemas ────────────────────────────────────────────────────────────

const SectionSchema = z.object({
  sectionNumber: z.number(),
  heading: z.string(),
  body: z.string().default(""),
  wordCount: z.number().default(0),
  status: z.string().default("complete"),
});

const ChapterSchema = z.object({
  number: z.number(),
  title: z.string().default(""),
  intro: z.string().default(""),
  sections: z.array(SectionSchema),
  conclusion: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  totalWordCount: z.number().default(0),
  status: z.string().default("complete"),
});

const RequestSchema = z.object({
  manifest: z.object({ chapters: z.array(ChapterSchema) }),
  report: z.object({
    conceptDuplicates: z.array(z.object({
      type: z.string(),
      title: z.string(),
      description: z.string(),
      severity: z.string(),
      locations: z.array(z.object({ location: z.string(), excerpt: z.string().optional().nullable() })),
      recommendation: z.string(),
    })).default([]),
    similarPairs: z.array(z.object({
      locationA: z.string(),
      locationB: z.string(),
      similarity: z.number(),
      excerptA: z.string().default(""),
      excerptB: z.string().default(""),
    })).default([]),
    repetitions: z.array(z.object({
      phrase: z.string(),
      count: z.number(),
      occurrences: z.array(z.object({
        chapterNumber: z.number(),
        sectionNumber: z.number().optional().nullable(),
      })),
      alternatives: z.array(z.string()).default([]),
    })).default([]),
    overusedWords: z.array(z.object({
      word: z.string(),
      count: z.number(),
      frequency: z.string().default(""),
      alternatives: z.array(z.string()).default([]),
    })).default([]),
  }),
  appliedKeys: z.array(z.string()),
  voiceDNA: VoiceDNASchema.optional().nullable(),
});

type ChapterInput = z.infer<typeof ChapterSchema>;
type ReportInput = z.infer<typeof RequestSchema>["report"];

// ─── Location parser ──────────────────────────────────────────────────────────

function parseLocation(loc: string): { chapterNum: number | null; sectionNum: number | null } {
  // Matches: "Chapter N", "Ch N", "Ch. N" (audit emits "Ch N § M: Heading")
  const ch = /\bch(?:apter)?\.?\s+(\d+)/i.exec(loc);
  // Matches: "Section N", "§ N", "§N"
  const sc = /(?:\bsection\s+|§\s*)(\d+)/i.exec(loc);
  return {
    chapterNum: ch ? parseInt(ch[1]) : null,
    sectionNum: sc ? parseInt(sc[1]) : null,
  };
}

// ─── Tier 1 helpers — deterministic string fixes ──────────────────────────────

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace 2nd+ occurrences of `phrase` across a block of text with alternatives (cycling). */
function applyPhraseVariation(text: string, phrase: string, alternatives: string[]): string {
  if (!alternatives.length || !text) return text;
  const regex = new RegExp(escapeRegex(phrase), "gi");
  let hit = 0;
  return text.replace(regex, (match) => {
    hit++;
    if (hit === 1) return match; // first occurrence stays
    const alt = alternatives[(hit - 2) % alternatives.length];
    // mirror capitalisation of the original match
    return match[0] === match[0].toUpperCase()
      ? alt.charAt(0).toUpperCase() + alt.slice(1)
      : alt;
  });
}

/** Replace every other occurrence (2nd, 4th, …) of `word` across a text block with alternatives. */
function applyWordVariation(text: string, word: string, alternatives: string[]): string {
  if (!alternatives.length || !text) return text;
  const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "gi");
  let hit = 0;
  return text.replace(regex, (match) => {
    hit++;
    if (hit % 2 === 1) return match; // odd occurrences stay
    const alt = alternatives[Math.floor((hit - 2) / 2) % alternatives.length];
    return match[0] === match[0].toUpperCase()
      ? alt.charAt(0).toUpperCase() + alt.slice(1)
      : alt;
  });
}

/** Apply a text transformation to every prose field in a chapter's sections, intro, conclusion. */
function mapChapterText(
  chapter: ChapterInput,
  transform: (text: string) => string,
): ChapterInput {
  return {
    ...chapter,
    intro: transform(chapter.intro),
    conclusion: transform(chapter.conclusion),
    sections: chapter.sections.map((s) => {
      const body = transform(s.body);
      return { ...s, body, wordCount: body.split(/\s+/).filter(Boolean).length };
    }),
  };
}

// ─── Tier 2 helper — targeted single-section LLM rewrite ─────────────────────

async function reviseSectionBody(
  heading: string,
  body: string,
  task: string,
  voiceDNA?: VoiceDNAType | null,
): Promise<string> {
  // Compact, human-readable voice block to keep surgical edits in the author's voice
  const voiceDnaBlock = voiceDNA
    ? ((): string => {
        const lines: string[] = ["\nAUTHOR VOICE DNA — maintain throughout:"];
        if (voiceDNA.toneProfile) lines.push(`- Tone: ${voiceDNA.toneProfile}`);
        if (voiceDNA.vocabularyLevel) lines.push(`- Register: ${voiceDNA.vocabularyLevel}`);
        if (voiceDNA.sentencePattern) lines.push(`- Sentence rhythm: ${voiceDNA.sentencePattern}`);
        if (voiceDNA.pacingFingerprint) lines.push(`- Pacing: ${voiceDNA.pacingFingerprint}`);
        if ((voiceDNA.avoidWords ?? []).length > 0)
          lines.push(`- Forbidden words (zero tolerance): ${voiceDNA.avoidWords.slice(0, 15).join(", ")}`);
        if ((voiceDNA.avoidStructures ?? []).length > 0)
          lines.push(`- Forbidden structures: ${(voiceDNA.avoidStructures ?? []).join("; ")}`);
        if ((voiceDNA.signaturePhrases ?? []).length > 0)
          lines.push(`- Signature phrases (use naturally): ${voiceDNA.signaturePhrases.join(", ")}`);
        return lines.join("\n");
      })()
    : "";

  const originalWordCount = body.split(/\s+/).filter(Boolean).length;
  const minWords = Math.floor(originalWordCount * 0.98);  // 98% minimum (was 92%)
  const maxWords = Math.ceil(originalWordCount * 1.02);   // 102% maximum (was 108%)
  // Allow ~2 tokens per word (generous) + headroom, minimum 2048
  const maxTokens = Math.max(2048, originalWordCount * 3);

  let text = "";
  try {
    // Try V3 first for speed (0.25 maintains consistency)
    const result = await generateText({
      model: deepSeekModel,
      temperature: 0.25,  // V3: fast + strict rule adherence
      maxTokens,
      system:
        "You are a surgical book editor. Make only the minimum changes required by the task. Return ONLY the revised section body as plain prose — no JSON, no markdown, no commentary.",
      prompt: `SECTION HEADING: ${heading}${voiceDnaBlock}

SECTION BODY:
${body}

EDITORIAL TASK:
${task}

RULES:
- Change ONLY what is necessary to address the task above
- Preserve every scripture reference, quote, and theological teaching point
- WORD COUNT: The original section is ${originalWordCount} words. Target ${minWords}–${maxWords} words (98–102% of original).
- Return the revised body as plain prose text only

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${SCRIPTURE_FORMATTING_RULES}

${PREMIUM_BOOK_STYLE_RULES}`,
    });
    text = result.text.trim();
  } catch (err) {
    console.warn("[apply-audit] V3 rewrite failed, falling back to R1:", err instanceof Error ? err.message : err);
    // V3 failed — try R1 for maximum certainty
    try {
      const result = await generateText({
        model: deepSeekReasonerModel,
        temperature: 1,
        maxTokens,
        system:
          "You are a surgical book editor. Make only the minimum changes required by the task. Return ONLY the revised section body as plain prose — no JSON, no markdown, no commentary.",
        prompt: `SECTION HEADING: ${heading}${voiceDnaBlock}

SECTION BODY:
${body}

EDITORIAL TASK:
${task}

RULES:
- Change ONLY what is necessary to address the task above
- Preserve every scripture reference, quote, and theological teaching point
- WORD COUNT: The original section is ${originalWordCount} words. Target ${minWords}–${maxWords} words (98–102% of original).
- Return the revised body as plain prose text only

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${SCRIPTURE_FORMATTING_RULES}

${PREMIUM_BOOK_STYLE_RULES}`,
      });
      text = result.text.trim();
    } catch (r1Err) {
      console.error("[apply-audit] R1 fallback also failed:", r1Err instanceof Error ? r1Err.message : r1Err);
      return body; // final fallback to original
    }
  }

  if (!text) return body;

  // Hard safety net: if the rewrite lost more than 5% of words, reject and return original.
  // This prevents accidental content deletion during surgical edits.
  const revisedWordCount = text.split(/\s+/).filter(Boolean).length;
  if (revisedWordCount < Math.floor(originalWordCount * 0.95)) {
    console.warn(
      `[apply-audit] Rewrite shrank section from ${originalWordCount} → ${revisedWordCount} words (>${Math.round((1 - revisedWordCount / originalWordCount) * 100)}% loss) — keeping original`,
    );
    return body;
  }

  return text;
}

// Concurrency-limited parallel runner
// Note: uses `any` instead of generics — SWC in Next.js 15 can mis-parse generic
// async function declarations (`async function f<T, R>(...)`) and corrupt downstream
// parsing. `any` is stripped identically by SWC without the ambiguous `<T, R>` tokens.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mapWithConcurrency(
  items: any[],
  limit: number,
  fn: (item: any) => Promise<any>,
): Promise<any[]> {
  const results: any[] = new Array(items.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// \u2500\u2500\u2500 Upgrade 7: Post-rewrite transition repair \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// After concept-duplicate removal, auto-patches the opening paragraph of the
// immediately following section and closing paragraph of the preceding one so
// the seam reads naturally without manual intervention.

type LLMTask = {
  chapterIndex: number;
  field: "intro" | "conclusion" | { sectionNumber: number };
  task: string;
  heading: string;
  body: string;
  voiceDNA?: VoiceDNAType | null;
};

type RewrittenLocation = {
  chapterIndex: number;
  field: "intro" | "conclusion" | { sectionNumber: number };
};

type TransitionTask = {
  chapterIndex: number;
  field: "intro" | "conclusion" | { sectionNumber: number };
  role: "preceding" | "following";
  headingContext: string;
  bodyToFix: string;
  adjacentEdge: string;
};

async function repairTransitions(
  chapters: ChapterInput[],
  rewritten: RewrittenLocation[],
  voiceDNA?: VoiceDNAType | null,
): Promise<ChapterInput[]> {

  const tasks: TransitionTask[] = [];

  for (const { chapterIndex, field } of rewritten) {
    const ch = chapters[chapterIndex];

    // Resolve rewritten body for edge extraction
    let rewrittenBody = "";
    if (field === "intro") {
      rewrittenBody = ch.intro;
    } else if (field === "conclusion") {
      rewrittenBody = ch.conclusion;
    } else {
      const secNum = (field as { sectionNumber: number }).sectionNumber;
      rewrittenBody = ch.sections.find((s) => s.sectionNumber === secNum)?.body ?? "";
    }

    const paras = rewrittenBody.split(/\n\n+/);
    const rewrittenOpen = (paras[0] ?? "").trim().slice(0, 220);
    const rewrittenClose = (paras.at(-1) ?? "").trim().slice(-220);

    if (field === "intro") {
      // Nothing precedes a chapter intro in the same chapter
    } else if (field === "conclusion") {
      // Preceding = last section
      const lastSec = [...ch.sections].reverse()[0];
      if (lastSec?.body) {
        tasks.push({
          chapterIndex,
          field: { sectionNumber: lastSec.sectionNumber },
          role: "preceding",
          headingContext: lastSec.heading,
          bodyToFix: lastSec.body,
          adjacentEdge: rewrittenOpen,
        });
      }
    } else {
      const secNum = (field as { sectionNumber: number }).sectionNumber;
      const secIdx = ch.sections.findIndex((s) => s.sectionNumber === secNum);

      // Preceding neighbor
      if (secIdx > 0) {
        const prev = ch.sections[secIdx - 1];
        tasks.push({
          chapterIndex,
          field: { sectionNumber: prev.sectionNumber },
          role: "preceding",
          headingContext: prev.heading,
          bodyToFix: prev.body,
          adjacentEdge: rewrittenOpen,
        });
      } else if (ch.intro) {
        tasks.push({
          chapterIndex,
          field: "intro",
          role: "preceding",
          headingContext: `Chapter ${ch.number} Introduction`,
          bodyToFix: ch.intro,
          adjacentEdge: rewrittenOpen,
        });
      }

      // Following neighbor
      if (secIdx >= 0 && secIdx < ch.sections.length - 1) {
        const next = ch.sections[secIdx + 1];
        tasks.push({
          chapterIndex,
          field: { sectionNumber: next.sectionNumber },
          role: "following",
          headingContext: next.heading,
          bodyToFix: next.body,
          adjacentEdge: rewrittenClose,
        });
      } else if (ch.conclusion) {
        tasks.push({
          chapterIndex,
          field: "conclusion",
          role: "following",
          headingContext: `Chapter ${ch.number} Conclusion`,
          bodyToFix: ch.conclusion,
          adjacentEdge: rewrittenClose,
        });
      }
    }
  }

  // Deduplicate by chapterIndex + field + role (same neighbor can appear multiple times)
  const seen = new Set<string>();
  const unique = tasks.filter((t) => {
    const key = `${t.chapterIndex}|${JSON.stringify(t.field)}|${t.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return chapters;

  const results = await mapWithConcurrency(unique, 2, async (task) => {
    const taskPrompt =
      task.role === "preceding"
        ? `The section immediately after this one has been revised. It now opens with:\n"${task.adjacentEdge}"\n\nReturn the COMPLETE section body below, changing ONLY the final paragraph so it transitions naturally into that new opening. Every other paragraph must remain word-for-word identical.`
        : `The section immediately before this one has been revised. It now ends with:\n"${task.adjacentEdge}"\n\nReturn the COMPLETE section body below, changing ONLY the opening paragraph so it follows naturally from that new closing. Every other paragraph must remain word-for-word identical.`;
    return {
      task,
      revisedBody: await reviseSectionBody(task.headingContext, task.bodyToFix, taskPrompt, voiceDNA),
    };
  });

  let updated = [...chapters];
  for (const { task, revisedBody } of results) {
    const ch = updated[task.chapterIndex];
    if (task.field === "intro") {
      updated[task.chapterIndex] = { ...ch, intro: revisedBody };
    } else if (task.field === "conclusion") {
      updated[task.chapterIndex] = { ...ch, conclusion: revisedBody };
    } else {
      const secNum = (task.field as { sectionNumber: number }).sectionNumber;
      updated[task.chapterIndex] = {
        ...ch,
        sections: ch.sections.map((s) =>
          s.sectionNumber === secNum
            ? { ...s, body: revisedBody, wordCount: revisedBody.split(/\s+/).filter(Boolean).length }
            : s,
        ),
      };
    }
  }

  return updated;
}

// \u2500\u2500\u2500 Route Handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n// Exported as const arrow to avoid a Next.js 15.5 SWC parser bug where
// `async function POST` declarations after complex generic/IIFE helpers
// have their returns flagged as module-level. Arrow form parses correctly.
export const POST = async (req: NextRequest): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }

  const { manifest, report, appliedKeys, voiceDNA } = parsed.data;

  if (appliedKeys.length === 0) {
    return NextResponse.json({ chapters: manifest.chapters }, { status: 200 });
  }

  // Deep clone chapters so we can mutate them safely
  let chapters: ChapterInput[] = manifest.chapters.map((c) => ({
    ...c,
    sections: c.sections.map((s) => ({ ...s })),
  }));

  // ── Tier 1: Algorithmic fixes (no LLM, no risk of extra rewrites) ───────────

  for (const key of appliedKeys) {
    if (key.startsWith("r-")) {
      const idx = parseInt(key.slice(2));
      const rep = report.repetitions[idx];
      if (!rep || !rep.alternatives.length) continue;
      // Apply globally across ALL chapters (repetition is a manuscript-wide stat)
      chapters = chapters.map((ch) =>
        mapChapterText(ch, (text) => applyPhraseVariation(text, rep.phrase, rep.alternatives)),
      );
    }

    if (key.startsWith("w-")) {
      const idx = parseInt(key.slice(2));
      const ow = report.overusedWords[idx];
      if (!ow || !ow.alternatives.length) continue;
      chapters = chapters.map((ch) =>
        mapChapterText(ch, (text) => applyWordVariation(text, ow.word, ow.alternatives)),
      );
    }
  }

  // ── Tier 2: Faithful to speaker's progression — only delete obvious copy-paste errors ──
  // STRATEGY: The book should follow the speaker's natural teaching flow. If they revisited
  // a concept later in the transcript, that was intentional pedagogical reinforcement.
  // ONLY delete sections that are clearly copy-paste errors (>98% verbatim duplication).

  function calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(tokenizeContent(text1));
    const words2 = new Set(tokenizeContent(text2));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  const sectionsToDelete: { chapterNum: number; sectionNum: number }[] = [];
  const llmTasks: LLMTask[] = [];

  for (const key of appliedKeys) {
    // ── Concept duplicates — only delete if >98% verbatim (copy-paste error) ──────────
    // If the speaker naturally covered the same concept again in their teaching,
    // preserve it. Only remove obvious technical duplication errors.
    if (key.startsWith("c-")) {
      const idx = parseInt(key.slice(2));
      const dup = report.conceptDuplicates[idx];
      if (!dup || dup.locations.length < 2) continue;

      for (let li = 1; li < dup.locations.length; li++) {
        const { chapterNum, sectionNum } = parseLocation(dup.locations[li].location);
        if (chapterNum === null || sectionNum === null) continue;

        // Check if this is a copy-paste error (near-verbatim text)
        const firstExcerpt = dup.locations[0].excerpt || "";
        const thisExcerpt = dup.locations[li].excerpt || "";
        const similarity = firstExcerpt && thisExcerpt 
          ? calculateTextSimilarity(firstExcerpt, thisExcerpt) 
          : 0;

        // Only delete if >98% similar (clear copy-paste error, not intentional reinforcement)
        if (similarity > 0.98) {
          sectionsToDelete.push({ chapterNum, sectionNum });
        }
        // Otherwise: preserve it — the speaker chose to revisit this concept
      }
    }

    // ── Similar pairs — only delete if >98% similar (copy-paste error) ─────────────────
    if (key.startsWith("p-")) {
      const idx = parseInt(key.slice(2));
      const pair = report.similarPairs[idx];
      if (!pair) continue;

      const locB = parseLocation(pair.locationB);
      if (locB.chapterNum !== null && locB.sectionNum !== null) {
        // Only delete if >98% similar (clear technical duplication)
        if (pair.similarity > 0.98) {
          sectionsToDelete.push({ chapterNum: locB.chapterNum, sectionNum: locB.sectionNum });
        }
        // Otherwise: preserve it — follow the speaker's natural progression
      }
    }
  }

  // Execute deletions and capture neighbor pairs for seam repair
  type SeamTask = {
    chapterIndex: number;
    precedingSecNum: number;
    precedingHeading: string;
    precedingBody: string;
    followingSecNum: number;
    followingHeading: string;
    followingBody: string;
  };
  const seamTasks: SeamTask[] = [];

  // Deduplicate: a section might be nominated for deletion by multiple keys
  const deletionSet = new Set(sectionsToDelete.map((d) => `${d.chapterNum}:${d.sectionNum}`));
  for (const key of Array.from(deletionSet)) {
    const [chapterNum, sectionNum] = key.split(":").map(Number);
    const chIdx = chapters.findIndex((c) => c.number === chapterNum);
    if (chIdx === -1) continue;
    const ch = chapters[chIdx];
    const secIdx = ch.sections.findIndex((s) => s.sectionNumber === sectionNum);
    if (secIdx === -1) continue;

    // Capture neighbors for seam repair BEFORE mutating
    const precSec = secIdx > 0 ? ch.sections[secIdx - 1] : null;
    const follSec = secIdx < ch.sections.length - 1 ? ch.sections[secIdx + 1] : null;
    if (precSec && follSec) {
      seamTasks.push({
        chapterIndex: chIdx,
        precedingSecNum: precSec.sectionNumber,
        precedingHeading: precSec.heading,
        precedingBody: precSec.body,
        followingSecNum: follSec.sectionNumber,
        followingHeading: follSec.heading,
        followingBody: follSec.body,
      });
    }

    // Delete the section and recalculate the chapter word count
    const updatedSections = ch.sections.filter((s) => s.sectionNumber !== sectionNum);
    const updatedWordCount = updatedSections.reduce((sum, s) => sum + s.wordCount, 0);
    chapters[chIdx] = { ...ch, sections: updatedSections, totalWordCount: updatedWordCount };
  }

  // Repair seams between now-adjacent sections where a deletion created a gap
  if (seamTasks.length > 0) {
    const seamResults = await mapWithConcurrency(seamTasks, 2, async (task) => {
      const follOpen = (task.followingBody.split(/\n\n+/)[0] ?? "").trim().slice(0, 200);
      const precClose = (task.precedingBody.split(/\n\n+/).at(-1) ?? "").trim().slice(-200);

      const [precRevised, follRevised] = await Promise.all([
        reviseSectionBody(
          task.precedingHeading,
          task.precedingBody,
          `A duplicate section that immediately followed this one has been removed. Return the COMPLETE body, changing ONLY the final paragraph so it transitions naturally into the section that now follows, which opens with: "${follOpen}". Every other paragraph must remain word-for-word identical.`,
          voiceDNA,
        ),
        reviseSectionBody(
          task.followingHeading,
          task.followingBody,
          `A duplicate section that immediately preceded this one has been removed. Return the COMPLETE body, changing ONLY the opening paragraph so it follows naturally from the section that now precedes it, which ends with: "${precClose}". Every other paragraph must remain word-for-word identical.`,
          voiceDNA,
        ),
      ]);

      return { task, precRevised, follRevised };
    });

    for (const { task, precRevised, follRevised } of seamResults) {
      const ch = chapters[task.chapterIndex];
      chapters[task.chapterIndex] = {
        ...ch,
        sections: ch.sections.map((s) => {
          if (s.sectionNumber === task.precedingSecNum)
            return { ...s, body: precRevised, wordCount: precRevised.split(/\s+/).filter(Boolean).length };
          if (s.sectionNumber === task.followingSecNum)
            return { ...s, body: follRevised, wordCount: follRevised.split(/\s+/).filter(Boolean).length };
          return s;
        }),
      };
    }
  }

  // Run LLM tasks with concurrency limit (max 4 at a time)
  if (llmTasks.length > 0) {
    const results = await mapWithConcurrency(llmTasks, 4, async (task) => ({
      task,
      revisedBody: await reviseSectionBody(task.heading, task.body, task.task, task.voiceDNA),
    }));

    // Apply results back into the chapters array
    for (const { task, revisedBody } of results) {
      const ch = chapters[task.chapterIndex];
      if (task.field === "intro") {
        chapters[task.chapterIndex] = { ...ch, intro: revisedBody };
      } else if (task.field === "conclusion") {
        chapters[task.chapterIndex] = { ...ch, conclusion: revisedBody };
      } else {
        const secNum = (task.field as { sectionNumber: number }).sectionNumber;
        chapters[task.chapterIndex] = {
          ...ch,
          sections: ch.sections.map((s) =>
            s.sectionNumber === secNum
              ? { ...s, body: revisedBody, wordCount: revisedBody.split(/\s+/).filter(Boolean).length }
              : s,
          ),
        };
      }
    }

    // Upgrade 7: patch transition seams in sections adjacent to any rewritten section
    const rewrittenLocations: RewrittenLocation[] = results.map(({ task }) => ({
      chapterIndex: task.chapterIndex,
      field: task.field,
    }));
    chapters = await repairTransitions(chapters, rewrittenLocations, voiceDNA);
  }

  return NextResponse.json({ chapters }, { status: 200 });
}
