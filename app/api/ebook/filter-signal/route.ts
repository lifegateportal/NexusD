import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { cleanTranscriptForBook, SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "@/lib/env";

const deepSeek = createOpenAI({
  apiKey: env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1"
});
const deepSeekChat = deepSeek("deepseek-chat");

export const runtime = "nodejs";
export const maxDuration = 120;

const RequestSchema = z.object({
  masterTranscript: z.string().min(50),
});

// Tiny schema — only extract start/end markers, NEVER the full transcript.
// Server reconstructs the cleaned transcript via string matching.
const MarkersSchema = z.object({
  teachingStartPhrase: z.string().default("").describe("First 80-120 chars of the sentence where core teaching begins (verbatim)"),
  teachingEndPhrase: z.string().default("").describe("Last 80-120 chars of the final teaching sentence before closing prayer/altar call (verbatim)"),
  // Accept any strings — the LLM returns human-readable labels, not enum slugs,
  // and these are only used as display text in the summary. No switch logic depends on them.
  removedCategories: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export type FilterSignalResult = {
  cleanedTranscript: string;
  removedSegments: { reason: string; excerpt: string }[];
  summary: string;
};

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = RequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json(
      {
        route: "ebook/filter-signal",
        error: err instanceof Error ? err.message : "Invalid input",
        details: err instanceof Error && err.stack
          ? err.stack.split("\n").slice(0, 2).join(" | ")
          : undefined,
      },
      { status: 400 }
    );
  }

  if (Buffer.byteLength(input.masterTranscript, "utf8") > 400_000) {
    return NextResponse.json(
      { error: "Transcript exceeds 400 KB — split into smaller sessions." },
      { status: 422 }
    );
  }

  const transcript = input.masterTranscript;

  // Sample head + tail. Non-teaching content (prayers, announcements, altar calls)
  // is almost always at the very edges. We use a generous head window so the LLM
  // can see past any brief administrative opener before the teaching begins.
  // NOTE: the middle is omitted from the LLM view — therefore the teachingEndPhrase
  // must be found by the LLM in the TAIL sample only, never in the head.
  const words = transcript.split(/\s+/);
  const headSample = words.slice(0, 2000).join(" ");
  const tailSample = words.length > 2000 ? words.slice(-800).join(" ") : "";
  const sample = tailSample
    ? `HEAD OF TRANSCRIPT (first ~2000 words):\n${headSample}\n\n[…middle of transcript omitted — do NOT set teachingEndPhrase to anything from the head section above…]\n\nTAIL OF TRANSCRIPT (last ~800 words):\n${tailSample}`
    : headSample;

  try {
    const { text } = await generateText({
      model: deepSeekChat,
      temperature: 0.1,
      system: `You are a content signal filter for a book production pipeline.

${SOURCE_LOCK_RULES}

Your job is to find the VERBATIM start and end markers of the core teaching so the server can trim only the genuine non-teaching edges. BE CONSERVATIVE — when in doubt, keep content. Only identify teaching boundaries that genuinely exist in the provided transcript — never fabricate or infer teaching content that isn't explicitly present.

═══════════════════════════════════════════
NON-TEACHING content (trim only these):
═══════════════════════════════════════════
- Pure social greetings with ZERO doctrinal content: "Good morning everyone", "How is everybody doing", extended room banter that teaches nothing
- Church announcements and event/schedule notices unrelated to the message
- Thank-you lines directed at staff, choir, volunteers with no teaching value
- Offering and tithing appeals
- Altar calls and salvation invitations AFTER the main teaching has concluded
- Communion and closing prayer AFTER the main teaching has concluded
- Technical/AV breaks

═══════════════════════════════════════════
TEACHING content — ALWAYS PRESERVE:
═══════════════════════════════════════════
- The sermon title, theme statement, or opening thesis — even if it sounds like a "series announcement". A pastor saying "This month we are looking at authority over demons" IS teaching content; it is the controlling premise of the message.
- Scripture reading and exposition — any Bible passage and the words immediately around it
- Theological and doctrinal points
- Stories, analogies, and illustrations that support a teaching point
- Application statements and calls to action rooted in the teaching
- Audience engagement lines ("Can someone say amen", "Tell your neighbor") that are EMBEDDED inside teaching — these are part of the spoken style and must be kept
- Any statement that introduces, develops, or concludes a doctrinal argument

═══════════════════════════════════════════
CRITICAL RULES:
═══════════════════════════════════════════
1. DO NOT classify the opening sermon introduction as "series recap". If the pastor begins with the message theme or a scripture, that IS the teaching start.
2. Set teachingStartPhrase to the EARLIEST teaching sentence you can find — err toward keeping more, not less.
3. Set teachingEndPhrase using ONLY content from the TAIL section. Do NOT use a phrase from the HEAD section as the end marker — the middle of the transcript is omitted and you cannot see it.
4. If teaching begins within the first 5 sentences, set teachingStartPhrase to the very first sentence of the transcript.
5. If no clear non-teaching close is found, set teachingEndPhrase to the last sentence of the tail.

Return VERBATIM phrases (exact words from the transcript, 80-120 chars each) so the server can locate them by string match.

Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation:
{"teachingStartPhrase":"...","teachingEndPhrase":"...","removedCategories":[],"summary":"..."}`,
      prompt: `Identify the teaching start and end markers:\n\n${sample}`,
    });
    let _parsed: unknown;
    try {
      const _jsonMatch = text.match(/\{[\s\S]*\}/);
      _parsed = _jsonMatch ? JSON.parse(_jsonMatch[0]) : {};
    } catch {
      _parsed = {};
    }
    const _result = MarkersSchema.safeParse(_parsed);
    const object = _result.success ? _result.data : MarkersSchema.parse({});

    // Reconstruct cleaned transcript using the markers (string-match, no LLM output of full text)
    let cleaned = transcript;
    const totalWords = words.length;

    // ── START TRIM (conservative guard) ───────────────────────────────────────
    // Only remove the beginning if the start phrase appears in the first 8% of
    // the transcript. Beyond that threshold the phrase is almost certainly inside
    // teaching content that should NOT be cut, regardless of what the LLM said.
    const START_TRIM_LIMIT = Math.floor(transcript.length * 0.08);

    const start = (object.teachingStartPhrase ?? "").trim();
    if (start.length > 20) {
      const idx = transcript.indexOf(start.slice(0, 60));
      if (idx > 10 && idx <= START_TRIM_LIMIT) {
        // Re-inject the nearest preceding [Slot-N] header so the content-map
        // parser doesn't lose the first slot when greetings/prayers are trimmed.
        const before = transcript.slice(0, idx);
        const allHeaders = before.match(/\[Slot-\d+\]/g);
        const lastHeader = allHeaders ? allHeaders[allHeaders.length - 1] : null;
        cleaned = lastHeader
          ? `${lastHeader}\n${transcript.slice(idx)}`
          : transcript.slice(idx);
      }
      // If idx > START_TRIM_LIMIT the phrase is deep inside teaching content —
      // skip the trim entirely and keep the original start.
    }

    // ── END TRIM ────────────────────────────────────────────────────────────────
    const end = (object.teachingEndPhrase ?? "").trim();
    if (end.length > 20) {
      const searchKey = end.slice(0, 60);
      const idx = cleaned.lastIndexOf(searchKey);
      if (idx > 0) {
        const lineEnd = cleaned.indexOf("\n", idx + searchKey.length);
        cleaned = lineEnd > 0 ? cleaned.slice(0, lineEnd).trim() : cleaned;
      }
    }

    // ── CONTENT PRESERVATION FLOOR ────────────────────────────────────────────
    // If the combination of start + end trims has removed more than 45% of the
    // original word count, the filter has almost certainly over-trimmed. Revert
    // to only the end trim (keep full original start) so teaching content is not
    // silently destroyed.
    const cleanedWords = cleaned.split(/\s+/).filter(Boolean).length;
    if (cleanedWords < totalWords * 0.55) {
      console.warn(
        `[filter-signal] Conservation floor triggered: filtered to ${cleanedWords} words from ${totalWords} (${Math.round(cleanedWords / totalWords * 100)}%). Reverting start trim.`
      );
      // Reapply only the end trim against the original transcript
      let fallback = transcript;
      if (end.length > 20) {
        const searchKey = end.slice(0, 60);
        const idx = fallback.lastIndexOf(searchKey);
        if (idx > 0) {
          const lineEnd = fallback.indexOf("\n", idx + searchKey.length);
          fallback = lineEnd > 0 ? fallback.slice(0, lineEnd).trim() : fallback;
        }
      }
      cleaned = fallback;
    }

    const cleanedTranscript = cleanTranscriptForBook(cleaned || transcript);
    const removedSegments = object.removedCategories.map((reason) => ({ reason, excerpt: "" }));

    return NextResponse.json({
      cleanedTranscript,
      removedSegments,
      summary: object.summary ||
        (removedSegments.length > 0 ? `Removed: ${object.removedCategories.join(", ")}` : "No non-teaching content detected"),
    }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signal filter failed";
    return NextResponse.json({
      route: "ebook/filter-signal",
      error: message,
      details: err instanceof Error && err.stack
        ? err.stack.split("\n").slice(0, 3).join(" | ")
        : undefined,
    }, { status: 500 });
  }
}


