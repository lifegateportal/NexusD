import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { WriteChapterRequestSchema, WriteChapterOutputSchema } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, PREMIUM_BOOK_STYLE_RULES, stripAudienceLanguage, cleanTranscriptForBook } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = WriteChapterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const {
    chapterNumber, chapterTitle, chapterPremise, nextChapterTitle, coreThesis,
    primaryTranslation, voiceDNA, authorConfig, sections,
    alreadyCoveredPoints, priorSectionsSample, bannedRecaps,
    alreadyQuotedRefs, forbiddenVerseTexts, overusedPhrases,
  } = input;

  // ── Voice DNA block ────────────────────────────────────────────────────────
  const voiceDnaBlock = voiceDNA
    ? `\n\n════════════════════════════════════════════
VOICE DNA — MUST BE ENFORCED
════════════════════════════════════════════
Tone: ${voiceDNA.toneProfile}
Sentence pattern: ${voiceDNA.sentencePattern}
Signature phrases (use verbatim where natural): ${(voiceDNA.signaturePhrases ?? []).slice(0, 5).join(" | ")}
Preferred terminology: ${(voiceDNA.preferredTerminology ?? []).slice(0, 8).join(", ")}
Avoid words: ${(voiceDNA.avoidWords ?? []).slice(0, 20).join(", ")}${voiceDNA.openingPattern ? `\nOpening pattern: ${voiceDNA.openingPattern}` : ""}${voiceDNA.closingPattern ? `\nClosing pattern: ${voiceDNA.closingPattern}` : ""}`
    : "";

  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════
AUTHOR CONFIGURATION (highest priority)
════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nAUTHOR INSTRUCTIONS: ${authorConfig.instructions}` : ""}`
    : "";

  // ── Cross-chapter dedup context ────────────────────────────────────────────
  // FIX 1: Use prose samples (not metadata) for n-gram overlap detection
  const priorContextBlock = priorSectionsSample.length > 0
    ? `\n\n════════════════════════════════════════════
PRIOR CHAPTERS — PROSE SAMPLE (avoid repeating these stories/examples)
════════════════════════════════════════════
These are actual sentences from prior chapters. Do NOT repeat these stories, examples, or scripture explanations. One-sentence reference maximum:
${priorSectionsSample.slice(0, 20).map((p) => `• ${p.slice(0, 200)}`).join("\n")}`
    : "";

  const bannedRecapsBlock = bannedRecaps.length > 0
    ? `\n\n════════════════════════════════════════════
BANNED RECAP SENTENCES
════════════════════════════════════════════
These thesis sentences from prior sections must NOT be paraphrased or echoed:
${bannedRecaps.slice(0, 10).map((r) => `• "${r}"`).join("\n")}`
    : "";

  const quoteDedupBlock = (alreadyQuotedRefs.length + forbiddenVerseTexts.length) > 0
    ? `\n\n════════════════════════════════════════════
SCRIPTURE DEDUP
════════════════════════════════════════════${alreadyQuotedRefs.length > 0 ? `\nAlready quoted in full — reference only, do NOT reprint: ${alreadyQuotedRefs.join(", ")}` : ""}${forbiddenVerseTexts.length > 0 ? `\nForbidden verse texts (exact text already printed — hard ban): ${forbiddenVerseTexts.slice(0, 5).map((t) => `"${t.slice(0, 60)}…"`).join(" | ")}` : ""}`
    : "";

  // G4: Lexical fingerprint — top overused phrases across the written corpus
  const lexicalBlock = overusedPhrases.length > 0
    ? `\n\n════════════════════════════════════════════
LEXICAL FINGERPRINT — FIND FRESHER LANGUAGE
════════════════════════════════════════════
These 3-gram constructions are already overused across prior chapters. Avoid them — find different phrasing for the same ideas:\n${overusedPhrases.slice(0, 15).map((p) => `• "${p}"`).join("\n")}`
    : "";

  const translationBlock = primaryTranslation
    ? `\n\nPRIMARY TRANSLATION: Default to ${primaryTranslation} for any verse where the speaker did not specify a translation.`
    : "";

  // ── Build section payload ──────────────────────────────────────────────────
  const sectionPayload = sections.map((sec, idx) => {
    const excerpts = (sec.transcriptExcerpts ?? [])
      .map((e) => cleanTranscriptForBook(e).trim())
      .filter(Boolean)
      .map((e, i) => `[${i + 1}] ${e.slice(0, 1600)}`)
      .join("\n\n");
    const planBlock = (sec.assignedPlan ?? []).length > 0
      ? `\nPARAGRAPH PLAN (follow this sequence):\n${sec.assignedPlan!.map((p, i) =>
          `  Step ${i + 1}: ${p.purpose}${(p.supportedExcerptNumbers ?? []).length > 0 ? ` [excerpts: ${p.supportedExcerptNumbers.join(", ")}]` : ""}`
        ).join("\n")}`
      : "";
    const keyPointsText = (sec.keyPoints ?? []).length > 0
      ? `\nKEY POINTS:\n${sec.keyPoints.map((k) => `• ${k}`).join("\n")}`
      : "";
    // G5: Include assigned quotes so the LLM knows which scriptures belong in this section
    const quotesText = (sec.quotes ?? []).length > 0
      ? `\nASSIGNED QUOTES FOR THIS SECTION:\n${sec.quotes.map((q) =>
          `  • ${q.reference}${q.translation ? ` (${q.translation})` : ""}: "${q.text.slice(0, 200)}${q.text.length > 200 ? "…" : ""}"`
        ).join("\n")}`
      : "";
    const lastFlag = sec.isLastSectionInChapter ? " [LAST SECTION — hard chapter boundary: do NOT develop the next chapter's themes]" : "";
    return `══ SECTION ${idx + 1} of ${sections.length}: §${sec.sectionNumber} — "${sec.heading}" (~${sec.targetWordCount ?? 500} words)${lastFlag} ══${keyPointsText}${quotesText}${planBlock}\n\nTRANSCRIPT EXCERPTS:\n${excerpts}`;
  }).join("\n\n────────────────────────────────────────────\n\n");

  // ── System prompt ──────────────────────────────────────────────────────────
  const system = `You are a professional ghostwriter writing all sections of a book chapter in one pass.

CORE RULES:
• Every sentence must trace to the provided transcript — zero fabrication
• Active voice, strong verbs, natural contractions
• NO em dashes (—); use comma, colon, or semicolon instead
• Vary sentence length: short punch after long explanation
• One idea per paragraph, 3–5 sentences
• Each section is sealed: never preview next section or re-explain what you just wrote in a prior section of this chapter
• Remove audience language: "say amen," "turn to your neighbor," "good morning," live-event cues

${SCRIPTURE_FORMATTING_RULES}

${SOURCE_LOCK_RULES}

${voiceDnaBlock}${authorConfigBlock}${priorContextBlock}${bannedRecapsBlock}${quoteDedupBlock}${lexicalBlock}${translationBlock}
${READER_NORMALIZATION_RULES}
${PROSE_MASTERY_RULES}
${PREMIUM_BOOK_STYLE_RULES}`;

  const coreThesisLine = coreThesis ? `\nCORE BOOK THESIS (thread through every section): ${coreThesis}` : "";
  const premiseLine = chapterPremise ? `\nCHAPTER PREMISE: ${chapterPremise}` : "";
  const nextChapterLine = nextChapterTitle
    ? `\nNEXT CHAPTER: "${nextChapterTitle}" — the final section's closing must NOT begin developing its themes`
    : "";

  const prompt = `Write all ${sections.length} sections of Chapter ${chapterNumber}: "${chapterTitle}"${coreThesisLine}${premiseLine}${nextChapterLine}

Return a JSON object with a "sections" array. Each element:
  sectionNumber: integer matching the §N above
  paragraphs: string[] — each string is one prose paragraph
  claimLedger: { claim: string }[] — one entry per key teaching claim made in this section

────────────────────────────────────────────

${sectionPayload}`;

  // G6: SSE stream with heartbeat — prevents proxy read-timeout on long chapters
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);
      try {
        const { object } = await generateObject({
          model: deepSeekModel,
          schema: WriteChapterOutputSchema,
          mode: "json",
          maxTokens: 16_000, // G2: explicit ceiling for full-chapter output
          temperature: 0.55, // Balanced temp for cross-section coherence
          system,
          prompt,
        });

        // Clean each section's paragraphs — two passes:
        // 1. stripAudienceLanguage (deterministic regex)
        // 2. Drop heading-prefixed lines and empty results
        const cleaned = {
          sections: (object.sections ?? []).map((sec) => ({
            ...sec,
            paragraphs: (sec.paragraphs ?? [])
              .map((p) => stripAudienceLanguage(p.trim()))
              .filter(Boolean)
              .filter((p) => !(/^#{1,6}\s/.test(p))),
          })),
        };

        clearInterval(ping);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleaned)}\n\n`));
      } catch (err) {
        clearInterval(ping);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : "Chapter write failed" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
