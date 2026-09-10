import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel } from "@/lib/ai-providers";
import { ChapterPlanRequestSchema, ChapterPlanResponseSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, READER_NORMALIZATION_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── N-gram helpers (mirrors write-section) ───────────────────────────────────

const BIBLE_REF_RE = /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|psalms|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d+:\d+/i;

function extractNgrams(text: string, n = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function ngramOverlap(a: string, b: string, n = 4): number {
  const ga = extractNgrams(a, n);
  const gb = extractNgrams(b, n);
  if (ga.size === 0) return 0;
  let shared = 0;
  for (const g of ga) { if (gb.has(g)) shared++; }
  return shared / ga.size;
}

// ── Post-plan cleanup (mirrors write-section) ────────────────────────────────

type PlanEntry = {
  purpose: string;
  supportedExcerptNumbers: number[];
  minExcerptNumber?: number;
};

function sortAndPruneEntries(entries: PlanEntry[]): PlanEntry[] {
  // Only keep entries anchored to at least one transcript excerpt.
  // Previously unanchored entries were kept at the end as "planned content the LLM
  // identified as necessary." In practice they had no transcript source, so the writer
  // filled them with fabricated or already-covered content — the main driver of
  // cross-section repetition. If a concept can't be grounded in an excerpt, it
  // doesn't belong in this section's plan.
  const anchored = entries.filter((e) => (e.supportedExcerptNumbers ?? []).length > 0);
  anchored.sort((a, b) => {
    const minA = Math.min(...(a.supportedExcerptNumbers.length ? a.supportedExcerptNumbers : [Infinity]));
    const minB = Math.min(...(b.supportedExcerptNumbers.length ? b.supportedExcerptNumbers : [Infinity]));
    return minA - minB;
  });
  return anchored;
}

// ── Chapter-level response schema ─────────────────────────────────────────────

const ChapterPlanLLMSchema = z.object({
  sectionPlans: z.array(z.object({
    sectionNumber: z.number().int(),
    paragraphPlan: z.array(z.object({
      purpose: z.string().default(""),
      supportedExcerptNumbers: z.array(z.number().int().positive()).default([]),
      minExcerptNumber: z.number().int().positive().optional(),
    })).default([]),
  })).default([]),
});

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input: z.infer<typeof ChapterPlanRequestSchema>;
  try {
    input = ChapterPlanRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 }
    );
  }

  const { chapterNumber, chapterTitle, sections, nextChapterTitle, coreThesis, voiceDNA, alreadyCoveredPoints, priorSectionsSample } = input;

  // ── Build concept ownership manifest ────────────────────────────────────────
  // List every section's heading and key points together so the planner knows
  // the full chapter concept space before planning any individual section.
  const conceptManifest = sections.map((s) =>
    `SECTION ${s.sectionNumber}: "${s.heading}"\n  Key points: ${(s.keyPoints ?? []).join(" | ") || "(none listed)"}`
  ).join("\n\n");

  // ── Build per-section excerpt blocks with section-scoped numbering ──────────
  const sectionExcerptBlocks = sections.map((s) => {
    const excerpts = s.transcriptExcerpts ?? [];
    const block = excerpts
      .map((t, i) => `[Excerpt ${i + 1}]\n${t}`)
      .join("\n\n---\n\n");
    return { sectionNumber: s.sectionNumber, block, excerptCount: excerpts.length };
  });

  // ── Dedup signal blocks ──────────────────────────────────────────────────────
  const priorChapterBlock = alreadyCoveredPoints.length > 0
    ? `\n\n════════════════════════════════════════════\nPRIOR CHAPTERS — HARD SKIP (already written)\n════════════════════════════════════════════\nThese concepts, arguments, and points have already been written in earlier chapters. Do NOT plan ANY paragraph in ANY section of this chapter that re-introduces, re-defines, or re-explains them:\n${alreadyCoveredPoints.map((p) => `• ${p}`).join("\n")}`
    : "";

  const coreThesisBlock = coreThesis
    ? `\n\nBOOK'S CORE THESIS (thread through every section's plan): "${coreThesis}"`
    : "";

  // ── Amendment 9: VoiceDNA shapes paragraph purpose framing ────────────────
  // Previously only toneProfile was injected. rhetoricalPatterns — the structural
  // fingerprint of HOW the preacher argues — were ignored. Purpose statements
  // framed with "Explain that..." are generic editorial language. Framing them
  // with the speaker's own argumentative moves ("Expose the wrong assumption
  // then correct it from scripture") produces writing plans that generate
  // section prose that sounds like THIS preacher, not a generic writer.
  const voiceDnaLine = (() => {
    if (!voiceDNA) return "";
    const parts: string[] = [];
    if (voiceDNA.toneProfile) {
      parts.push(`\n\nTONE (enforce in purpose statements): ${voiceDNA.toneProfile}`);
    }
    const patterns = voiceDNA.rhetoricalPatterns ?? [];
    if (patterns.length > 0) {
      parts.push(`\n\nSPEAKER RHETORICAL PATTERNS \u2014 FRAME PARAGRAPH PURPOSES USING THESE MOVES:
This speaker characteristically argues through these patterns:
${patterns.slice(0, 4).map((p) => `  \u2022 ${p}`).join("\n")}
When writing purpose statements, use these patterns as the frame \u2014 not generic editorial language.
WRONG: "Explain that believers have authority over demonic power."
RIGHT: "Expose the assumption that spiritual authority must be earned, then declare from Luke 10:19 that Jesus already gave it freely."
The purpose statement should describe the speaker's rhetorical move, not just the content topic.`);
    }
    return parts.join("");
  })();

  const chapterBoundaryBlock = nextChapterTitle
    ? `\n\nCHAPTER BOUNDARY — HARD STOP: The final section of this chapter must not plan any paragraph that introduces or develops content from the next chapter titled "${nextChapterTitle}". If any transcript excerpt transitions into that next chapter's topic, stop planning before it.`
    : "";

  const system = `You are a structural editor planning the complete paragraph-by-paragraph architecture for an entire book chapter.

Your job is to produce a non-overlapping content plan: every concept, story, illustration, and scripture in this chapter is assigned to EXACTLY ONE section. No concept may appear in two sections' plans.

════════════════════════════════════════════
CONCEPT OWNERSHIP RULE — NON-NEGOTIABLE
════════════════════════════════════════════
Before planning paragraphs, mentally assign each concept in the transcript to the section whose heading best owns it. Then plan each section using ONLY the concepts you assigned to it. If a concept fits two sections, assign it to the one with the more specific heading match and exclude it from the other.

This is the anti-duplication contract: the writer for Section 3 will receive only Section 3's plan and will not see what Sections 1 and 2 planned. If the plans overlap, the book will duplicate content. There is no retry mechanism — plan correctly the first time.

════════════════════════════════════════════
EXCERPT OWNERSHIP RULE (FIX 4 — REPLACES MONOTONIC)
════════════════════════════════════════════
Each transcript excerpt may be assigned to EXACTLY ONE section in this chapter. Once you assign an excerpt to a section, it is LOCKED — no other section may use it.

You MAY assign excerpts non-monotonically:
  ✓ Section 1 can use excerpts 1, 3, 5
  ✓ Section 2 can use excerpts 2, 4, 6
  ✓ Section 3 can use excerpts 7, 8, 9

This allows proper handling of teaching structures where the speaker introduces multiple points, then circles back to develop each one.

Each paragraph plan entry MUST list supportedExcerptNumbers that belong to THIS section only. No excerpt number may appear in two different sections' plans.${priorChapterBlock}${coreThesisBlock}${voiceDnaLine}${chapterBoundaryBlock}

${SOURCE_LOCK_RULES}
${READER_NORMALIZATION_RULES}`;

  const excerptPayload = sectionExcerptBlocks
    .map(({ sectionNumber, block, excerptCount }) =>
      `${"=".repeat(60)}\nSECTION ${sectionNumber} TRANSCRIPT EXCERPTS (${excerptCount} total)\n${"=".repeat(60)}\n${block}`
    )
    .join("\n\n");

  const prompt = `Plan all sections of Chapter ${chapterNumber}: "${chapterTitle}".

CHAPTER CONCEPT MAP — assign each concept to ONE section only:
${conceptManifest}

SECTIONS TO PLAN:
${sections.map((s) => `• Section ${s.sectionNumber}: "${s.heading}"${s.nextSectionHeading ? ` → next: "${s.nextSectionHeading}"` : ""}${s.isLastSectionInChapter ? " (LAST section — chapter close)" : ""}`).join("\n")}

Return a sectionPlans array with one entry per section. Each paragraphPlan entry must have:
- purpose: what this paragraph will establish (one sentence, specific enough to detect overlap)
- supportedExcerptNumbers: the 1-based excerpt number(s) within THIS section's excerpt list
- minExcerptNumber: the lowest excerpt number this paragraph draws from

${excerptPayload}`;

  // ── Stream heartbeat bytes to keep the reverse-proxy read-timeout alive ──────
  // deepseek-reasoner can take 60-120s. Without periodic bytes, nginx/Cloudflare
  // close the connection with a 504/524 before the response arrives.
  // We send a space every 15s; JSON.parse (used by res.json()) ignores leading whitespace.
  const encoder = new TextEncoder();
  const generatePromise = generateObject({
    model: deepSeekReasonerModel,
    schema: ChapterPlanLLMSchema,
    mode: "json",
    temperature: 1, // reasoner requires temperature=1
    system,
    prompt,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(" ")); } catch { /* already closed */ }
      }, 15_000);

      try {
        const { object } = await generatePromise;
        clearInterval(heartbeat);

        // ── Post-process: excerpt-usage + cross-section concept deduplication ──
        const priorProseText = priorSectionsSample.join(" ");
        const usedExcerpts = new Set<string>(); // Track which excerpt IDs are already assigned
        // Cross-section concept tracker: accumulates purpose statements from sections
        // already planned IN THIS CALL so later sections can't re-plan the same concept.
        // Previously only priorProseText (already-written prose) was checked — sections
        // planned together in the same chapter-plan call had no awareness of each other.
        let plannedPurposesText = priorProseText;
        
        const cleanedPlans = (object.sectionPlans ?? []).map((sp) => {
          const sectionInput = sections.find((s) => s.sectionNumber === sp.sectionNumber);
          const maxExcerpt = Math.max(1, sectionInput?.transcriptExcerpts?.length ?? 0);
          let entries = sortAndPruneEntries(sp.paragraphPlan ?? []);

          // Keep only valid excerpt anchors for this section.
          // This prevents cross-section bleed caused by out-of-range excerpt numbers.
          entries = entries
            .map((entry) => {
              const supportedExcerptNumbers = Array.from(new Set(
                (entry.supportedExcerptNumbers ?? [])
                  .filter((n) => Number.isInteger(n) && n >= 1 && n <= maxExcerpt)
              ));
              return {
                ...entry,
                supportedExcerptNumbers,
                minExcerptNumber: supportedExcerptNumbers.length > 0
                  ? Math.min(...supportedExcerptNumbers)
                  : undefined,
              };
            })
            .filter((entry) => entry.supportedExcerptNumbers.length > 0);

          // FIX 4 (revised): Excerpt ownership enforcement — strip already-claimed
          // excerpts, then DROP entries whose excerpts were fully claimed.
          // Prior version kept "ghost entries" (supportedExcerptNumbers: []) after the
          // strip, which told the writer to fill those paragraphs without transcript
          // grounding — the #1 source of cross-section repetition and fabrication.
          entries = entries
            .map((entry) => {
              const excerptKey = `S${sp.sectionNumber}`;
              const availableExcerpts = entry.supportedExcerptNumbers.filter((n) => {
                const key = `${excerptKey}-E${n}`;
                return !usedExcerpts.has(key);
              });
              return {
                ...entry,
                supportedExcerptNumbers: availableExcerpts,
                minExcerptNumber: availableExcerpts.length > 0 ? Math.min(...availableExcerpts) : undefined,
              };
            })
            // Drop ghost entries: if all excerpts were claimed by another section, this
            // plan step has no transcript backing and must not reach the writer.
            .filter((entry) => entry.supportedExcerptNumbers.length > 0);

          // Mark all excerpts in this section's plan as consumed
          for (const entry of entries) {
            for (const n of entry.supportedExcerptNumbers) {
              usedExcerpts.add(`S${sp.sectionNumber}-E${n}`);
            }
          }

          // Filter entries whose purpose duplicates either already-written prose OR
          // concepts already planned by an earlier section in THIS chapter-plan call.
          entries = entries.filter((entry) => {
            if (!entry.purpose || entry.purpose.length < 20) return true;
            if (BIBLE_REF_RE.test(entry.purpose)) return true;
            // Threshold raised 0.45 → 0.60: plannedPurposesText now contains full paragraph
            // prose, not just purpose statements. Common theological vocabulary (grace, faith,
            // authority) creates false 4-gram overlap at 0.45, silently dropping valid plan
            // entries. 0.60 requires genuine semantic repetition to trigger suppression.
            return ngramOverlap(entry.purpose, plannedPurposesText) < 0.60;
          });

          // Accumulate this section's planned purposes so the NEXT section in this
          // call can detect and suppress duplicate concept planning.
          const sectionPurposeText = entries.map((e) => e.purpose ?? "").filter(Boolean).join(" ");
          if (sectionPurposeText.length > 0) {
            plannedPurposesText = plannedPurposesText
              ? `${plannedPurposesText} ${sectionPurposeText}`
              : sectionPurposeText;
          }

          entries.sort((a, b) => (a.minExcerptNumber ?? 0) - (b.minExcerptNumber ?? 0));
          return { sectionNumber: sp.sectionNumber, paragraphPlan: entries };
        });

        const plannedNums = new Set(cleanedPlans.map((p) => p.sectionNumber));
        for (const s of sections) {
          if (!plannedNums.has(s.sectionNumber)) {
            cleanedPlans.push({ sectionNumber: s.sectionNumber, paragraphPlan: [] });
          }
        }

        const response: z.infer<typeof ChapterPlanResponseSchema> = { sectionPlans: cleanedPlans };
        controller.enqueue(encoder.encode(JSON.stringify(response)));
      } catch (err) {
        clearInterval(heartbeat);
        console.error("[chapter-plan] Error:", err);
        const fallback: z.infer<typeof ChapterPlanResponseSchema> = {
          sectionPlans: sections.map((s) => ({ sectionNumber: s.sectionNumber, paragraphPlan: [] })),
        };
        controller.enqueue(encoder.encode(JSON.stringify(fallback)));
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "X-Accel-Buffering": "no", // disable nginx proxy buffering — chunks forward immediately
      "Cache-Control": "no-cache, no-store",
      "Transfer-Encoding": "chunked",
    },
  });
}
