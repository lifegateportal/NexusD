import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { z } from "zod";
import { PolishChapterRequestSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES, stripAudienceLanguage, extractChapterOpeningQuote } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 300;

// Slim output — section bodies are already written; LLM only adds framing + takeaways
const PolishOutputSchema = z.object({
  intro: z.string().default(""),
  forwardQuestion: z.string().default(""),
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  epigraph: z.string().default(""),
  // Upgrade 5: section boundary transitions
  sectionTransitions: z.array(z.object({
    sectionNumber: z.number(),
    revisedLastSentence: z.string(),
  })).default([]),
});

function fallbackPolishOutput(chapter: z.infer<typeof PolishChapterRequestSchema>["input"]): z.infer<typeof PolishOutputSchema> {
  const sections = chapter.sections ?? [];
  const firstBody = sections.map((section) => (section.body ?? "").trim()).find(Boolean) ?? "";
  const lastBody = [...sections].reverse().map((section) => (section.body ?? "").trim()).find(Boolean) ?? "";

  const takeaways = sections
    .flatMap((section) => [section.heading, ...(section.keyTakeaways ?? [])])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);

  const reflectionQuestions = takeaways.length > 0
    ? takeaways.slice(0, 3).map((item) => `How does ${item.replace(/[.?!]+$/g, "")} shape the chapter's message?`)
    : [
        `What is the main message of chapter ${chapter.number}?`,
        `How do the section themes build on each other in chapter ${chapter.number}?`,
        `What should the reader carry forward from this chapter?`,
      ];

  // Intro: derive from headings and key points — never copy the body prose.
  const headingsSummary = sections
    .map((s) => s.heading?.trim())
    .filter(Boolean)
    .join(", ");
  const fallbackIntro = headingsSummary
    ? `This chapter examines: ${headingsSummary}.`
    : chapter.title || "";

  return {
    intro: stripAudienceLanguage(fallbackIntro),
    forwardQuestion: "",

    keyTakeaways: takeaways.length > 0 ? takeaways.map((item) => stripAudienceLanguage(item)) : [stripAudienceLanguage(chapter.title || "")].filter(Boolean),
    reflectionQuestions: reflectionQuestions.map((item) => stripAudienceLanguage(item)).filter(Boolean),
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = PolishChapterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { input: chapter } = input;
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\nAUTHOR BOOK CONFIGURATION (highest priority):\n${authorConfig.targetAudience ? `TARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}` : ""}`
    : "";

  try {
    // Send section headings + key takeaways only — NOT body prose.
    // Sending body prose caused the LLM to mirror the section-1 opening verbatim as the intro.
    const sectionsSummary = (chapter.sections ?? [])
      .map((s) => {
        const kp = (s.keyTakeaways ?? []).slice(0, 3).join("; ");
        return `Section ${s.sectionNumber} — ${s.heading}${kp ? `: ${kp}` : ""}`;
      })
      .join("\n");

    const totalWordCount = (chapter.sections ?? []).reduce((acc, s) => acc + (s.wordCount ?? 0), 0);

    // Trim VoiceDNA to key fields only to keep the prompt small and response fast
    const voiceDNASlim = {
      signaturePhrases: (chapter.voiceDNA?.signaturePhrases ?? []).slice(0, 6),
      toneProfile: chapter.voiceDNA?.toneProfile ?? "",
      preferredTerminology: (chapter.voiceDNA?.preferredTerminology ?? []).slice(0, 6),
      avoidWords: (chapter.voiceDNA?.avoidWords ?? []).slice(0, 8),
    };

    const epigraphCandidates = (chapter.quotesInChapter ?? [])
      .filter((q) => q.type === "scripture")
      .slice(0, 5)
      .map((q) => `"${q.text.slice(0, 120)}" \u2014 ${q.reference} (${q.translation || chapter.primaryTranslation || "translation not stated \u2014 resolve to the book's primary translation"})`)
      .join("\n");

    const prevChapterBlock = chapter.previousChapterForwardQuestion
      ? `\n\nPREVIOUS CHAPTER FORWARD QUESTION (the open question that closed the last chapter — your intro should feel like the answer beginning to form):\n${chapter.previousChapterForwardQuestion.slice(0, 200)}`
      : "";

    // U5: Chapter premise from architect — constrains the intro and premise line
    const chapterPremiseBlock = chapter.chapterPremise
      ? `\n\nCHAPTER PREMISE (from blueprint — your intro and premise line must serve this north star):\n${chapter.chapterPremise}`
      : "";

    // U7: Series arc bridge — tells the intro what conceptual thread to pick up from the previous chapter
    const seriesArcBlock = chapter.seriesArcBridge
      ? `\n\nSERIES ARC BRIDGE: The previous chapter's closing thread was: "${chapter.seriesArcBridge}". The intro of this chapter should feel like a natural continuation of that thread — not a restatement, but a forward step.`
      : "";

    // ── Upgrade 5: Section boundary data for transition review ───────────
    // Extract last 2 sentences from each section and first 2 sentences of the next,
    // so the LLM can identify and improve weak handoffs between sections.
    const sections = chapter.sections ?? [];
    const sectionBoundariesBlock = sections.length > 1
      ? `\n\nSECTION BOUNDARY REVIEW:\n${sections.slice(0, -1).map((sec, idx) => {
          const nextSec = sections[idx + 1];
          const lastSents = (sec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(-2).join(" ");
          const firstSents = (nextSec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2).join(" ");
          return `• Boundary after §${sec.sectionNumber} → §${nextSec.sectionNumber}:\n  ENDS: "${lastSents.slice(0, 200)}"\n  OPENS: "${firstSents.slice(0, 200)}"`;
        }).join("\n")}`
      : "";

    // AMENDMENT: Extract chapter opening quote from first section instead of AI-generating intro
    // This ensures the intro is a direct, powerful statement from the author's own teaching,
    // not a fabricated opener. This matches industry standards for book intros.
    const extractedIntro = extractChapterOpeningQuote(chapter.sections ?? []);

    let object: z.infer<typeof PolishOutputSchema>;
    try {
      const { text } = await generateText({
        model: deepSeekModel,
        temperature: 0.25,
        system: `You are an editorial assistant finalizing a chapter of a published teaching book.

ABSOLUTE CONTENT RULE: Every sentence must come from the provided transcript content.
Do NOT add new ideas, examples, or explanations not present in the transcript.

EM DASH ABSOLUTE BAN: Never use an em dash (—) in any output. No spaced em dashes ( — ), no unspaced em dashes (—), no double hyphens (--) used as em dashes. Use a comma, colon, or split into two sentences instead.

HUMANIZATION: Use contractions naturally. Avoid "not just...but", "not merely...but", "indeed,", "certainly,", "ultimately,", "at its core", "in essence", "profoundly", "transformative". Break any run of three parallel-structured sentences.

Your tasks:
1. EPIGRAPH: From the provided scripture candidates, pick the ONE most resonant opening quote for this chapter. Return it formatted as: "Quote text." — Reference (Translation). The translation abbreviation is REQUIRED and must never be omitted — every candidate below already gives you one to use. If no candidate strongly fits or none are provided, return an empty string. Never invent a quote.
2. INTRO: THIS FIELD IS NOW EXTRACTED (not generated). Skip generating intro — return empty string. The intro is automatically extracted from the chapter body as a significant opening quote.
3. FORWARD QUESTION: ONE sentence — a preemptive question that plants anticipation for where the book goes next.
   This is the last thing the reader sees before turning the page. It should feel like an open door, not a closed summary.
   It must point forward, not backward. Never restate what the chapter covered.
   WRONG: "We've seen how faith requires action." RIGHT: "But what happens when you've done everything right and nothing moves?"
   If this is the final chapter, write a question that sends the reader back into life with something unresolved and worth carrying.
4. KEY TAKEAWAYS: 3–6 bullet statements taken VERBATIM or near-verbatim from the chapter content.
5. REFLECTION QUESTIONS: 3–4 questions that are SPECIFIC, PERSONAL, and ACTIONABLE.
   REQUIRED: Each question must reference a concrete claim, story, or scripture from this chapter.
   FORBIDDEN generic forms: "How does X shape the message?", "What is the main message?", "What should the reader carry forward?", "How can you apply this?".
   REQUIRED: Name the specific idea, then ask about its implication in the reader's real life. Example: "Peter says diligence is required, not passive waiting — where in your life are you waiting for God to act when He has already told you to move?"
6. SECTION TRANSITIONS: Review the SECTION BOUNDARY data provided. For each boundary, evaluate whether the current ending sentence of section N creates genuine forward momentum into section N+1. If the handoff feels abrupt, mechanical, or summarizing, write a replacement last sentence for that section. Rules:
   • The revised sentence must be drawn from section N's OWN content — never preview section N+1's ideas.
   • It must create forward tension via an unresolved question, an open implication, or a logical pull — not a summary.
   • If the existing ending is already strong (creates pull, avoids summarizing), return an empty string for that section — do NOT change it.
   • Return as sectionTransitions array: [{"sectionNumber": N, "revisedLastSentence": "...or empty string"}].

VOICE: Use the author's signature phrases and preferred terminology consistently. Never swap a synonym for variety when the author has a preferred term. Do not use words in the avoidWords list.

READER NORMALIZATION:
- Remove live-audience language and stage commands.
- Rewrite spoken-room references into reader-facing prose.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${PREMIUM_BOOK_STYLE_RULES}${authorConfigBlock}

Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation:
{"intro":"...","forwardQuestion":"...","keyTakeaways":["..."],"reflectionQuestions":["..."],"epigraph":"...","sectionTransitions":[{"sectionNumber":1,"revisedLastSentence":"..."}]}`,
        prompt: `Finalize this chapter.\n\nCHAPTER ${chapter.number}: ${chapter.title}\n\nVOICE DNA:\n${JSON.stringify(voiceDNASlim)}\n\nSECTION SUMMARIES:\n${sectionsSummary}${epigraphCandidates ? `\n\nSCRIPTURE CANDIDATES FOR EPIGRAPH (pick the most resonant ONE, or return empty string if none fits):\n${epigraphCandidates}` : ""}${prevChapterBlock}${chapterPremiseBlock}${seriesArcBlock}${sectionBoundariesBlock}`,
      });
      const _jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = PolishOutputSchema.parse(_jsonMatch ? JSON.parse(_jsonMatch[0]) : {});
      // AMENDMENT: Override with extracted intro (actual quote from chapter)
      object = { ...parsed, intro: extractedIntro };
    } catch {
      try {
        const fallback = fallbackPolishOutput(chapter);
        object = { ...fallback, intro: extractedIntro };
      } catch {
        object = { intro: extractedIntro, forwardQuestion: "", keyTakeaways: [], reflectionQuestions: [] };
      }
    }

    // Merge: preserve section bodies that were already written
    // ── Upgrade 14: Epigraph source credibility flag ─────────────────────
    // Flag any epigraph attribution that doesn't match a recognized Bible book pattern.
    // This catches hallucinated scripture references or misattributed quotes.
    const BIBLE_BOOK_PATTERN = /\b(genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs?|ecclesiastes|song of solomon|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation|gen|ex|lev|num|deut|josh|judg|prov|ps|psa|eccl|isa|jer|lam|ezek|dan|hos|mal|matt|mk|lk|jn|rom|cor|gal|eph|phil|col|thess|tim|tit|heb|jas|rev)\b/i;
    const VERSE_REFERENCE_PATTERN = /\d+:\d+/;
    let epigraphCredibilityWarning: string | null = null;
    if (object.epigraph && object.epigraph.trim().length > 0) {
      const epigraphText = object.epigraph;
      // Attempt to extract the attribution (after the last — or - or in parens at end)
      const attrMatch = epigraphText.match(/[—\-–]\s*(.+?)(\s*\(.*?\))?$/);
      const attribution = attrMatch?.[1]?.trim() ?? "";
      if (attribution && !BIBLE_BOOK_PATTERN.test(attribution) && !VERSE_REFERENCE_PATTERN.test(attribution)) {
        epigraphCredibilityWarning = `Epigraph attribution "${attribution}" does not match a recognized scripture reference. Verify this source before publishing.`;
        console.warn(`[polish] ${epigraphCredibilityWarning}`);
      }
    }

    // ── Upgrade 5: Apply section transition revisions to section bodies ──
    const patchedSections = (chapter.sections ?? []).map((sec) => {
      const transition = (object.sectionTransitions ?? []).find(
        (t) => t.sectionNumber === sec.sectionNumber && t.revisedLastSentence?.trim()
      );
      if (!transition) return sec;
      // Replace the last sentence of the section body with the revised one
      const sentences = (sec.body ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
      if (sentences.length === 0) return sec;
      sentences[sentences.length - 1] = transition.revisedLastSentence.trim();
      return { ...sec, body: sentences.join(" ") };
    });
    const merged = {
      ...object,
      intro: stripAudienceLanguage(object.intro ?? ""),
      forwardQuestion: stripAudienceLanguage(object.forwardQuestion ?? ""),
      keyTakeaways: (object.keyTakeaways ?? []).map((t) => stripAudienceLanguage(t)),
      reflectionQuestions: (object.reflectionQuestions ?? []).map((q) => stripAudienceLanguage(q)),
      epigraph: object.epigraph ?? "",
      number: chapter.number,
      title: chapter.title,
      sections: patchedSections,
      totalWordCount,
      status: "complete" as const,
      ...(epigraphCredibilityWarning ? { epigraphCredibilityWarning } : {}),
    };

    return NextResponse.json(merged, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chapter polish failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
