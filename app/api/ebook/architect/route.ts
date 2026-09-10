import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { ArchitectRequestSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── Minimal schema — LLM output as-is, no post-processing ────────────────────
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
  bookTitle: z.string().default("Untitled"),
  subtitle: z.string().default(""),
  authorName: z.string().default("the Author"),
  estimatedTotalWords: z.number().default(0),
  frontMatterNotes: z.string().default(""),
  backMatterNotes: z.string().default(""),
  chapters: z.array(MinimalChapterSchema).default([]),
});

function clampSectionCount(segmentCount: number, requestedCount: number): number {
  if (segmentCount <= 0) return 0;
  const bounded = Math.max(4, Math.min(5, requestedCount || 4));
  return Math.min(segmentCount, bounded);
}

function buildContiguousBucketSizes(segmentCount: number, sectionCount: number): number[] {
  if (sectionCount <= 0 || segmentCount <= 0) return [];
  const safeSectionCount = Math.min(sectionCount, segmentCount);

  // Prefer at least 2 segments per section when mathematically possible.
  if (segmentCount >= safeSectionCount * 2) {
    const sizes = Array(safeSectionCount).fill(2);
    let remaining = segmentCount - safeSectionCount * 2;
    let idx = 0;
    while (remaining > 0) {
      sizes[idx] += 1;
      idx = (idx + 1) % safeSectionCount;
      remaining -= 1;
    }
    return sizes;
  }

  // Otherwise distribute as evenly as possible with minimum 1.
  const base = Math.floor(segmentCount / safeSectionCount);
  let remainder = segmentCount % safeSectionCount;
  return Array.from({ length: safeSectionCount }, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return base + extra;
  });
}

function buildDeterministicSections(
  segs: Array<{ id: string; topic: string; estimatedWordCount?: number }>,
  plannedSections: Array<{ heading?: string }> | undefined,
) {
  const requestedCount = plannedSections?.length ?? 4;
  const sectionCount = clampSectionCount(segs.length, requestedCount);
  const sizes = buildContiguousBucketSizes(segs.length, sectionCount);

  let cursor = 0;
  return sizes.map((size, idx) => {
    const bucket = segs.slice(cursor, cursor + size);
    cursor += size;

    const fallbackHeading = bucket[0]?.topic || `Section ${idx + 1}`;
    const heading = (plannedSections?.[idx]?.heading || "").trim() || fallbackHeading;

    return {
      sectionNumber: idx + 1,
      heading,
      sourceSegmentIds: bucket.map((s) => s.id),
      targetWordCount: bucket.reduce((sum, s) => sum + (s.estimatedWordCount || 0), 0),
    };
  });
}

// ── Simple fallback: group by audio, use topic as chapter title ──────────────
function simpleFallback(input: z.infer<typeof ArchitectRequestSchema>) {
  const audioOrder = ["audio-1", "audio-2", "audio-3", "audio-4", "audio-5", "audio-6", "audio-7", "audio-8", "audio-9", "audio-10"];
  const segmentsByAudio = new Map<string, typeof input.contentMap.segments>();
  
  for (const seg of input.contentMap.segments) {
    const bucket = segmentsByAudio.get(seg.sourceAudio) ?? [];
    bucket.push(seg);
    segmentsByAudio.set(seg.sourceAudio, bucket);
  }

  const audioKeys = audioOrder.filter((k) => segmentsByAudio.has(k));
  const chapters = audioKeys.map((audioKey, idx) => {
    const segs = segmentsByAudio.get(audioKey)!;
    const chapterTitle = (input.contentMap.overarchingThemes[idx] || "").trim()
      || segs[0]?.topic || `Chapter ${idx + 1}`;
    
    // Simple 1-segment = 1-section mapping for fallback
    const sections = segs.map((seg, si) => ({
      sectionNumber: si + 1,
      heading: seg.topic,
      sourceSegmentIds: [seg.id],
      targetWordCount: seg.estimatedWordCount || 500,
    }));

    return { number: idx + 1, title: chapterTitle, keyTheme: chapterTitle, sections };
  });

  return {
    bookTitle: input.contentMap.coreThesis || input.contentMap.overarchingThemes[0] || "Untitled",
    subtitle: input.contentMap.targetAudience || input.contentMap.teachingArc || "",
    authorName: "the Author",
    estimatedTotalWords: chapters.flatMap((c) => c.sections).reduce((sum, s) => sum + s.targetWordCount, 0),
    frontMatterNotes: input.contentMap.coreThesis || "",
    backMatterNotes: input.contentMap.teachingArc || "",
    chapters,
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

  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════
AUTHOR BOOK CONFIGURATION (tone & audience only)
════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}\nEvery chapter heading, section depth, and conceptual progression must be appropriate for this specific audience. Adjust complexity, terminology, and pacing accordingly.` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}\nThese instructions apply to how the book is structured AND written. Honor them when designing chapters and sections.` : ""}

⚠️ CRITICAL BOUNDARY: Author configuration applies ONLY to tone, vocabulary, pacing, and audience calibration. It DOES NOT grant permission to:
  • Fabricate chapter themes or section breakdowns
  • Add structure that requires content not in the source material
  • Split or reorganize segments to achieve the author's style
  • Override SOURCE-LOCK-RULES in ANY way

Every chapter heading and section must come from the actual transcript. When author instructions would require new content, prioritize the actual teaching material instead.`
    : "";

  const segmentMap = Object.fromEntries(input.contentMap.segments.map((s) => [s.id, s]));
  const validSegmentIds = new Set(input.contentMap.segments.map((s) => s.id));
  const quoteMap = Object.fromEntries((input.contentMap.allQuotes ?? []).map((q) => [q.id, q]));

  try {
    let minimal: z.infer<typeof MinimalArchitectureSchema>;

    if (input.oneChapterPerUpload) {
      // ── Per-audio LLM calls: Trust the LLM to produce good chapter/section structure ──
      const audioOrder = ["audio-1", "audio-2", "audio-3", "audio-4", "audio-5", "audio-6", "audio-7", "audio-8", "audio-9", "audio-10"] as const;
      const segsByAudio = new Map<string, typeof input.contentMap.segments>();
      
      for (const seg of input.contentMap.segments) {
        const bucket = segsByAudio.get(seg.sourceAudio) ?? [];
        bucket.push(seg);
        segsByAudio.set(seg.sourceAudio, bucket);
      }
      
      const audioKeys = audioOrder.filter((k) => segsByAudio.has(k));

      const chapterPlans = await Promise.all(
        audioKeys.map(async (audioKey, idx) => {
          const segs = segsByAudio.get(audioKey)!;
          const chapterHint = (input.contentMap.overarchingThemes[idx] || segs[0]?.topic || "").trim();
          
          const MAX_WORDS = 1200;
          const transcriptBlock = segs.map((seg) => {
            const words = (seg.rawText ?? "").split(/\s+/);
            const truncated = words.length > MAX_WORDS
              ? words.slice(0, MAX_WORDS).join(" ") + " […]"
              : (seg.rawText ?? "");
            return [
              `[SEGMENT ${seg.id}]`,
              `TOPIC: ${seg.topic}`,
              `KEY POINTS: ${(seg.keyPoints ?? []).slice(0, 3).join("; ")}`,
              `TRANSCRIPT: ${truncated}`,
            ].join("\n");
          }).join("\n\n" + "─".repeat(40) + "\n\n");

          try {
            const { object } = await generateObject({
                model: deepSeekReasonerModel,
              schema: MinimalChapterSchema,
              mode: "json",
                temperature: 1,
              maxTokens: 8000,
              system: `You are a structural editor. Transform a sermon into a book chapter.

RULES:
• Every title and heading comes from the transcript — no fabrication
• Chapter title: 4-7 words, punchy, complete phrase
• Section headings: 4-8 words, complete phrases, must make sense standalone
• Never start headings with: Introduction, Intro, Overview, Opening, Summary, Conclusion
• Never end headings with: to, in, for, on, the, our, and, but, or, let (complete the thought!)
• Minimum 4 sections, maximum 5 sections per chapter (never fewer than 4, never more than 5)
• CRITICAL: Sections MUST follow transcript order — first section uses early excerpts, final section uses late excerpts
• CRITICAL: Excerpt distribution must be roughly balanced — if 20 excerpts exist and you create 5 sections, each gets ~4 excerpts (±1 okay, but never 4-4-4-4-4 with 0 remaining)
• CRITICAL: No section should contain fewer than 2 excerpts — thin sections indicate poor structuring
• Each section: one focused teaching point from that part of the transcript
• Every segment ID appears in exactly one section, in order
• targetWordCount = sum of assigned segments' word counts

${SOURCE_LOCK_RULES}${authorConfigBlock}`,

              prompt: `SEGMENT IDs (IN ORDER): ${segs.map((s) => s.id).join(", ")}
TOTAL EXCERPTS: ${segs.length}
THEME: ${chapterHint}
CORE THESIS: ${input.contentMap.coreThesis}
VOICE TONE: ${input.voiceDNA.toneProfile}

STRUCTURE CONSTRAINT: Divide these ${segs.length} segments into 4-5 sections, each covering a contiguous block of the transcript in chronological order.

${transcriptBlock}`,
            });
            return object;
          } catch {
            return null;
          }
        })
      );

      const chapters = chapterPlans.map((plan, idx) => {
        const segs = segsByAudio.get(audioKeys[idx])!;
        const themeHint = (input.contentMap.overarchingThemes[idx] || segs[0]?.topic || `Chapter ${idx + 1}`).trim();

        const deterministicSections = buildDeterministicSections(
          segs,
          plan?.sections?.map((s) => ({ heading: s.heading }))
        );

        return {
          number: idx + 1,
          title: (plan.title || themeHint).trim(),
          keyTheme: (plan.keyTheme || plan.title || themeHint).trim(),
          sections: deterministicSections,
        };
      });

      minimal = {
        bookTitle: (input.contentMap.overarchingThemes[0] || chapters[0]?.title || "Untitled").trim(),
        subtitle: input.contentMap.targetAudience || input.contentMap.teachingArc || "",
        authorName: "the Author",
        estimatedTotalWords: chapters.flatMap((c) => c.sections).reduce((sum, s) => sum + (s.targetWordCount || 0), 0),
        frontMatterNotes: input.contentMap.coreThesis || "",
        backMatterNotes: input.contentMap.teachingArc || "",
        chapters,
      };
    } else {
      // Fallback: simple grouping by audio
      minimal = simpleFallback(input);
    }

    // ── Simple validation: ensure segment uniqueness, warn on bad headings ────────
    const globalUsedSegIds = new Set<string>();
    const chapters = (minimal.chapters ?? [])
      .map((chapter, cidx) => ({
        number: Math.max(1, chapter.number || cidx + 1),
        title: (chapter.title || "Chapter " + (cidx + 1)).trim(),
        keyTheme: (chapter.keyTheme || chapter.title || "").trim(),
        sections: (chapter.sections ?? [])
          .map((section, sidx) => {
            const uniqueIds = (section.sourceSegmentIds ?? [])
              .filter((id) => validSegmentIds.has(id) && !globalUsedSegIds.has(id));
            uniqueIds.forEach((id) => globalUsedSegIds.add(id));
            return {
              sectionNumber: Math.max(1, section.sectionNumber || sidx + 1),
              heading: ((section.heading || "").trim() || `Section ${sidx + 1}`),
              sourceSegmentIds: uniqueIds,
              targetWordCount: Math.max(0, section.targetWordCount || 0),
            };
          })
          .filter((sec) => sec.sourceSegmentIds.length > 0)
          .map((sec, si) => ({ ...sec, sectionNumber: si + 1 })),
      }))
        .filter((ch) => ch.sections.length > 0);

    // ── Warn-only on heading quality (no mutations) ─────────────────────────────
    const warnings: string[] = [];
    const DANGLING_END = /\b(to|our|the|in|for|on|and|but|or|let|a|an|its|their|them|it)$/i;

    for (const ch of chapters) {
      for (const sec of ch.sections) {
        const words = sec.heading.split(/\s+/);
        if (words.length > 8) warnings.push(`Ch${ch.number} §${sec.sectionNumber}: Long heading (${words.length} words)`);
        if (DANGLING_END.test(sec.heading)) warnings.push(`Ch${ch.number} §${sec.sectionNumber}: Dangling ending: "${sec.heading}"`);
      }

      // ── Validate section ordering and balance ──────────────────────────────
      const allSegIds = input.contentMap.segments.map((s) => s.id);
      let lastSeenIdx = -1;
      
      for (const sec of ch.sections) {
        const segIndices = sec.sourceSegmentIds.map((id) => allSegIds.indexOf(id));
        const minIdx = Math.min(...segIndices);
        
        // Check order: sections must follow transcript progression
        if (minIdx < lastSeenIdx) {
          warnings.push(`Ch${ch.number} §${sec.sectionNumber}: Out of order — uses excerpts before previous section`);
        }
        
        // Check minimum coverage: each section should have at least 2 excerpts
        if (sec.sourceSegmentIds.length < 2) {
          warnings.push(`Ch${ch.number} §${sec.sectionNumber}: Thin section (${sec.sourceSegmentIds.length} excerpt) — may lack substantive content`);
        }
        
        lastSeenIdx = Math.max(lastSeenIdx, ...segIndices);
      }

        if (ch.sections.length < 4 || ch.sections.length > 5) {
          warnings.push(`Ch${ch.number}: Section count is ${ch.sections.length} (target 4-5 when enough source material is available)`);
        }
    }

    if (warnings.length > 0) console.warn("[architect] Heading/structure warnings:", warnings);

    // ── Rehydrate with segment details ───────────────────────────────────────
    const result = {
      bookTitle: minimal.bookTitle,
      subtitle: minimal.subtitle,
      authorName: minimal.authorName,
      estimatedTotalWords: chapters.flatMap((c) => c.sections).reduce((sum, s) => sum + s.targetWordCount, 0),
      frontMatterNotes: minimal.frontMatterNotes,
      backMatterNotes: minimal.backMatterNotes,
      chapters: chapters.map((ch) => {
        const chapterSegmentIds = [...new Set(ch.sections.flatMap((s) => s.sourceSegmentIds))];
        return {
          number: ch.number,
          title: ch.title,
          keyTheme: ch.keyTheme,
          sourceSegmentIds: chapterSegmentIds,
          sections: ch.sections.map((sec) => {
            const segs = sec.sourceSegmentIds.map((id) => segmentMap[id]).filter(Boolean);
            const quotes = segs.flatMap((s) => s?.quotes ?? [])
              .map((q) => quoteMap[q.id] ?? q)
              .filter((q, i, arr) => arr.findIndex((x) => x.id === q.id) === i);
            
            return {
              sectionNumber: sec.sectionNumber,
              heading: sec.heading,
              sourceSegmentIds: sec.sourceSegmentIds,
              targetWordCount: sec.targetWordCount,
              keyPoints: segs.flatMap((s) => s?.keyPoints ?? []),
              quotesInSection: quotes,
            };
          }),
        };
      }),
    };

    return NextResponse.json(result);
  } catch (err) {
    console.error("[architect] Error:", err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Architecture failed",
      fallback: simpleFallback(input),
    }, { status: 500 });
  }
}
