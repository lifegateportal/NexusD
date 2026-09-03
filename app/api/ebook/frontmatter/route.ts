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
INTRODUCTION
════════════════════════════════════════════
- Speak in first person as the author introducing the book directly to the reader.
- Focus on the book's purpose, core themes, and invitation to the reader.
- Do not describe the author from a third-person perspective.
- 3–5 paragraphs. Apply all preface guardrails above.

════════════════════════════════════════════
BACK MATTER
════════════════════════════════════════════
- conclusion: Drawn from the closing moments of the teaching, rewritten as a book closing — not an altar call or dismissal. 2–4 paragraphs.
- aboutAuthor: ONLY write if the author spoke about themselves, their background, or their story. Return null if not.
- resourcesList: Books, tools, websites, or resources the author explicitly recommended. Return [] if none mentioned.

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

${PREMIUM_BOOK_STYLE_RULES}${authorConfigBlock}${quoteDedupBlock}`;

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
      temperature: 0.4,  // V3: fast prose generation
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
        temperature: 1,
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
