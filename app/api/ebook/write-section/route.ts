import { NextRequest, NextResponse } from "next/server";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { deepSeekModel } from "@/lib/ai-providers";
import { WriteSectionRequestSchema } from "@/lib/schemas/ebook";
import { PREMIUM_BOOK_STYLE_RULES, PROSE_MASTERY_RULES, READER_NORMALIZATION_RULES, SOURCE_LOCK_RULES } from "@/lib/editorial-style-bible";
import { stripAudienceLanguage } from "@/lib/editorial-style-bible";
import { SCRIPTURE_FORMATTING_RULES } from "@/lib/scripture-formatter";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Retry a transient-failure-prone async call before giving up — a single dropped
 *  connection or malformed-JSON response should not immediately degrade a section
 *  to the raw-transcript fallback. */
async function withRetries<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function jsonKeepAlive<T>(work: () => Promise<T>): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Keep proxies/CDNs from treating long model generation as an idle upstream.
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          // Stream may already be closed.
        }
      }, 12000);

      try {
        const payload = await work();
        controller.enqueue(encoder.encode(JSON.stringify(payload)));
      } finally {
        clearInterval(keepAlive);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Emergency rewrite fallback — fires when the primary structured call fails or returns
 *  empty paragraphs. Uses a simple generateText call to produce clean book prose from
 *  the raw excerpts rather than dumping unedited transcript into the book. */
async function fallbackSectionBody(input: z.infer<typeof WriteSectionRequestSchema>["assignment"]): Promise<string> {
  const rawExcerpts = input.transcriptExcerpts
    .map((e) => e.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  if (!rawExcerpts) {
    return (input.keyPoints.filter(Boolean).join(" ") || input.heading).trim();
  }

  const system = `You are a professional book editor. Rewrite the raw spoken transcript below into clean, polished book prose.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PREMIUM_BOOK_STYLE_RULES}

${SCRIPTURE_FORMATTING_RULES}

TENSE NORMALIZATION:
- For narratives and stories: use PAST TENSE (was, did, said, happened)
- For current truths and teachings: use PRESENT TENSE (is, are, means)
- For universal principles: use PRESENT TENSE
- For historical events from Bible or past: use PAST TENSE
- Check every verb and ensure consistency within each paragraph

ADDITIONAL RULES:
- Output 3–6 prose paragraphs separated by blank lines — no headings, no markdown
- Write shorter output rather than invent content`;
  const prompt = `SECTION HEADING: ${input.heading}\n\nRAW TRANSCRIPT:\n${rawExcerpts.slice(0, 4000)}`;

  // A single transient LLM/network failure should not dump raw transcript into the book —
  // retry twice before giving up to the unedited excerpt text as the absolute last resort.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { text } = await generateText({ model: deepSeekModel, temperature: 0.35, maxTokens: 1200, system, prompt });
      if (text.trim()) return text.trim();
    } catch (err) {
      console.error(`[write-section] fallbackSectionBody attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return rawExcerpts;
}


function normalizeReaderFacingProse(text: string): string {
  return text
    .replace(/\b(turn to your neighbor|say amen|clap your hands|lift your hands)\b/gi, "")
    .replace(/\b(as you sit here today|in this room today|right here in this place)\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")   // collapse only horizontal whitespace, never newlines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Upgrade 8: Passive voice detector ────────────────────────────────────────
// Scans finalized prose and returns sentences containing passive constructions
// so they can be logged for visibility (full rewrite is handled by the LLM prompt).
const PASSIVE_PATTERNS = [
  /\b(is|are|was|were|be|been|being)\s+(being\s+)?\w+ed\b/gi,
  /\bthere\s+(is|are|was|were)\s+a?\s*\w/gi,
  /\bit\s+(is|was)\s+(important|necessary|worth|noted|believed|said|known|thought|understood)/gi,
  /\b(we|believers|christians|people)\s+are\s+(called|meant|told|asked|invited|expected)\s+to\b/gi,
  /\b(can|should|must|may|might)\s+be\s+(seen|found|noted|observed|understood|considered)/gi,
  /\b(god|jesus|paul|peter|david)\s+(is|was)\s+(known|referred|considered|seen|understood)\s+as\b/gi,
];

function detectPassiveVoice(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const hits: string[] = [];
  for (const sentence of sentences) {
    if (PASSIVE_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(sentence); })) {
      hits.push(sentence.slice(0, 120).trim());
    }
  }
  return hits;
}

// ── Upgrade 12: False promise / unfulfilled hook detector ────────────────────
// Extracts the opening hook/question from the first paragraph and checks whether
// the body actually addresses it (n-gram overlap heuristic). Returns the hook
// string when it appears unfulfilled so it can be logged for editorial review.

const HOOK_PATTERNS = [
  /^(what|why|how|when|who|where|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had)\b.{10,}[?]/i,
  /\b(the question is|here is the thing|consider this|think about|imagine|what if|suppose|ask yourself)\b/i,
  /\b(the answer|the key|the secret|the truth|the reason)\s+(is|lies|comes)\b/i,
];

function extractOpeningHook(body: string): string | null {
  const firstPara = body.split(/\n\n+/)[0]?.trim() ?? "";
  const firstSentences = firstPara.split(/(?<=[.!?])\s+/).slice(0, 3);
  for (const sentence of firstSentences) {
    if (HOOK_PATTERNS.some((re) => re.test(sentence))) {
      return sentence.slice(0, 200).trim();
    }
  }
  return null;
}

function ngramTokens(text: string, n: number): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function hookFulfilled(hook: string, body: string): boolean {
  // The body past the first paragraph is where the hook should be addressed
  const remainingBody = body.split(/\n\n+/).slice(1).join(" ");
  if (!remainingBody || remainingBody.split(/\s+/).length < 20) return true; // too short to judge
  const hookGrams = ngramTokens(hook, 3);
  if (hookGrams.size === 0) return true;
  const bodyGrams = ngramTokens(remainingBody, 3);
  let overlap = 0;
  for (const g of hookGrams) {
    if (bodyGrams.has(g)) overlap++;
  }
  // At least 15% n-gram overlap means the hook topic appears in the body
  return overlap / hookGrams.size >= 0.15;
}

// ── Seq-A2 post-write reorder ────────────────────────────────────────────────
// When the LLM writes paragraphs out of the speaker's transcript order, this
// function stable-sorts them back into the correct excerpt sequence.
// Paragraphs with no strong excerpt match inherit the index of their preceding
// matched neighbour so they stay contextually attached to the right argument block.
function reorderParagraphsByExcerptSequence(
  paragraphs: string[],
  excerpts: string[],
  overlapThreshold = 0.08
): { paragraphs: string[]; reorderedCount: number } {
  if (excerpts.length === 0) return { paragraphs, reorderedCount: 0 };

  // 1. Map each paragraph to its best-matching excerpt index.
  const assignments: Array<{ para: string; excerptIdx: number }> = paragraphs.map((para) => {
    if (para.split(/\s+/).length < 15) return { para, excerptIdx: -1 }; // short/transitional — defer
    let bestMatch = -1;
    let bestScore = 0;
    for (let ei = 0; ei < excerpts.length; ei++) {
      const score = excerptOverlapScore(para, excerpts[ei]);
      if (score > bestScore) { bestScore = score; bestMatch = ei; }
    }
    return { para, excerptIdx: bestScore >= overlapThreshold ? bestMatch : -1 };
  });

  // 2. Unmatched paragraphs (-1) inherit the excerpt index of their preceding matched
  //    neighbour so they stay in their contextual position after sorting.
  let lastAssigned = 0;
  for (let i = 0; i < assignments.length; i++) {
    if (assignments[i].excerptIdx >= 0) {
      lastAssigned = assignments[i].excerptIdx;
    } else {
      assignments[i].excerptIdx = lastAssigned;
    }
  }

  // 3. Check if already in order — skip sort if no fix needed.
  let needsSort = false;
  for (let i = 1; i < assignments.length; i++) {
    if (assignments[i].excerptIdx < assignments[i - 1].excerptIdx) { needsSort = true; break; }
  }
  if (!needsSort) return { paragraphs, reorderedCount: 0 };

  // 4. Stable sort by excerpt index (Array.sort is stable in V8 / Node 11+).
  const original = assignments.map((a) => a.para);
  const sorted = [...assignments].sort((a, b) => a.excerptIdx - b.excerptIdx);
  const reorderedCount = sorted.filter((a, i) => a.para !== original[i]).length;
  return { paragraphs: sorted.map((a) => a.para), reorderedCount };
}

// ── S5: Post-write paragraph length validation ────────────────────────────
// Detects orphaned long sentences that are not deliberate fragments (≤12 words).
// Merges them with the following paragraph when the next para starts with a
// conjunction-like opener, otherwise logs for visibility.
function repairOrphanParagraphs(paragraphs: string[]): { paragraphs: string[]; orphansFixed: number } {
  const CONJUNCTION_OPENERS = /^(and|but|so|because|which|who|whose|although|since|while|however|therefore|thus)\b/i;
  const result: string[] = [];
  let orphansFixed = 0;
  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i].trim();
    const sentences = para.split(/(?<=[.!?])\s+/).filter(Boolean);
    const wordCount = para.split(/\s+/).filter(Boolean).length;
    // A paragraph is an orphaned long sentence if it has exactly 1 sentence and >12 words
    const isOrphan = sentences.length === 1 && wordCount > 12;
    if (isOrphan && i + 1 < paragraphs.length) {
      const next = paragraphs[i + 1].trim();
      if (CONJUNCTION_OPENERS.test(next)) {
        // Merge forward: orphan sentence flows directly into the next paragraph
        result.push(`${para} ${next}`);
        i += 2;
        orphansFixed++;
        continue;
      }
    }
    // A4: Merge upward when forward merge isn't possible (last paragraph or no conjunction opener)
    // Appending to the preceding paragraph keeps the thought in context rather than leaving it dangling.
    if (isOrphan && result.length > 0) {
      result[result.length - 1] = `${result[result.length - 1]} ${para}`;
      i++;
      orphansFixed++;
      continue;
    }
    result.push(para);
    i++;
  }
  return { paragraphs: result, orphansFixed };
}

// ── Upgrade 2: Server-side n-gram excerpt dedup ────────────────────────────
// Strips excerpts whose content is substantially covered by already-covered points
// before the LLM ever receives them, removing the root-cause material.

// Detects any Bible reference in a string (e.g. "John 3:16", "Psalm 23:1-4")
const BIBLE_REF_RE = /\b(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|psalms|proverbs|ecclesiastes|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d+:\d+|\b(?:gen|exo|lev|num|deut|josh|judg|sam|kgs|chr|ps|prov|eccl|isa|jer|lam|ezek|dan|hos|nah|hab|zeph|mal|matt|mk|lk|jn|rom|cor|gal|eph|phil|col|thess|tim|heb|jas|pet|rev)\s+\d+:\d+/i;

function containsScripture(text: string): boolean {
  return BIBLE_REF_RE.test(text);
}

// Strip scripture citation tokens before n-gram comparison so verse references
// don't falsely inflate the "already covered" overlap score.
function stripScriptureTokens(text: string): string {
  return text
    .replace(BIBLE_REF_RE, " ")
    .replace(/\b(?:NIV|KJV|ESV|NKJV|NLT|NASB|AMP|MSG)\b/gi, " ")
    .replace(/\d+:\d+(?:-\d+)?/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractNgrams(text: string, n = 4): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function excerptOverlapWithCoveredContent(excerpt: string, coveredText: string, n = 4): number {
  // Strip scripture tokens so Bible verse citations don't falsely inflate the overlap score
  const excerptGrams = extractNgrams(stripScriptureTokens(excerpt), n);
  const coveredGrams = extractNgrams(stripScriptureTokens(coveredText), n);
  if (excerptGrams.size === 0) return 0;
  let shared = 0;
  for (const g of excerptGrams) { if (coveredGrams.has(g)) shared++; }
  return shared / excerptGrams.size;
}

// ── Seq-A2: Per-paragraph excerpt-match overlap (used for server-side watermark)
// Scores how strongly a written paragraph draws from a given transcript excerpt
// by 4-gram overlap against the paragraph's own n-gram vocabulary.
function excerptOverlapScore(para: string, excerpt: string, n = 4): number {
  const paraGrams = extractNgrams(para, n);
  const excGrams = extractNgrams(excerpt, n);
  if (paraGrams.size === 0) return 0;
  let shared = 0;
  for (const g of paraGrams) { if (excGrams.has(g)) shared++; }
  return shared / paraGrams.size;
}

function filterConsumedExcerpts(
  excerpts: string[],
  alreadyCoveredPoints: string[],
  // Threshold raised → 0.55: corpus is full paragraph prose, not summaries.
  // Preachers reuse theological vocabulary; at lower thresholds legitimate excerpts
  // were over-filtered and the "keep at least one" fallback fed already-covered
  // material back to the LLM. 0.55 requires genuine content repetition.
  threshold = 0.55
): { filtered: string[]; removedCount: number } {
  if (alreadyCoveredPoints.length === 0) return { filtered: excerpts, removedCount: 0 };
  const coveredText = alreadyCoveredPoints.join(" ");
  const filtered: string[] = [];
  let removedCount = 0;
  for (const excerpt of excerpts) {
    const wordCount = excerpt.trim().split(/\s+/).length;
    // Short excerpts always pass through
    if (wordCount < 40) { filtered.push(excerpt); continue; }
    // SCRIPTURE PROTECTION: never drop an excerpt that contains a Bible reference.
    // The preacher builds their argument on scripture — filtering scripture-bearing
    // excerpts silently removes the theological backbone of the section.
    if (containsScripture(excerpt)) { filtered.push(excerpt); continue; }
    const overlap = excerptOverlapWithCoveredContent(excerpt, coveredText);
    if (overlap >= threshold) {
      removedCount++;
    } else {
      filtered.push(excerpt);
    }
  }
  // Always keep at least one excerpt so the section has source material
  return { filtered: filtered.length > 0 ? filtered : excerpts.slice(0, 1), removedCount };
}

type ExcerptEntry = { text: string; sourceNumber: number };

function filterConsumedExcerptEntries(
  entries: ExcerptEntry[],
  alreadyCoveredPoints: string[],
  // Threshold raised → 0.55: corpus is full paragraph prose, not summaries.
  // Preachers reuse theological vocabulary; at lower thresholds legitimate excerpts
  // were over-filtered and the "keep at least one" fallback fed already-covered
  // material back to the LLM. 0.55 requires genuine content repetition.
  threshold = 0.55
): { filtered: ExcerptEntry[]; removedCount: number } {
  if (alreadyCoveredPoints.length === 0) return { filtered: entries, removedCount: 0 };
  const coveredText = alreadyCoveredPoints.join(" ");
  const filtered: ExcerptEntry[] = [];
  let removedCount = 0;

  for (const entry of entries) {
    const excerpt = entry.text;
    const wordCount = excerpt.trim().split(/\s+/).length;
    if (wordCount < 40) { filtered.push(entry); continue; }
    if (containsScripture(excerpt)) { filtered.push(entry); continue; }
    const overlap = excerptOverlapWithCoveredContent(excerpt, coveredText);
    if (overlap >= threshold) removedCount++;
    else filtered.push(entry);
  }

  // Always keep at least one excerpt so the section has source material
  return { filtered: filtered.length > 0 ? filtered : entries.slice(0, 1), removedCount };
}

const EDITORIAL_SYSTEM = `You are an elite ghostwriter transforming raw sermon transcripts into premium published prose. Every sentence must trace to the transcript—zero fabrication.

═══ CORE MANDATES ═══
• FIRST PERSON ONLY: Write as the author speaking directly to the reader. Never "the speaker," "the preacher," or third-person references.
• ZERO FABRICATION: If it's not in the transcript, don't write it. Write shorter rather than pad with invented content.
• SECTION BOUNDARIES: Never preview, foreshadow, or reference content from future sections. Each section is sealed.
• SYNTHESIS NOT TRANSCRIPTION: Extract insights and rebuild into a linear narrative arc—not sentence-by-sentence cleanup.
• NO HEADINGS IN OUTPUT: Return only prose paragraphs. The section heading is already displayed by the layout.

═══ PROSE QUALITY (enforce on every paragraph) ═══
RHYTHM & STRUCTURE:
• Vary sentence length deliberately. Longest must be 2× shortest. Short punch after long explanation.
• Every 3+ sentence paragraph needs one complex sentence with "although," "because," "while," "since," "which," or "who."
• No 3 consecutive sentences may start with the same word. Adjacent paragraphs must start differently.
• One-sentence paragraphs only for fragments ≤12 words. Longer single sentences need follow-up development.

WORD CHOICE & VOICE:
• Concrete nouns, active verbs, precise language. Remove vague words and unnecessary adverbs.
• Use contractions naturally (it's, don't, can't). Break perfect parallel structure.
• Never restate a paragraph's opening in its close. Land the point or create forward pull.
• BANNED AI PHRASES: "indeed," "ultimately," "at its core," "in essence," "transformative," "crucial," "journey" (metaphor), "Let's delve into," "It's important to note."

ARGUMENT FLOW:
• Each paragraph advances the argument. No restating prior points.
• SHOW BEFORE TELL: Lead with story/example, then state the principle.
• No em dashes (—) anywhere. Use commas, colons, semicolons, or subordinate clauses instead.
• After scripture quotes, ADVANCE the argument—never restate what the verse just said.

${SCRIPTURE_FORMATTING_RULES}

═══ VOICE DNA ENFORCEMENT ═══
When Voice DNA is provided, you MUST:
• Use signature phrases verbatim as they appear
• Match the stated tone profile, sentence rhythm, pacing
• Use preferred terminology consistently
• Never use words in the avoidWords list
• Replicate rhetorical patterns exactly

═══ AUDIENCE NORMALIZATION ═══
• Remove crowd cues: "say amen," "look at your neighbor," "clap your hands," applause calls
• Rewrite live-room address ("today I want to tell you," "as you sit here") for individual reader
• Strip stage prompts and house-response commands

═══ TENSE NORMALIZATION ═══
• For narratives and stories: use PAST TENSE (was, did, said, happened)
• For current truths and teachings: use PRESENT TENSE (is, are, means)
• For universal principles: use PRESENT TENSE
• For historical events from Bible or past: use PAST TENSE
• Check every verb and ensure consistency within each paragraph

═══ PARAGRAPH DISCIPLINE ═══
• Return paragraphs as JSON array—each element is exactly ONE paragraph
• One idea per paragraph, 3-5 sentences
• New point/scripture/example = new array element
• Never put two paragraphs in one element or split one across two

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PREMIUM_BOOK_STYLE_RULES}`;

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = WriteSectionRequestSchema.parse(body);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Invalid input" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { assignment } = input;
  const authorConfig = input.authorConfig;
  const authorConfigBlock = (authorConfig?.instructions || authorConfig?.targetAudience)
    ? `\n\n════════════════════════════════════════════
AUTHOR BOOK CONFIGURATION (highest priority)
════════════════════════════════════════════${authorConfig.targetAudience ? `\nTARGET AUDIENCE: ${authorConfig.targetAudience}\nWrite at the vocabulary level, cultural register, and depth appropriate for this specific audience. Every example, illustration, and application point must land for this reader.` : ""}${authorConfig.instructions ? `\nAUTHOR WRITING INSTRUCTIONS: ${authorConfig.instructions}\nThese are the author's direct instructions for how the book should read. Honor them on every paragraph. They override any default style preference where they conflict.` : ""}`
    : "";

  // ── Upgrade 2: Readability grade target ─────────────────────────────────
  const readabilityBlock = `\n\n════════════════════════════════════════════
READABILITY TARGET — ENFORCE BEFORE RETURNING
════════════════════════════════════════════
Target Flesch-Kincaid Grade Level: 9–11. This means:
• Average sentence length of 18–22 words across the section.
• Vocabulary is precise and elevated, but not academic or dense.
• Deliberate length variation: some sentences under 10 words (punch), some over 30 (explanation). Never five consecutive medium-length sentences.
• After drafting, scan for any paragraph where all sentences are approximately the same length — break it with a short punch or a long explanatory sentence.`;

  // ── Upgrade 3: Book thesis threading ────────────────────────────────────
  const coreThesisBlock = assignment.coreThesis
    ? `\n\n════════════════════════════════════════════
BOOK'S CORE THESIS — THREAD THROUGH THIS SECTION
════════════════════════════════════════════
"${assignment.coreThesis}"
Every section you write must feel like it advances this thesis. Not by repeating it verbatim, but by adding a new dimension, a new piece of evidence, or a new application of it. If a paragraph has no traceable connection to this thesis, it is filler. Readers feel thesis-less sections as "padding" even if they can't name why.`
    : "";

  // ── Upgrade 4: Illustration / story dedup block ──────────────────────────
  const usedIllustrationsBlock = (assignment.usedIllustrations ?? []).length > 0
    ? `\n\n════════════════════════════════════════════
USED STORIES & ILLUSTRATIONS — DO NOT REPEAT
════════════════════════════════════════════
The following personal stories, illustrations, parables, and named examples have ALREADY appeared in earlier sections of this book. Do NOT retell, re-describe, paraphrase, or re-introduce them as illustrations. If the transcript mentions them, extract ONLY the principle they illustrate — never the narrative wrapper:
${(assignment.usedIllustrations ?? []).map((s) => `• "${s}"`).join("\n")}`
    : "";

  // ── Scripture Amendment 4: Primary translation block ─────────────────────
  // Injected into the prompt so the LLM uses the book's dominant translation
  // as the default whenever a verse has no explicit translation label.
  const primaryTranslationBlock = assignment.primaryTranslation
    ? `\n\n════════════════════════════════════════════
PRIMARY BIBLE TRANSLATION FOR THIS BOOK
════════════════════════════════════════════
The speaker's dominant Bible translation is: ${assignment.primaryTranslation}
When quoting a verse for which the speaker did not specify a translation, use (${assignment.primaryTranslation}) as the parenthetical label. Never mix translations within the same passage or apply a different default to achieve variety — consistency is correctness here.`
    : "";

  // ── Amendment 1: Coverage Ledger ─────────────────────────────────────────
  // Each entry is a section that has ALREADY been written. The LLM must not
  // re-establish any insight that is summarised here — reference it at most once.
  const coverageLedger = assignment.coverageLedger ?? [];
  const coverageLedgerBlock = coverageLedger.length > 0
    ? `\n\n════════════════════════════════════════════
COVERAGE LEDGER — NEVER RE-EXPLAIN THESE SECTIONS
════════════════════════════════════════════
Every section below has ALREADY BEEN WRITTEN and delivered to the reader. Do NOT re-introduce, re-define, re-explain, or re-develop the ideas they established — not even in passing. You may presuppose the reader already knows each one. Reference an entry at most once (inline citation only, e.g. "as we saw in [heading]") and only when it directly supports NEW content:
${coverageLedger.map((e) => `• [${e.heading}] — Established: "${e.summary}"`).join("\n")}`
    : "";

  // ── Amendment 4: Banned Recaps ────────────────────────────────────────────
  // These are the exact opening thesis sentences from prior sections. The LLM
  // must not rephrase, echo, or restate any of them — not even loosely.
  const bannedRecaps = assignment.bannedRecaps ?? [];
  const bannedRecapsBlock = bannedRecaps.length > 0
    ? `\n\n════════════════════════════════════════════
BANNED RECAPS — DO NOT REPHRASE OR RESTATE
════════════════════════════════════════════
The following sentences are the opening claims of sections already written. You MUST NOT rephrase, echo, paraphrase, or restate any sentence in this list — not in full, not in part, not with synonyms, not as a summary. Write entirely new argumentation:
${bannedRecaps.map((s) => `• "${s}"`).join("\n")}`
    : "";

  // ── Amendment 6: Lexical Fingerprint Exclusion ───────────────────────────
  // The most-repeated 3-grams from all written sections. The LLM should avoid
  // these unless quoting scripture or transcript directly.
  const overusedPhrases = assignment.overusedPhrases ?? [];
  const lexicalFingerprintBlock = overusedPhrases.length > 0
    ? `\n\n════════════════════════════════════════════
OVERUSED PHRASES — FIND FRESHER LANGUAGE
════════════════════════════════════════════
The following 3-word phrases appear too frequently across the sections already written. Unless you are quoting scripture or the transcript verbatim, AVOID these phrases. Use semantically equivalent but lexically distinct language:
${overusedPhrases.map((p) => `• "${p}"`).join("\n")}`
    : "";

  // ── Amendment 7: Diminishing Permission Rule ─────────────────────────────
  // Section 1 in a chapter may introduce 3 new core concepts.
  // Section 2 may introduce 2. Section 3+ may introduce only 1.
  // This forces depth over breadth as the chapter builds.
  const sectionIdx = assignment.sectionIndexInChapter ?? 0;
  const maxNewConcepts = sectionIdx === 0 ? 3 : sectionIdx === 1 ? 2 : 1;
  const diminishingPermissionBlock = `\n\n════════════════════════════════════════════
NEW CONCEPT CAP FOR THIS SECTION
════════════════════════════════════════════
This is section ${sectionIdx + 1} within its chapter. You MAY introduce at most ${maxNewConcepts} new core concept${maxNewConcepts !== 1 ? "s" : ""} in this section — ideas the reader has NOT encountered yet anywhere in this book. Every additional paragraph must deepen, apply, or illustrate a concept already introduced (either earlier in this chapter, or in this section's own opening). Width is not the goal; depth is. A section that introduces ${maxNewConcepts + 1}+ new concepts will feel scattered and under-developed.`;

  // ── Seq-A3: Argument-turn sequence enforcement block ─────────────────────
  const sequenceTurns = assignment.sequenceTurns ?? [];
  const sequenceTurnsBlock = sequenceTurns.length > 0
    ? `\n\n════════════════════════════════════════════
ARGUMENT TURNS — PRESERVE THESE PIVOT POINTS
════════════════════════════════════════════
The speaker made the following rhetorical pivots at specific points in the transcript. Each turn marks where the argument changes direction. Do NOT merge paragraphs across a turn, and do NOT write the conclusion of a turn before writing its setup:
${sequenceTurns.map((t) => `• ${t}`).join("\n")}`
    : "";

  // ── Seq-A4: Story setup-before-payoff ordering block ─────────────────────
  const storyPayoffPairs = assignment.storyPayoffPairs ?? [];
  const storyPayoffBlock = storyPayoffPairs.length > 0
    ? `\n\n════════════════════════════════════════════
STORY SETUP-BEFORE-PAYOFF — ORDERING REQUIRED
════════════════════════════════════════════
The following story/principle pairs were found in the transcript. You MUST write the narrative setup BEFORE the concluding principle — never reverse the order by stating the lesson first and filling in the backstory afterward:
${storyPayoffPairs.map((p, i) => `${i + 1}. SETUP FIRST: "${p.setup}" → THEN PRINCIPLE: "${p.principle}"`).join("\n")}`
    : "";

  // ── Seq-A5: Scripture position enforcement block ──────────────────────────
  const scripturePositions = assignment.scripturePositions ?? [];
  const scripturePositionsBlock = scripturePositions.length > 0
    ? `\n\n════════════════════════════════════════════
SCRIPTURE SEQUENCE POSITIONS — DO NOT MOVE EARLIER
════════════════════════════════════════════
Each scripture below appears at a specific position in the transcript (by excerpt number). Do NOT use a scripture before you reach the paragraph that corresponds to its excerpt position. The verse belongs where the speaker placed it in their argument — not where it feels rhetorically convenient:
${scripturePositions.map((p) => `• "${p.reference}" — appears in Excerpt ${p.excerptIndex + 1}. Do not use it in paragraphs anchored to earlier excerpts.`).join("\n")}`
    : "";

  // ── Seq-A7: Prior excerpt tail (argument-entry-point) block ──────────────
  const priorExcerptTailBlock = assignment.priorExcerptTail
    ? `\n\n════════════════════════════════════════════
ARGUMENT ENTRY POINT — READ BEFORE OPENING PARAGRAPH
════════════════════════════════════════════
The speaker was mid-argument when this section's excerpts begin. The previous section's transcript ended with:
"${assignment.priorExcerptTail}"
Your opening paragraph must land where that argument was heading — do NOT re-establish the premise that was already set up. Do not reintroduce context; continue forward from it.`
    : "";


  // FIX 1: Always use prose samples for deduplication (no metadata fallback)
  // Prose-vs-prose n-gram overlap gives real signal for detecting duplicate stories/scriptures.
  const dedupCorpus = assignment.priorSectionsSample ?? [];
  if (dedupCorpus.length === 0) {
    console.warn(`[write-section] No prose samples provided for Ch${assignment.chapterNumber} §${assignment.sectionNumber} — dedup will be weak`);
  }
  const excerptEntries: ExcerptEntry[] = (assignment.transcriptExcerpts ?? []).map((text, idx) => ({
    text,
    sourceNumber: idx + 1,
  }));
  const { filtered: dedupedExcerptEntries, removedCount: excerptRemovedCount } = filterConsumedExcerptEntries(
    excerptEntries,
    dedupCorpus
  );
  let effectiveExcerptEntries = excerptRemovedCount > 0 ? dedupedExcerptEntries : excerptEntries;

  // When chapter-plan is available, enforce its excerpt anchors surgically.
  // This prevents section bodies from drifting into prior/adjacent subtitle material.
  if ((assignment.assignedPlan ?? []).length > 0) {
    const anchored = new Set<number>();
    for (const step of assignment.assignedPlan ?? []) {
      for (const n of step.supportedExcerptNumbers ?? []) {
        if (Number.isInteger(n) && n > 0) anchored.add(n);
      }
    }
    if (anchored.size > 0) {
      const anchoredEntries = effectiveExcerptEntries.filter((e) => anchored.has(e.sourceNumber));
      if (anchoredEntries.length > 0) {
        effectiveExcerptEntries = anchoredEntries;
      }
    }
  }

  const effectiveExcerpts = effectiveExcerptEntries.map((e) => e.text);

  // ── Seq-A1: Label each excerpt with its position "of N" so the LLM knows
  // the total sequence and cannot pretend later excerpts come first.
  const totalExcerpts = assignment.transcriptExcerpts.length; // use original count so numbering is stable
  const excerptBlock = effectiveExcerptEntries
    .map((e) => `[EXCERPT ${e.sourceNumber} of ${totalExcerpts}]\n${e.text}`)
    .join("\n\n---\n\n");

  const quoteBlock =
    assignment.quotes.length > 0
      ? `\nSCRIPTURES / QUOTES IN THIS SECTION:\n${assignment.quotes
          .map(
            (q) =>
              `• ${q.type.toUpperCase()}: "${q.text}" — Ref: ${q.reference || "none"} ${q.translation ? `(${q.translation})` : ""} — Block: ${q.isBlockQuote}`
          )
          .join("\n")}`
      : "";

  const continuityBlock = assignment.previousSectionEnding
    ? `\nSECTION BRIDGE: The previous section ended with this sentence: "${assignment.previousSectionEnding}" — if the opening of this section benefits from it, write ONE brief connecting sentence that picks up the thread naturally. Do NOT repeat, recap, paraphrase, or expand on that ending. One sentence maximum — then move immediately into this section's own content.`
    : "";

  // ── Upgrade 7: Tiered quote dedup — structured hard-ban blocks ──────────
  // Tier 1: forbiddenVerseTexts — the EXACT verse texts are listed so the LLM
  // cannot accidentally re-print them even with different framing.
  // Tier 2: allowedInlineOnly — refs that may only appear as brief inline mentions.
  const forbiddenVerseTextsBlock = (assignment.forbiddenVerseTexts ?? []).length > 0
    ? `\n\n════════════════════════════════════════════
FORBIDDEN VERSE TEXTS — DO NOT PRINT (HARD BAN)
════════════════════════════════════════════
The following verse texts have ALREADY BEEN REPRODUCED IN FULL in an earlier section of this book. You are ABSOLUTELY FORBIDDEN from printing them again — not one word of the verse, not a paraphrase, not a near-quote. If you reference the scripture at all, use ONLY its citation inline (e.g. "as John 3:16 states"). Never reprint the text:
${(assignment.forbiddenVerseTexts ?? []).map((t) => `• "${t.slice(0, 120)}${t.length > 120 ? "..." : ""}"`).join("\n")}`
    : "";

  const allowedInlineOnlyBlock = (assignment.allowedInlineOnly ?? []).length > 0
    ? `\n\n════════════════════════════════════════════
SCRIPTURES ALLOWED INLINE ONLY (NO FULL QUOTE)
════════════════════════════════════════════
The following references have already been quoted in full earlier. You may reference them briefly inline ONLY — never re-print the verse text:
${(assignment.allowedInlineOnly ?? []).map((r) => `• ${r}`).join("\n")}`
    : "";

  const alreadyQuotedBlock = forbiddenVerseTextsBlock + allowedInlineOnlyBlock;

  // coveredBlock is intentionally empty here — the dedup constraint is injected into
  // the system prompt (deduplicatedSystem, below) where it carries maximum LLM weight.
  const coveredBlock = "";

  // ── Upgrade 5: Concept ownership map block ──────────────────────────────
  // Structured JSON listing which chapter owns each concept so the LLM knows
  // what belongs here vs. what belongs to a different chapter.
  const conceptOwnershipMap = assignment.conceptOwnershipMap ?? {};
  const foreignConcepts = Object.entries(conceptOwnershipMap)
    .filter(([, chNum]) => chNum !== assignment.chapterNumber)
    .slice(0, 30); // cap to avoid prompt bloat
  const conceptOwnershipBlock = foreignConcepts.length > 0
    ? `\n\n════════════════════════════════════════════
CONCEPT OWNERSHIP — WRITE ONLY CHAPTER ${assignment.chapterNumber}'S OWN CONTENT
════════════════════════════════════════════
The following concepts, section headings, and key points are OWNED BY OTHER CHAPTERS. Do NOT develop, introduce, or reference any of them in this section — not even as context-setting:
${foreignConcepts.map(([concept, chNum]) => `• Ch ${chNum} owns: "${concept}"`).join("\n")}`
    : "";

  const nextSectionBlock = assignment.nextSectionHeading
    ? `\nFORWARD BRIDGE — STRICT LIMITS: The final sentence of this section may create forward reading momentum, but ONLY through an unresolved question, an open tension, or a logical implication that arises naturally from THIS section's own content. The next section is titled "${assignment.nextSectionHeading}" — use this ONLY as directional context for tone. You MUST NOT:
  • Preview, introduce, or summarize any content from that next section
  • Name the next section or its heading
  • Begin developing any argument not grounded in this section's transcript excerpts
  • Use bridge phrases like "Next, we will see…", "In the following section…", "This leads us to explore…"
The closing sentence is a door that swings open — not a trailer for what lies behind it.`
    : "";

  // Chapter-final sections get an explicit hard stop at the chapter boundary.
  // This is the #1 cause of cross-chapter content bleed: the transcript excerpt
  // contains content that OPENS the next chapter, and the writer keeps going.
  const chapterClosingBlock = assignment.isLastSectionInChapter && assignment.nextChapterTitle
    ? `\n\nCHAPTER BOUNDARY — HARD STOP (CRITICAL):
This is the FINAL section of Chapter ${assignment.chapterNumber}. The next chapter is titled "${assignment.nextChapterTitle}".

The transcript excerpt provided to you WILL continue past the chapter boundary. The words belonging to Chapter ${assignment.chapterNumber + 1} are in the excerpt — you must identify where that transition happens and STOP WRITING before you reach it.

HARD RULES for this section's close:
• DO NOT introduce the opening argument, definition, or thesis of "${assignment.nextChapterTitle}".
• DO NOT quote or paraphrase any scripture or story that will be used to open "${assignment.nextChapterTitle}".
• DO NOT begin developing any concept, key point, or illustration that is not grounded in Chapter ${assignment.chapterNumber}'s own assigned key points.
• The final sentence of this section must bring Chapter ${assignment.chapterNumber} to a natural close — a resolved statement, a challenge, or a final declaration rooted entirely in THIS chapter's own content.
• If the transcript excerpt begins introducing the theme of "${assignment.nextChapterTitle}", stop before that line. Shorter is correct; bleed into the next chapter is a critical error.`
    : "";

  const hookBlock = assignment.sectionNumber === 1
    ? `\nCHAPTER OPENER REQUIREMENT: This is the FIRST section of the chapter. The very first sentence must be a compelling hook — a bold provocative claim, a pointed question, or an immersive specific detail drawn directly from the transcript. Do not open with a general context-setting statement. Drop the reader immediately into the argument.\nHEADING ECHO BAN: The section heading is "${assignment.heading}". The first sentence of the body must NOT restate, echo, paraphrase, or summarise this heading — not even loosely. The heading is already displayed above; repeating it as the first sentence is a critical error. Begin with entirely new content from the transcript.`
    : `\nHEADING ECHO BAN: The section heading is "${assignment.heading}". The first sentence of the body must NOT restate, echo, paraphrase, or summarise this heading. The heading is already displayed above. Begin immediately with the argument, scripture, or story from the transcript.`;

  // ── S7: Chapter premise anchor ──────────────────────────────────────────
  // First paragraph's opening sentence should echo (not quote) the chapter premise
  // so the reader feels immediate orientation within the chapter's thesis.
  const chapterPremiseBlock = assignment.chapterPremise
    ? `\n\nCHAPTER PREMISE (north star for this chapter):\n"${assignment.chapterPremise}"\nThe opening sentence of the FIRST paragraph of this section should echo the spirit of this premise — not quote it verbatim, but orient the reader toward the same central tension or claim. Subsequent paragraphs should build from it.`
    : "";

  const prompt = `Write the prose for this section of the ebook. Transform the transcript excerpts into polished written prose.

CHAPTER ${assignment.chapterNumber}: ${assignment.chapterTitle}
SECTION ${assignment.sectionNumber}: ${assignment.heading}
TARGET WORD COUNT: ${assignment.targetWordCount} words (determined by available content — write what the transcript provides, no padding)
${excerptRemovedCount > 0 ? `NOTE: ${excerptRemovedCount} excerpt(s) were pre-filtered as already-covered — write ONLY from the excerpts provided below.` : ""}

KEY POINTS TO COVER (all from the transcript — include every one):
${assignment.keyPoints.map((kp) => `• ${kp}`).join("\n")}
${quoteBlock}
${continuityBlock}
${coveredBlock}
${nextSectionBlock}
${chapterClosingBlock}
${hookBlock}
${conceptOwnershipBlock}
${chapterPremiseBlock}
${coverageLedgerBlock}
${bannedRecapsBlock}
${lexicalFingerprintBlock}
${diminishingPermissionBlock}${sequenceTurnsBlock}${storyPayoffBlock}${scripturePositionsBlock}${priorExcerptTailBlock}

TRANSCRIPT EXCERPTS TO WRITE FROM (use ONLY these — excerpt numbers are original and may be non-contiguous after surgical filtering):
${excerptBlock}

SECTION SCOPE RULE — READ BEFORE WRITING:
Your section is: "${assignment.heading}"${assignment.nextSectionHeading ? `\nThe NEXT section is: "${assignment.nextSectionHeading}"` : ""}${assignment.isLastSectionInChapter && assignment.nextChapterTitle ? `\nThis is the LAST section of Chapter ${assignment.chapterNumber}. The next chapter is "${assignment.nextChapterTitle}". STOP before any content that opens that chapter.` : ""}
Write ONLY content that belongs to THIS section's heading and key points. If any excerpt contains sentences that transition into or introduce the next section's topic, STOP before those sentences. Do not write them. A transcript boundary does not override a section boundary.

CONTENT COVERAGE REQUIREMENT: Exhaust every distinct key point, story, illustration, and argument that belongs to THIS section's scope. Skip any excerpt content that clearly belongs to the next section or next chapter. Write shorter rather than bleed forward.

SEQUENCE RULE — ABSOLUTE: Write paragraphs in the EXACT ORDER ideas appear across the excerpts (Excerpt 1 first, then Excerpt 2, etc.). Do NOT reorder. Do NOT restructure into a different arc. The speaker's build-up is intentional — follow it point by point without skipping ahead or circling back.

NO HEADINGS RULE — ABSOLUTE: Do NOT include any markdown heading (##, ###, #) as a paragraph element. The section heading is already rendered by the book layout. A heading inside the paragraphs array creates a duplicate label mid-chapter. Pure prose paragraphs only.

Return:
- paragraphs: an array of strings where EACH ELEMENT IS ONE PARAGRAPH of polished prose. Every paragraph is a separate array item. Never put more than one paragraph in a single array element. Do not use \n or \n\n inside any element — each element is exactly one paragraph.
- claimLedger: list of major claims and the excerpt numbers (1-based) that support each claim.
- planSequenceIds: for EACH paragraph in the paragraphs array, provide the 0-based index of the paragraph plan step it fulfills. Must be non-decreasing (paragraph N cannot fulfill a plan step earlier than paragraph N-1's step).

Now write the section prose:`;


  const PlanSchema = z.object({
    paragraphPlan: z.array(z.object({
      purpose: z.string().default(""),
      supportedExcerptNumbers: z.array(z.number().int().positive()).default([]),
      // Seq-A1: minimum excerpt number this paragraph draws from (for monotonicity check)
      minExcerptNumber: z.number().int().positive().optional(),
    })).default([]),
  });

  const SectionBodySchema = z.object({
    paragraphs: z.array(z.string()).default([]).describe(
      "Each element is exactly one paragraph of polished prose. Never embed newlines inside an element. Each paragraph is a standalone array item."
    ),
    claimLedger: z.array(z.object({
      claim: z.string().default(""),
      excerptNumbers: z.array(z.number().int().positive()).default([]),
    })).default([]),
    // Seq-A6: for each paragraph, the 0-based plan step index it fulfills
    planSequenceIds: z.array(z.number().int().nonnegative()).default([]),
  });

  return jsonKeepAlive(async () => {
    try {
      const paragraphPlan = assignment.assignedPlan ?? [];
      if (paragraphPlan.length > 0) {
        console.log(`[write-section] Using chapter-level plan (${paragraphPlan.length} entries) for Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
      } else {
        console.log(`[write-section] No paragraph plan — writing from key points + excerpts directly for Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
      }

    // Build a per-request system prompt: Voice DNA at the top (system-level weight),
    // then the dedup prohibition block if any points have already been covered.
    const voiceDnaBlock = assignment.voiceDNA
      ? (() => {
          const dna = assignment.voiceDNA;
          const lines: string[] = [
            "\n\n════════════════════════════════════════════",
            "AUTHOR VOICE DNA — ENFORCE IN EVERY SENTENCE",
            "════════════════════════════════════════════",
            "This is the speaker's unique voice fingerprint. Every sentence you write MUST reflect these patterns.",
            "",
          ];
          if (dna.toneProfile)
            lines.push(`TONE: ${dna.toneProfile}`);
          if (dna.vocabularyLevel)
            lines.push(`VOCABULARY REGISTER: ${dna.vocabularyLevel}`);
          if (dna.sentencePattern)
            lines.push(`SENTENCE RHYTHM: ${dna.sentencePattern}`);
          if (dna.pacingFingerprint)
            lines.push(`PACING: ${dna.pacingFingerprint}`);
          if (dna.emotionalArc)
            lines.push(`EMOTIONAL ARC: ${dna.emotionalArc}`);
          if (dna.openingPattern)
            lines.push(`HOW TO OPEN A NEW POINT: ${dna.openingPattern}`);
          if (dna.closingPattern)
            lines.push(`HOW TO CLOSE A POINT: ${dna.closingPattern}`);
          if (dna.narrativeDevice)
            lines.push(`STORY/ILLUSTRATION STRUCTURE: ${dna.narrativeDevice}`);
          if (dna.teachingStyle)
            lines.push(`TEACHING STYLE: ${dna.teachingStyle}`);
          if ((dna.signaturePhrases ?? []).length > 0)
            lines.push(`\nSIGNATURE PHRASES (use naturally, verbatim):\n${dna.signaturePhrases.map((p) => `  • ${p}`).join("\n")}`);
          if ((dna.preferredTerminology ?? []).length > 0)
            lines.push(`\nPREFERRED TERMINOLOGY (always prefer these terms):\n${dna.preferredTerminology.map((t) => `  • ${t}`).join("\n")}`);
          if ((dna.vernacularMarkers ?? []).length > 0)
            lines.push(`\nVERNACULAR MARKERS (must appear verbatim to authenticate the voice):\n${dna.vernacularMarkers.map((v) => `  • ${v}`).join("\n")}`);
          if ((dna.rhetoricalPatterns ?? []).length > 0)
            lines.push(`\nRHETORICAL PATTERNS (replicate these devices):\n${dna.rhetoricalPatterns.map((r) => `  • ${r}`).join("\n")}`);
          if ((dna.avoidStructures ?? []).length > 0)
            lines.push(`\nFORBIDDEN SENTENCE STRUCTURES (never construct sentences this way):\n${dna.avoidStructures.map((s) => `  • ${s}`).join("\n")}`);
          if ((dna.avoidWords ?? []).length > 0)
            lines.push(`\nFORBIDDEN WORDS & PHRASES (zero tolerance — not one instance):\n${dna.avoidWords.map((w) => `  • ${w}`).join("\n")}`);
          return lines.join("\n");
        })()
      : "";

    // Consolidated deduplication system (replaces 4 separate blocks)
    const isAbsoluteFirstSection = (assignment.chapterNumber === 1 && sectionIdx === 0);
    const coverageLedger = assignment.coverageLedger ?? [];
    const bannedRecaps = assignment.bannedRecaps ?? [];
    const overusedPhrases = assignment.overusedPhrases ?? [];
    const alreadyCovered = assignment.alreadyCoveredPoints ?? [];
    
    const hasPriorContent = coverageLedger.length > 0 || bannedRecaps.length > 0 || alreadyCovered.length > 0;
    const dedupBlock = hasPriorContent
      ? `\n\n═══ PRIOR CONTENT EXCLUSIONS ═══
FIRST-USE OWNERSHIP: The first section to introduce a concept OWNS it. Later sections reference—never re-develop.

${coverageLedger.length > 0 ? `SECTIONS WRITTEN:\n${coverageLedger.map((e) => `• [${e.heading}]: ${e.summary.slice(0, 180)}`).slice(0, 12).join("\n")}\n` : ""}${bannedRecaps.length > 0 ? `BANNED RECAPS:\n${bannedRecaps.slice(0, 15).map((s) => `• "${s.slice(0, 90)}"`).join("\n")}\n` : ""}${alreadyCovered.length > 0 ? `HARD SKIP:\n${alreadyCovered.slice(0, 12).map((p) => `• ${p.slice(0, 100)}`).join("\n")}\n` : ""}${overusedPhrases.length > 0 ? `OVERUSED: ${overusedPhrases.slice(0, 8).map((p) => `"${p}"`).join(", ")}\n` : ""}
SCRIPTURE EXCEPTION: Skip rule NEVER applies to Bible verses. Include every scripture from THIS section's excerpts.
${isAbsoluteFirstSection ? "" : "\nTRANSITIONAL OPENING: Open with \"Having seen…\", \"Building on…\", \"Since we established…\""}`
      : "";

    const deduplicatedSystem = `${EDITORIAL_SYSTEM}${PROSE_MASTERY_RULES}${voiceDnaBlock}${authorConfigBlock}${readabilityBlock}${coreThesisBlock}${usedIllustrationsBlock}${primaryTranslationBlock}${alreadyQuotedBlock}${dedupBlock}`;

    const { object } = await withRetries(() => generateObject({
      model: deepSeekModel,
      schema: SectionBodySchema,
      mode: "json",
      temperature: 0.35,
      system: deduplicatedSystem,
      prompt: paragraphPlan.length > 0
        ? `${prompt}\n\nPARAGRAPH PLAN (must follow in order):\n${JSON.stringify(paragraphPlan)}`
        : prompt,
    }));
    const rawParagraphs = (object.paragraphs ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
      // Strip any markdown heading lines the LLM adds despite the ban
      .filter((p) => !(/^#{1,6}\s/.test(p)));
    const { paragraphs: repairedParagraphs, orphansFixed } = repairOrphanParagraphs(rawParagraphs);
    if (orphansFixed > 0) {
      console.log(`[write-section] S5: merged ${orphansFixed} orphan paragraph(s) in Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
    }

    // ── Seq-A6: Plan sequence contract check ─────────────────────────────
    // The writer declares which plan step each paragraph fulfills via
    // planSequenceIds. Verify the array is non-decreasing; log any inversions.
    let sequenceBreakCount = 0;
    const planSeqIds = object.planSequenceIds ?? [];
    for (let i = 1; i < planSeqIds.length; i++) {
      if (planSeqIds[i] < planSeqIds[i - 1]) {
        sequenceBreakCount++;
        console.warn(`[write-section] Seq-A6 plan break: paragraph ${i + 1} fulfills plan step ${planSeqIds[i]} before step ${planSeqIds[i - 1]} in Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
      }
    }

    // ── Seq-A2: Sentence-level sequence watermark + auto-reorder ────────────
    // Map each paragraph to its best-matching excerpt by 4-gram overlap and
    // verify the indices advance monotonically. When inversions are found,
    // reorder the paragraphs so the output always follows the speaker's sequence.
    let lastExcerptIdx = -1;
    for (let pi = 0; pi < repairedParagraphs.length; pi++) {
      const para = repairedParagraphs[pi];
      if (para.split(/\s+/).length < 15) continue;
      let bestMatch = -1;
      let bestScore = 0;
      for (let ei = 0; ei < effectiveExcerpts.length; ei++) {
        const score = excerptOverlapScore(para, effectiveExcerpts[ei]);
        if (score > bestScore) { bestScore = score; bestMatch = ei; }
      }
      if (bestMatch >= 0 && bestScore > 0.08) {
        if (bestMatch < lastExcerptIdx) {
          sequenceBreakCount++;
          console.warn(`[write-section] Seq-A2 watermark break: paragraph ${pi + 1} matches excerpt ${bestMatch + 1} but excerpt ${lastExcerptIdx + 1} was already used in Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
        }
        lastExcerptIdx = Math.max(lastExcerptIdx, bestMatch);
      }
    }

    // ── Seq-A2 correction: if any inversions were detected, stable-sort the
    // paragraphs back into the speaker's transcript order before joining them.
    let finalParagraphs = repairedParagraphs;
    if (sequenceBreakCount > 0) {
      const { paragraphs: reordered, reorderedCount } = reorderParagraphsByExcerptSequence(
        repairedParagraphs,
        effectiveExcerpts
      );
      if (reorderedCount > 0) {
        finalParagraphs = reordered;
        console.log(`[write-section] Seq-A2 corrected: reordered ${reorderedCount} paragraph(s) back into transcript sequence in Ch${assignment.chapterNumber} §${assignment.sectionNumber}`);
      }
    }

    let rawBody = finalParagraphs.join("\n\n") || await fallbackSectionBody(assignment);
    
    // ── NOTEBOOK-LM INTELLIGENCE: Theologian Fidelity Pass ───────────────────────
    console.log(`[write-section] NotebookLM: Running Theologian Fidelity Check for Ch${assignment.chapterNumber} §${assignment.sectionNumber}...`);
    try {
      const { object: fidelityReport } = await generateObject({
        model: deepSeekModel,
        schema: z.object({
          isFaithful: z.boolean(),
          hallucinations: z.array(z.string()).describe("Specific facts, claims, or theology NOT in the transcript"),
          fixesRequired: z.string().optional()
        }),
        system: "You are the Fidelity Checker. Compare the Draft to the Source Transcript. If the draft invents ANY historical fact, illustration, or theological claim NOT in the transcript, set isFaithful=false and list the hallucinations.",
        prompt: `SOURCE TRANSCRIPT EXCERPTS:\n${effectiveExcerpts.join("\n")}\n\n---\n\nDRAFT:\n${rawBody}`,
        temperature: 0.1,
      });

      if (!fidelityReport.isFaithful && fidelityReport.fixesRequired) {
        console.log(`[write-section] ⛔ Hallucinations detected:`, fidelityReport.hallucinations);
        const { text: repairedText } = await generateText({
           model: deepSeekModel,
           system: "You are the Fidelity Fixer. Rewrite the draft to strict source fidelity by removing the following hallucinations. Do NOT add new information. Rely only on the source.",
           prompt: `Hallucinations to remove: ${fidelityReport.fixesRequired}\n\nDraft:\n${rawBody}\n\nSource Excerpts:\n${effectiveExcerpts.join("\n")}`
        });
        rawBody = repairedText;
      }
    } catch (err) {
      console.warn("[write-section] Theologian check failed, proceeding with draft.", err);
    }

    // ── NOTEBOOK-LM INTELLIGENCE: NYT Bestseller Line Editor Pass ────────────────
    console.log(`[write-section] NotebookLM: Running NYT Line Editor Polish for Ch${assignment.chapterNumber} §${assignment.sectionNumber}...`);
    try {
      const { text: polishedBody } = await generateText({
         model: deepSeekModel,
         system: `You are an elite NYT-Bestseller line editor. Enhance vocabulary, rhythm, and emotional resonance. Apply these rules strictly:\n\n${PREMIUM_BOOK_STYLE_RULES}\n\nDO NOT add any facts. ONLY edit prose.`,
         prompt: `Polish this draft. Ensure it flows beautifully:\n\n${rawBody}`,
         temperature: 0.4
      });
      if (polishedBody.trim().length > 100) {
         rawBody = polishedBody.trim().replace(/^#{1,6}\s.*$/gm, "").trim();
      }
    } catch (err) {
      console.warn("[write-section] Line Editor polish failed, proceeding with base draft.", err);
    }

    const body = stripAudienceLanguage(normalizeReaderFacingProse(rawBody));
    
    // ── Upgrade 8: Passive voice detection ───────────────────────────────
    const passiveHits = detectPassiveVoice(body);
    if (passiveHits.length > 0) {
      console.warn(`[write-section] Passive voice: ${passiveHits.length} hit(s) in Ch${assignment.chapterNumber} §${assignment.sectionNumber}:`, passiveHits.slice(0, 3));
    }
    // ── Upgrade 12: False promise detector ───────────────────────────────
    const openingHook = extractOpeningHook(body);
    let unfullfilledHook: string | null = null;
    if (openingHook && !hookFulfilled(openingHook, body)) {
      unfullfilledHook = openingHook;
      console.warn(`[write-section] Unfulfilled hook in Ch${assignment.chapterNumber} §${assignment.sectionNumber}: "${openingHook.slice(0, 80)}"`);
    }
      return {
        body,
        claimLedger: object.claimLedger ?? [],
        passiveVoiceCount: passiveHits.length,
        unfullfilledHook,
        sequenceBreakCount,
      };
    } catch (err) {
      const fallbackBody = stripAudienceLanguage(normalizeReaderFacingProse(await fallbackSectionBody(assignment)));
      return {
        body: fallbackBody,
        claimLedger: [],
        fallback: true,
        error: err instanceof Error && err.message.trim() ? err.message : "Section write used transcript fallback",
        details: err instanceof Error && err.stack
          ? err.stack.split("\n").slice(0, 3).join(" | ")
          : undefined,
      };
    }
  });
}
