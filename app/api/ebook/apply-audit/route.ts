import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import { z } from "zod";
import { BackMatterSchema, FrontBackMatterSchema, VoiceDNASchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, PROSE_MASTERY_RULES, PREMIUM_BOOK_STYLE_RULES, READER_NORMALIZATION_RULES } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

type VoiceDNAType = z.infer<typeof VoiceDNASchema>;
type FrontMatterInput = z.infer<typeof FrontBackMatterSchema>;
type BackMatterInput = z.infer<typeof BackMatterSchema>;

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
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  totalWordCount: z.number().default(0),
  status: z.string().default("complete"),
});

const RequestSchema = z.object({
  manifest: z.object({
    chapters: z.array(ChapterSchema),
    frontMatter: FrontBackMatterSchema,
    backMatter: BackMatterSchema.nullable().optional(),
  }),
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
    styleViolations: z.array(z.object({
      location: z.string(),
      ruleType: z.string(),
      match: z.string(),
      context: z.string(),
      suggestion: z.string(),
    })).default([]),
    scriptureIssues: z.array(z.object({
      location: z.string(),
      issueType: z.string(),
      reference: z.string(),
      excerpt: z.string(),
      recommendation: z.string(),
    })).default([]),
    contradictions: z.array(z.object({
      type: z.string(),
      description: z.string(),
      locationA: z.string(),
      excerptA: z.string().default(""),
      locationB: z.string(),
      excerptB: z.string().default(""),
      severity: z.string(),
      recommendation: z.string(),
    })).default([]),
  }),
  appliedKeys: z.array(z.string().regex(/^(?:c|p|r|w|s|q|d)-\d+$/)).max(200),
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

/** Apply a text transformation to every prose field in a chapter's sections and intro. */
function mapChapterText(
  chapter: ChapterInput,
  transform: (text: string) => string,
): ChapterInput {
  return {
    ...chapter,
    intro: transform(chapter.intro),
    sections: chapter.sections.map((s) => {
      const body = transform(s.body);
      return { ...s, body, wordCount: body.split(/\s+/).filter(Boolean).length };
    }),
  };
}

function mapMatterText(
  frontMatter: FrontMatterInput,
  backMatter: BackMatterInput | null | undefined,
  transform: (text: string) => string,
): { frontMatter: FrontMatterInput; backMatter: BackMatterInput | null | undefined } {
  return {
    frontMatter: {
      ...frontMatter,
      preface: transform(frontMatter.preface),
      introduction: transform(frontMatter.introduction),
      conclusion: transform(frontMatter.conclusion),
      aboutAuthor: frontMatter.aboutAuthor === null ? null : transform(frontMatter.aboutAuthor),
      additionalSections: frontMatter.additionalSections?.map((section) => ({
        ...section,
        content: transform(section.content),
      })),
    },
    backMatter: backMatter
      ? {
          ...backMatter,
          additionalSections: backMatter.additionalSections?.map((section) => ({
            ...section,
            content: transform(section.content),
          })),
        }
      : backMatter,
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
  const minWords = Math.max(1, Math.floor(originalWordCount * 0.5));
  const maxWords = Math.ceil(originalWordCount * 1.15);
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
      throw new Error("Could not generate an audit repair proposal with either configured model.");
    }
  }

  if (!text) throw new Error("The model returned an empty audit repair proposal.");

  // Hard safety net: if the rewrite lost more than 5% of words, reject and return original.
  // This prevents accidental content deletion during surgical edits.
  const revisedWordCount = text.split(/\s+/).filter(Boolean).length;
  if (revisedWordCount < minWords || revisedWordCount > maxWords) {
    throw new Error(`The proposed repair was outside the allowed length range (${minWords}–${maxWords} words).`);
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
  field: "intro" | { sectionNumber: number };
  task: string;
  heading: string;
  body: string;
  voiceDNA?: VoiceDNAType | null;
};

type MatterTarget =
  | { area: "front"; field: "preface" | "introduction" | "conclusion" | "aboutAuthor" }
  | { area: "front"; additionalSectionIndex: number }
  | { area: "back"; additionalSectionIndex: number };

type MatterLLMTask = {
  target: MatterTarget;
  task: string;
  heading: string;
  body: string;
  voiceDNA?: VoiceDNAType | null;
};

function resolveMatterTarget(
  location: string,
  frontMatter: z.infer<typeof FrontBackMatterSchema>,
  backMatter: z.infer<typeof BackMatterSchema> | null | undefined,
): MatterLLMTask | null {
  const match = /^(Front|Back) Matter\s*[–-]\s*(.+)$/i.exec(location.trim());
  if (!match) return null;
  const area = match[1].toLowerCase() === "front" ? "front" : "back";
  const label = match[2].trim();
  const fields = {
    Preface: "preface",
    Introduction: "introduction",
    Conclusion: "conclusion",
    "About the Author": "aboutAuthor",
  } as const;

  if (area === "front") {
    const field = fields[label as keyof typeof fields];
    if (field) {
      return {
        target: { area, field },
        task: "",
        heading: label,
        body: frontMatter[field] ?? "",
      };
    }
    const additionalSectionIndex = (frontMatter.additionalSections ?? [])
      .findIndex((section) => section.title.trim().toLowerCase() === label.toLowerCase());
    if (additionalSectionIndex >= 0) {
      const section = frontMatter.additionalSections?.[additionalSectionIndex];
      if (!section) return null;
      return {
        target: { area, additionalSectionIndex },
        task: "",
        heading: section.title,
        body: section.content,
      };
    }
    return null;
  }

  const additionalSectionIndex = (backMatter?.additionalSections ?? [])
    .findIndex((section) => section.title.trim().toLowerCase() === label.toLowerCase());
  if (additionalSectionIndex < 0) return null;
  const section = backMatter?.additionalSections?.[additionalSectionIndex];
  if (!section) return null;
  return {
    target: { area, additionalSectionIndex },
    task: "",
    heading: section.title,
    body: section.content,
  };
}

type RewrittenLocation = {
  chapterIndex: number;
  field: "intro" | { sectionNumber: number };
};

type TransitionTask = {
  chapterIndex: number;
  field: "intro" | { sectionNumber: number };
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
    } else {
      const secNum = (field as { sectionNumber: number }).sectionNumber;
      rewrittenBody = ch.sections.find((s) => s.sectionNumber === secNum)?.body ?? "";
    }

    const paras = rewrittenBody.split(/\n\n+/);
    const rewrittenOpen = (paras[0] ?? "").trim().slice(0, 220);
    const rewrittenClose = (paras.at(-1) ?? "").trim().slice(-220);

    if (field === "intro") {
      // Nothing precedes a chapter intro in the same chapter
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
    return NextResponse.json({
      proposedChapters: manifest.chapters,
      proposedFrontMatter: manifest.frontMatter,
      proposedBackMatter: manifest.backMatter,
    }, { status: 200 });
  }

  let chapters: ChapterInput[] = manifest.chapters.map((c) => ({
    ...c,
    sections: c.sections.map((s) => ({ ...s })),
  }));
  let frontMatter = structuredClone(manifest.frontMatter);
  let backMatter = manifest.backMatter ? structuredClone(manifest.backMatter) : manifest.backMatter;

  // ── Tier 1: Algorithmic fixes (no LLM, no risk of extra rewrites) ───────────

  for (const key of appliedKeys) {
    if (key.startsWith("r-")) {
      const idx = parseInt(key.slice(2));
      const rep = report.repetitions[idx];
      if (!rep || !rep.alternatives.length) continue;
      chapters = chapters.map((ch) =>
        mapChapterText(ch, (text) => applyPhraseVariation(text, rep.phrase, rep.alternatives)),
      );
      ({ frontMatter, backMatter } = mapMatterText(frontMatter, backMatter, (text) => applyPhraseVariation(text, rep.phrase, rep.alternatives)));
    }

    if (key.startsWith("w-")) {
      const idx = parseInt(key.slice(2));
      const ow = report.overusedWords[idx];
      if (!ow || !ow.alternatives.length) continue;
      chapters = chapters.map((ch) =>
        mapChapterText(ch, (text) => applyWordVariation(text, ow.word, ow.alternatives)),
      );
      ({ frontMatter, backMatter } = mapMatterText(frontMatter, backMatter, (text) => applyWordVariation(text, ow.word, ow.alternatives)));
    }
  }

  const chapterTasks = new Map<string, LLMTask>();
  const matterTasks = new Map<string, MatterLLMTask>();

  function queueRepair(location: string, task: string): void {
    const matterTarget = resolveMatterTarget(location, frontMatter, backMatter);
    if (matterTarget) {
      if (!matterTarget.body.trim()) return;
      const target = matterTarget.target;
      const key = target.area === "front" && "field" in target
        ? `front:${target.field}`
        : target.area === "front"
          ? `front-additional:${target.additionalSectionIndex}`
          : `back-additional:${target.additionalSectionIndex}`;
      const existing = matterTasks.get(key);
      if (existing) {
        existing.task += `\n\n${task}`;
      } else {
        matterTasks.set(key, { ...matterTarget, task, voiceDNA });
      }
      return;
    }

    const { chapterNum, sectionNum } = parseLocation(location);
    if (chapterNum === null) return;
    const chapterIndex = chapters.findIndex((chapter) => chapter.number === chapterNum);
    if (chapterIndex < 0) return;
    const chapter = chapters[chapterIndex];
    let field: LLMTask["field"];
    let heading: string;
    let body: string;
    if (sectionNum !== null) {
      const section = chapter.sections.find((candidate) => candidate.sectionNumber === sectionNum);
      if (!section) return;
      field = { sectionNumber: sectionNum };
      heading = section.heading;
      body = section.body;
    } else if (/\bintro(?:duction)?\b/i.test(location)) {
      field = "intro";
      heading = `Chapter ${chapterNum} Introduction`;
      body = chapter.intro;
    } else {
      return;
    }
    if (!body.trim()) return;
    const key = `${chapterIndex}:${JSON.stringify(field)}`;
    const existing = chapterTasks.get(key);
    if (existing) {
      existing.task += `\n\n${task}`;
    } else {
      chapterTasks.set(key, { chapterIndex, field, heading, body, task, voiceDNA });
    }
  }

  for (const key of appliedKeys) {
    if (key.startsWith("c-")) {
      const duplicate = report.conceptDuplicates[Number(key.slice(2))];
      if (!duplicate || duplicate.locations.length < 2) continue;
      const canonical = duplicate.locations.find((location) =>
        parseLocation(location.location).sectionNum !== null,
      ) ?? duplicate.locations[0];
      for (const target of duplicate.locations) {
        if (target.location === canonical.location) continue;
        const matterRole = /^Front Matter\s*[–-]\s*/i.test(target.location)
          ? `\nApply the section's role: Preface is author context; Introduction is reader need, promise, scope, and roadmap; Conclusion is synthesis and implications.`
          : "";
        queueRepair(target.location, `A concept overlaps the protected primary treatment at ${canonical.location}. ${duplicate.description}\nAudit recommendation: ${duplicate.recommendation}\nProtected excerpt: ${canonical.excerpt}\nTarget excerpt: ${target.excerpt}\nRevise this target to remove only the redundant treatment while retaining any unique contribution.${matterRole}`);
      }
    }

    if (key.startsWith("p-")) {
      const pair = report.similarPairs[Number(key.slice(2))];
      if (!pair) continue;
      const targetLocation = resolveMatterTarget(pair.locationA, frontMatter, backMatter)
        ? pair.locationA
        : pair.locationB;
      const protectedLocation = targetLocation === pair.locationA ? pair.locationB : pair.locationA;
      queueRepair(targetLocation, `This location overlaps ${protectedLocation} (${Math.round(pair.similarity * 100)}% lexical similarity). Keep the protected section's distinct teaching intact and revise this target only to remove repeated material while preserving its unique point.\nProtected excerpt: ${targetLocation === pair.locationA ? pair.excerptB : pair.excerptA}\nTarget excerpt: ${targetLocation === pair.locationA ? pair.excerptA : pair.excerptB}`);
    }

    if (key.startsWith("s-")) {
      const issue = report.styleViolations[Number(key.slice(2))];
      if (issue) {
        queueRepair(issue.location, `Fix the style violation “${issue.match}” in this passage. Follow this recommendation: ${issue.suggestion}\nEvidence: ${issue.context}\nPreserve the original meaning and voice.`);
      }
    }

    if (key.startsWith("q-")) {
      const issue = report.scriptureIssues[Number(key.slice(2))];
      if (issue) {
        queueRepair(issue.location, `Correct the Scripture citation issue (${issue.issueType}) for ${issue.reference}. Follow this recommendation: ${issue.recommendation}\nEvidence: ${issue.excerpt}\nPreserve quoted Scripture exactly unless the finding explicitly identifies its quotation as the error. Never invent or paraphrase Scripture text.`);
      }
    }

    if (key.startsWith("d-")) {
      const issue = report.contradictions[Number(key.slice(2))];
      if (!issue) continue;
      const locationAIsMatter = Boolean(resolveMatterTarget(issue.locationA, frontMatter, backMatter));
      const locationBIsMatter = Boolean(resolveMatterTarget(issue.locationB, frontMatter, backMatter));
      const targetLocation = locationBIsMatter ? issue.locationB : locationAIsMatter ? issue.locationA : issue.locationB;
      const protectedLocation = targetLocation === issue.locationA ? issue.locationB : issue.locationA;
      queueRepair(targetLocation, `Resolve this ${issue.type} contradiction while preserving accurate nuance. ${issue.description}\nAudit recommendation: ${issue.recommendation}\nProtected claim at ${protectedLocation}: ${targetLocation === issue.locationA ? issue.excerptB : issue.excerptA}\nClaim to revise: ${targetLocation === issue.locationA ? issue.excerptA : issue.excerptB}\nChange only the claim that conflicts with the book's supported position; if evidence is insufficient, make the smallest clarifying qualification.`);
    }
  }

  const chapterTasksToRun = Array.from(chapterTasks.values());
  const matterTasksToRun = Array.from(matterTasks.values());
  let chapterResults: Array<{ task: LLMTask; revisedBody: string }> = [];
  let matterResults: Array<{ task: MatterLLMTask; revisedBody: string }> = [];
  try {
    [chapterResults, matterResults] = await Promise.all([
      mapWithConcurrency(chapterTasksToRun, 4, async (task) => ({
        task,
        revisedBody: await reviseSectionBody(task.heading, task.body, task.task, task.voiceDNA),
      })),
      mapWithConcurrency(matterTasksToRun, 2, async (task) => ({
        task,
        revisedBody: await reviseSectionBody(task.heading, task.body, task.task, task.voiceDNA),
      })),
    ]);
  } catch (err) {
    console.error("[apply-audit] Could not generate repair proposal:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not generate an audit repair proposal." },
      { status: 502 },
    );
  }

  for (const { task, revisedBody } of chapterResults) {
    const ch = chapters[task.chapterIndex];
    if (task.field === "intro") {
      chapters[task.chapterIndex] = { ...ch, intro: revisedBody };
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

  for (const { task, revisedBody } of matterResults) {
    const target = task.target;
    if (target.area === "front" && "field" in target) {
      frontMatter = { ...frontMatter, [target.field]: revisedBody };
    } else if (target.area === "front" && "additionalSectionIndex" in target) {
      frontMatter = {
        ...frontMatter,
        additionalSections: (frontMatter.additionalSections ?? []).map((section, index) =>
          index === target.additionalSectionIndex ? { ...section, content: revisedBody } : section,
        ),
      };
    } else if (target.area === "back" && backMatter) {
      backMatter = {
        ...backMatter,
        additionalSections: (backMatter.additionalSections ?? []).map((section, index) =>
          index === target.additionalSectionIndex ? { ...section, content: revisedBody } : section,
        ),
      };
    }
  }

  if (chapterResults.length > 0) {
    chapters = await repairTransitions(chapters, chapterResults.map(({ task }) => ({
      chapterIndex: task.chapterIndex,
      field: task.field,
    })), voiceDNA);
  }

  return NextResponse.json({
    proposedChapters: chapters,
    proposedFrontMatter: frontMatter,
    proposedBackMatter: backMatter,
  }, { status: 200 });
}
