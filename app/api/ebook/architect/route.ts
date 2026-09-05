import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
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
              model: deepSeekModel,
              schema: MinimalChapterSchema,
              mode: "json",
              temperature: 0.3,
              maxTokens: 8000,
              system: `You are a structural editor. Transform a sermon into a book chapter.

RULES:
• Every title and heading comes from the transcript — no fabrication
• Chapter title: 4-7 words, punchy, complete phrase
• Section headings: 4-8 words, complete phrases, must make sense standalone
• Never start headings with: Introduction, Intro, Overview, Opening, Summary, Conclusion
• Never end headings with: to, in, for, on, the, our, and, but, or, let (complete the thought!)
• 5+ sections minimum (never fewer than 5)
• Each section: one focused teaching point
• Every segment ID appears in exactly one section
• targetWordCount = sum of assigned segments' word counts

${SOURCE_LOCK_RULES}`,
              prompt: `SEGMENT IDs: ${segs.map((s) => s.id).join(", ")}
THEME: ${chapterHint}
CORE THESIS: ${input.contentMap.coreThesis}
VOICE TONE: ${input.voiceDNA.toneProfile}

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
        
        if (!plan || plan.sections.length === 0) {
          // Fallback: one segment = one section
          return {
            number: idx + 1,
            title: themeHint,
            keyTheme: themeHint,
            sections: segs.map((seg, si) => ({
              sectionNumber: si + 1,
              heading: seg.topic,
              sourceSegmentIds: [seg.id],
              targetWordCount: seg.estimatedWordCount || 500,
            })),
          };
        }

        return {
          number: idx + 1,
          title: (plan.title || themeHint).trim(),
          keyTheme: (plan.keyTheme || plan.title || themeHint).trim(),
          sections: plan.sections.map((sec, si) => ({
            sectionNumber: si + 1,
            heading: sec.heading,
            sourceSegmentIds: (sec.sourceSegmentIds ?? []).filter((id) => validSegmentIds.has(id)),
            targetWordCount: sec.targetWordCount || 0,
          })),
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
    }

    if (warnings.length > 0) console.warn("[architect] Heading warnings:", warnings);

    // ── Rehydrate with segment details ───────────────────────────────────────
    const result = {
      bookTitle: minimal.bookTitle,
      subtitle: minimal.subtitle,
      authorName: minimal.authorName,
      estimatedTotalWords: chapters.flatMap((c) => c.sections).reduce((sum, s) => sum + s.targetWordCount, 0),
      frontMatterNotes: minimal.frontMatterNotes,
      backMatterNotes: minimal.backMatterNotes,
      chapters: chapters.map((ch) => ({
        number: ch.number,
        title: ch.title,
        keyTheme: ch.keyTheme,
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
      })),
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
