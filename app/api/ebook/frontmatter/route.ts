import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { deepSeekReasonerModel, deepSeekModel } from "@/lib/ai-providers";
import { FrontMatterRequestSchema, FrontBackMatterSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES, stripAudienceLanguage } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 300;

// LLM generates introduction + conclusion only — no preface
const IntroConclSchema = FrontBackMatterSchema.omit({ preface: true, scriptureIndex: true });

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = FrontMatterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const transcript = typeof input.masterTranscript === "string" ? input.masterTranscript : "";
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════\nAUTHOR BOOK CONFIGURATION (highest priority)\n════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}` : ""}`
    : "";

  // Scripture already quoted in full elsewhere in the book (chapter bodies, epigraphs) —
  // the introduction/conclusion must never reprint that verse text, only reference it.
  const quoteDedupBlock = (input.alreadyQuotedRefs.length + input.forbiddenVerseTexts.length) > 0
    ? `\n\n════════════════════════════════════════════\nSCRIPTURE DEDUP — ALREADY QUOTED IN FULL ELSEWHERE IN THIS BOOK\n════════════════════════════════════════════${input.alreadyQuotedRefs.length > 0 ? `\nThese references already appear in full in a chapter or a chapter epigraph — reference them by citation only (e.g. "as Psalm 27:1 declares"), never reprint the verse text: ${input.alreadyQuotedRefs.join(", ")}` : ""}${input.forbiddenVerseTexts.length > 0 ? `\nForbidden verse texts (exact wording already printed — hard ban on reprinting, even with a different translation label): ${input.forbiddenVerseTexts.slice(0, 8).map((t) => `"${t.slice(0, 80)}…"`).join(" | ")}` : ""}`
    : "";

  const frontmatterSystem = `You are an editorial assistant writing the introduction and conclusion of a published teaching book.

ABSOLUTE CONTENT RULE — ZERO FABRICATION:
Every sentence must come verbatim-idea from the provided transcript. You may not add content, context, or ideas not present in the audio/transcript — not even plausible extensions, inferred background, theological context the author "probably" knows, or biographical details you can reasonably assume. If you cannot point to the exact idea in the transcript text below, delete the sentence. Write shorter output rather than pad with invented content.

════════════════════════════════════════════
INTRODUCTION — INDUSTRY STANDARDS (CRITICAL — MOST COMMON FAILURE: table-of-contents style previews)
════════════════════════════════════════════
🚨 INTRODUCTION MANDATE: Write as the author speaking DIRECTLY to the reader about why they need THIS book RIGHT NOW. Never explain what chapters exist or what readers will learn. Never preview or list chapter content.

NO CHAPTER PREVIEWS. NO ROADMAP PROSE. NEVER.
The introduction does NOT list, foreshadow, or reference chapter titles, themes, or sequence. Readers already see the table of contents. Your job is not to restate it.

STRUCTURE (first person, author voice):
1. READER'S PROBLEM/NEED: Start with the specific tension, confusion, or hunger the reader brings to this book. Ground it in a real human situation, not abstract theology. Use a moment or truth from the author's own understanding.
2. THE INVITATION: Why now? Why this book? Articulate the permission the reader needs to receive—not a command, but a genuine welcome into a conversation.
3. WHAT'S AT STAKE: What changes for the reader if they engage deeply? Not a chapter preview, but a felt outcome. Make it visceral.
4. HOW TO READ THIS: Brief guidance on voice and approach. The author's own methodology or rhythm for how to encounter the material.
5. LANDING: A powerful forward motion into the text—not a summary, but a threshold the reader now crosses.

HARD CONSTRAINTS:
- NEVER state or foreshadow chapter titles, chapter themes, or the order of ideas in the book.
- NEVER repeat examples, stories, illustrations, or scriptural grounds already used in chapter bodies.
- NEVER create a "roadmap" or table-of-contents prose. Readers already know what chapters exist.
- DO draw from the author's opening moment in the transcript (the first 3–4 minutes) for voice calibration, but DO NOT copy the opening's content directly.
- DO use signature phrases and rhetorical patterns from Voice DNA naturally embedded (not quoted).

TARGET: 3–5 paragraphs, 500–800 words maximum.

════════════════════════════════════════════
CONCLUSION — INDUSTRY STANDARDS (CRITICAL — MOST COMMON FAILURE: chapter recap/summary mode)
════════════════════════════════════════════
🚨 CONCLUSION MANDATE: This is NOT a recap. Never remind the reader what each chapter taught. Never summarize the book's structure. Write as the author returning to complete a conversation, not closing a sermon.

NO RECAP MODE. NO CHAPTER SUMMARY. NEVER.
The conclusion does NOT list chapter themes, remind readers of chapter content, or summarize what each section covered. Readers already read the book. Your job is not to tell them what they just learned.

STRUCTURE (first person, author voice):
1. RETURN TO THE READER'S NEED: Echo the problem or hunger named in the introduction, but now contextualized by all the author has shared. Show how the journey through the book lands on that original question.
2. THE COHESIVE IDEA: Articulate the ONE big idea that holds all chapters together—not a list, not a summary, but the connective tissue. What unifies this whole teaching?
3. BEYOND THE BOOK: What is the reader's next move? Not "go read more" or "apply these principles abstractly," but a concrete forward orientation grounded in the author's own conviction about what happens after this book ends.
4. FINAL GESTURE: A closing statement that honors the reader's time and sends them forward with permission, not obligation. Avoid manufactured emotion—let the author's authentic conviction land.

HARD CONSTRAINTS:
- NEVER list or summarize chapter content.
- NEVER reintroduce illustrations, stories, or scripture examples from the chapter bodies.
- NEVER add applications or implications the author did not voice explicitly.
- DO synthesize the through-line that runs across all chapters (from Voice DNA and chapter architecture).
- DO use the author's own closing sentiment from the transcript (final minutes) for emotional resonance, but DO NOT copy the closing verbatim or import its specific examples.

TARGET: 2–4 paragraphs, 300–500 words maximum.

ABOUT AUTHOR:
- ONLY write if the author explicitly discussed their background, personal journey, credentials, or "how I came to this." Return null otherwise.
- Focus on what makes the author credible to write THIS book—not a résumé.

RESOURCES LIST:
- Only include books, tools, websites, platforms the author explicitly recommended by name or direct reference.
- Return [] if no resources were mentioned.
- Do NOT add resources that "fit" the author's message but were not named.

SCRIPTURE & QUOTE FORMATTING:
${SCRIPTURE_FORMATTING_RULES}

VOICE ENFORCEMENT — FIRST PERSON MANDATORY:
The introduction speaks in first person as the author. This means:
• Write WITH the author's voice, not ABOUT the author. Never slip into third-person description.
• Use the toneProfile to set every sentence's register and emotional weight.
• Embed signature phrases naturally — not quoted, not referenced, but used as the author would actually say them.
• The rhetoricalPatterns describe HOW this author moves through an argument. Replicate those moves in the introduction's structure. If the speaker characteristically "states a problem then provides the scriptural answer," do that in the introduction.
• Any sentence that sounds like a publicist describing the author (rather than the author speaking) is wrong. Rewrite it.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PROSE_MASTERY_RULES}

${PREMIUM_BOOK_STYLE_RULES}

════════════════════════════════════════════
COMPLIANCE CHECKPOINT — BEFORE FINALIZING OUTPUT
════════════════════════════════════════════
✅ INTRODUCTION: Before returning, scan for:
  - Does it preview chapter titles, themes, or sequence? DELETE those sentences.
  - Does it repeat examples, stories, or scripture already in chapter bodies? DELETE those sentences.
  - Does it sound like a table of contents or roadmap? REWRITE entirely.
  - Is every sentence grounded in the transcript? If not, DELETE.

✅ CONCLUSION: Before returning, scan for:
  - Does it recap or summarize chapter content? DELETE those sentences.
  - Does it remind readers what they learned? DELETE those sentences.
  - Does it reprint stories, scripture, or illustrations from chapters? DELETE those sentences.
  - Is every sentence grounded in the transcript? If not, DELETE.

If after removing these violations the introduction or conclusion is very short, that is CORRECT. Short and true beats long and padded.${authorConfigBlock}${quoteDedupBlock}`;

  const frontmatterPrompt = `Write the front and back matter for this ebook.

BOOK TITLE: ${input.architecture.bookTitle}
AUTHOR: ${input.architecture.authorName}

ARCHITECTURE CONTEXT:
- Chapters: ${input.architecture.chapters.map((c) => c.title).join(", ")}
- Front matter notes (opening): ${input.architecture.frontMatterNotes}
- Back matter notes (closing): ${input.architecture.backMatterNotes}

VOICE DNA:
${JSON.stringify(input.voiceDNA, null, 2)}

TRANSCRIPT OPENING (voice calibration — first-person voice anchoring only):
${transcript.slice(0, 4000)}

[… sermon middle omitted — use chapter themes below for content coverage across the full book …]

CHAPTER-BY-CHAPTER CONTENT (full book map — introduction and conclusion must cover all chapters):
${input.architecture.chapters.map((c, i) => `Chapter ${i + 1}: "${c.title}"\n  Core theme: ${c.keyTheme}\n  Sections: ${((c as {sections?: {heading: string}[]}).sections ?? []).map((s) => s.heading).join(" | ") || "(none)"}`).join("\n\n")}`;

  const buildResponse = (object: Awaited<ReturnType<typeof generateObject<typeof IntroConclSchema>>>["object"]) =>
    NextResponse.json({
      ...object,
      preface: "",
      introduction: stripAudienceLanguage(object.introduction ?? ""),
      conclusion: stripAudienceLanguage(object.conclusion ?? ""),
      aboutAuthor: object.aboutAuthor ? stripAudienceLanguage(object.aboutAuthor) : null,
      resourcesList: (object.resourcesList ?? []).map((r) => stripAudienceLanguage(r)),
      scriptureIndex: (() => {
        const seenRefs = new Set<string>();
        return (input.architecture?.chapters ?? [])
          .flatMap((c) => c.quotesInChapter ?? [])
          .filter((q) => q.type === "scripture" && q.reference?.trim())
          .sort((a, b) => a.reference.localeCompare(b.reference))
          .reduce<string[]>((acc, q) => {
            const entry = `${q.reference}${q.translation ? ` (${q.translation})` : ""}`;
            if (!seenRefs.has(entry)) { seenRefs.add(entry); acc.push(entry); }
            return acc;
          }, []);
      })(),
    }, { status: 200 });

  // Try V3 first for speed. If it fails, fall back to R1 for maximum quality.
  try {
    const { object } = await generateObject({
      model: deepSeekModel,
      schema: IntroConclSchema,
      mode: "json",
      temperature: 0.35,  // V3: balanced prose generation
      system: frontmatterSystem,
      prompt: frontmatterPrompt,
    });
    return buildResponse(object);
  } catch {
    // V3 failed — fall back to R1 for maximum certainty
    try {
      const { object } = await generateObject({
        model: deepSeekReasonerModel,
        schema: IntroConclSchema,
        mode: "json",
        temperature: 0.35,
        system: frontmatterSystem,
        prompt: frontmatterPrompt,
      });
      return buildResponse(object);
    } catch (v3Err) {
      // NEVER fall back to raw transcript — return a clear error instead
      const message = v3Err instanceof Error ? v3Err.message : "Frontmatter generation failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }
}
