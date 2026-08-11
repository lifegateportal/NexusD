/**
 * scripture-formatter.ts
 * Unified scripture formatting for PDF, EPUB, DOCX, and LLM prompts.
 * 
 * CANONICAL FORMATS (Chicago Manual + Premium Print Standard):
 * 
 * 1. SHORT INLINE (under 40 words, woven into sentence):
 *    *"verse text"* (Book Chapter:Verse Translation)
 *    Example: Paul writes *"I can do all things through Christ who strengthens me"* (Philippians 4:13 NIV).
 * 
 * 2. SHORT STANDALONE (under 40 words, quoted as own statement):
 *    > Verse text here.
 *    > — Book Chapter:Verse (Translation)
 * 
 * 3. LONG BLOCK (40+ words — mandatory blockquote, no quotation marks):
 *    > Verse text here, continuing across
 *    > multiple lines as needed.
 *    > — Book Chapter:Verse (Translation)
 * 
 * CRITICAL RULES:
 * - Reference ALWAYS ends with translation in parentheses: (NIV), (KJV), (ESV)
 * - Reference ALWAYS preceded by em-dash: \u2014 or — in markdown
 * - Block quotes NEVER use quotation marks around the verse text
 * - Block quotes ALWAYS have reference on separate line
 * - Inline quotes ALWAYS have reference immediately after closing quote, same line
 */

export type ScriptureQuote = {
  text: string;
  reference?: string;
  translation?: string;
};

const BIBLE_BOOK_PATTERN = /\b(?:[1-3]\s+)?(?:genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs?|ecclesiastes|song of solomon|song of songs|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d+:\d+/i;

/**
 * Parse a markdown blockquote paragraph (lines starting with '> ') into
 * a normalized ScriptureQuote object. Returns null if not a blockquote.
 */
export function parseMarkdownBlockquote(paragraph: string): ScriptureQuote | null {
  if (!paragraph.startsWith("> ") && !paragraph.startsWith(">")) return null;
  
  // Strip ALL leading '>' levels — handles nested '> > text' and LLM '> > ref' formats
  const lines = paragraph.split("\n")
    .map((l) => l.replace(/^(>\s*)+/, "").trim())
    .filter(Boolean);
  
  if (lines.length === 0) return null;

  // Reference detection: em-dash prefix OR a bare scripture citation (Book Chapter:Verse)
  const refPattern = /^[\u2014\-\u2013]|^\*[\u2014\-\u2013]|^(?:[1-9]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+/;
  let refLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (refPattern.test(lines[i].trim())) { 
      refLineIdx = i; 
      break; 
    }
  }

  // Handle inline ">.  BookName chapter:verse" separators embedded at the end of a verse line
  let verseLines = refLineIdx > 0 ? lines.slice(0, refLineIdx) : lines;
  let inlineRef = "";
  
  if (refLineIdx < 0 && verseLines.length > 0) {
    const lastLine = verseLines[verseLines.length - 1];
    const inlineMatch = lastLine.match(
      /^(.*?)\s*>\.?\s+((?:[1-9]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:[:\u2013\-]\d+)?\s*(?:\([^)]*\))?)\s*$/
    );
    if (inlineMatch && inlineMatch[1].trim()) {
      verseLines = [...verseLines.slice(0, -1), inlineMatch[1].trim()];
      inlineRef = inlineMatch[2].trim();
    } else {
      // Handle citations glued directly onto the verse text with no ">" marker at all,
      // e.g. LLM output: "...triumphing over them by the cross.. Colossians 2:13-15 (NIV)"
      // Requires the parenthetical translation so ordinary prose ("at 3:16 pm") never matches.
      const bareMatch = lastLine.match(
        /^(.*?[.!?])\.?\s+((?:[1-9]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:[\u2013-]\d+)?\s*\([^)]+\))\s*$/
      );
      if (bareMatch && bareMatch[1].trim()) {
        verseLines = [...verseLines.slice(0, -1), bareMatch[1].trim()];
        inlineRef = bareMatch[2].trim();
      }
    }
  }

  // Strip any remaining stray ">" symbols from the verse text itself
  const cleanedVerseLines = verseLines.map((line) => 
    line.replace(/>\s+/g, " ").replace(/>\./g, "").trim()
  );

  const refRaw = inlineRef || (refLineIdx >= 0 ? lines[refLineIdx] : "");
  const refClean = refRaw.replace(/^\*?[\u2014\-\u2013]\s*/, "").replace(/\*$/, "").trim();
  
  // Extract translation from parentheses at end: "John 3:16 (NIV)"
  const transMatch = refClean.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

  return {
    text: cleanedVerseLines.join("\n").trim(),
    reference: transMatch ? transMatch[1].trim() : (refClean || undefined),
    translation: transMatch ? transMatch[2].trim() : undefined,
  };
}

/**
 * Format a scripture reference with translation consistently.
 * Always returns: "— Reference (Translation)" or "— Reference" if no translation.
 */
export function formatScriptureReference(reference: string | undefined, translation: string | undefined): string {
  if (!reference) return "";
  const trans = translation ? ` (${translation})` : "";
  return `\u2014 ${reference}${trans}`;
}

/**
 * Detect if text contains a Bible reference.
 */
export function containsScripture(text: string): boolean {
  return BIBLE_BOOK_PATTERN.test(text);
}

/**
 * Canonical prompt text for scripture formatting rules.
 * SINGLE SOURCE OF TRUTH — every route that generates or rewrites scripture
 * content must import this exact constant. Never re-type a local copy;
 * copies drift (comma placement, translation fallback wording, dash style)
 * and produce inconsistent citations across the manuscript.
 */
export const SCRIPTURE_FORMATTING_RULES = `═══ SCRIPTURE FORMATTING — PRODUCTION-GRADE CITATION STANDARD (Chicago Manual of Style + SBL citation conventions + Premium Print) ═══

FORMAT BY LENGTH:
SHORT INLINE (under 40 words, woven into sentence):
*"verse text"* (Book Chapter:Verse Translation)
Example: Paul writes *"I can do all things through Christ who strengthens me"* (Philippians 4:13 NIV).

SHORT STANDALONE (under 40 words, quoted as its own statement):
> Verse text here.
> — Book Chapter:Verse (Translation)

LONG BLOCK (40+ words — mandatory blockquote, no quotation marks):
> Verse text here, continuing across
> multiple lines as needed.
> — Book Chapter:Verse (Translation)

REFERENCE FORMATTING (apply exactly, no variation):
• No comma between verse and translation: "(John 3:16 NIV)" — never "(John 3:16, NIV)".
• Chapter and verse separated by a colon, never a period: "John 3:16", not "John 3.16".
• Verse ranges use an en dash, never a hyphen: "John 3:16–17", not "John 3:16-17".
• Cross-chapter ranges: "Romans 8:35–9:1".
• Numbered books use the Arabic numeral with no period: "1 Corinthians 13:4", "2 Timothy 3:16" — never "First Corinthians 13:4" or "II Timothy 3:16" in a citation (the numeral may still be spelled out in surrounding prose).
• One citation covers one contiguous passage. Do not stack non-contiguous verses into a single comma-separated reference; if two separate verses are both needed, cite each with its own complete reference.
• The em dash before a scripture reference line ("— Book Chapter:Verse") is the ONLY sanctioned use of an em dash anywhere in this manuscript. It never appears in prose sentences.

TRANSLATION ABBREVIATION — REQUIRED AND RESOLVED, NEVER A PLACEHOLDER:
• Every quoted verse carries a real, standard translation abbreviation in parentheses: NIV, ESV, KJV, NKJV, NASB, NLT, CSB, NRSV, RSV, AMP, MSG, CEV, GNT, NET, or HCSB. Never invent an abbreviation.
• If the speaker stated the translation, use exactly that one.
• If the speaker did not state a translation, use the book's designated primary translation for that quote. NEVER print a placeholder such as "(translation unspecified)" into finished prose — that string must never reach a reader.
• When a book uses more than one translation, state the abbreviation on every quotation, every time. Do not rely on an implied "default" once a second translation has appeared anywhere in the book.

VERBATIM ACCURACY — ABSOLUTE:
• Reproduce scripture EXACTLY as quoted in the source: exact wording, exact punctuation, exact capitalization. Never paraphrase, modernize, silently correct, or smooth a verse's wording.
• If the source omits words mid-verse, mark the omission with a spaced ellipsis: " . . . " (three spaced periods; four when the omission follows a sentence-ending period). Never use an unspaced "...".
• Use curly quotation marks only ("..." not straight "..."), with single curly quotes for a quotation nested inside the verse text ('...').

PLACEMENT AND SEQUENCING:
• When a central passage anchors the section, place it as a standalone block near the opening, before explanatory prose.
• No post-quote restatement. The sentence after scripture must advance, apply, or land an implication, not echo what the verse just said.
• Include original Greek or Hebrew terms exactly as stated in the source: the Greek word *transliteration*, meaning "definition."
• Quote each scripture in full ONCE per section. Every subsequent reference to that same passage uses shorthand only: "As Jesus said in John 15:5..." — never reprint the verse text again.
• Never add biblical background (historical setting, authorial intent, cultural or manuscript context) unless the source explicitly stated it.
• Every scripture must complete TEXT → TRUTH → APPLICATION within 2–3 paragraphs of the quotation.`;
