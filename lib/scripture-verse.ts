import { formatScriptureReference, normalizeScriptureBlockquotes, parseMarkdownBlockquote } from "@/lib/scripture-formatter";

const BIBLE_API_TRANSLATIONS = new Set(["web", "kjv", "asv", "ylt"]);
const BOLLS_TRANSLATIONS = new Set(["niv", "nlt", "nkjv", "amp", "msg"]);
const TRANSLATION_ALIASES: Record<string, string> = {
  "world english bible": "web",
  "new international version": "niv",
  "new living translation": "nlt",
  "new king james version": "nkjv",
  "amplified bible": "amp",
  message: "msg",
};

const BOOK_IDS: Record<string, number> = {
  genesis: 1, exodus: 2, leviticus: 3, numbers: 4, deuteronomy: 5,
  joshua: 6, judges: 7, ruth: 8, "1 samuel": 9, "2 samuel": 10,
  "1 kings": 11, "2 kings": 12, "1 chronicles": 13, "2 chronicles": 14,
  ezra: 15, nehemiah: 16, esther: 17, job: 18, psalms: 19, psalm: 19,
  proverbs: 20, ecclesiastes: 21, "song of solomon": 22, "song of songs": 22,
  isaiah: 23, jeremiah: 24, lamentations: 25, ezekiel: 26, daniel: 27,
  hosea: 28, joel: 29, amos: 30, obadiah: 31, jonah: 32, micah: 33,
  nahum: 34, habakkuk: 35, zephaniah: 36, haggai: 37, zechariah: 38,
  malachi: 39, matthew: 40, mark: 41, luke: 42, john: 43, acts: 44,
  romans: 45, "1 corinthians": 46, "2 corinthians": 47, galatians: 48,
  ephesians: 49, philippians: 50, colossians: 51, "1 thessalonians": 52,
  "2 thessalonians": 53, "1 timothy": 54, "2 timothy": 55, titus: 56,
  philemon: 57, hebrews: 58, james: 59, "1 peter": 60, "2 peter": 61,
  "1 john": 62, "2 john": 63, "3 john": 64, jude: 65, revelation: 66,
};

type CanonicalScripture = {
  reference: string;
  translation: string;
  text: string;
};

type ParsedReference = {
  book: string;
  chapter: number;
  start: number;
  end: number;
};

function normalizeTranslation(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const code = TRANSLATION_ALIASES[normalized] ?? normalized;
  return BIBLE_API_TRANSLATIONS.has(code) || BOLLS_TRANSLATIONS.has(code) ? code : null;
}

function parseReference(reference: string): ParsedReference | null {
  const match = reference.trim().match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+){0,2})\s+(\d+):(\d+)(?:[-–](\d+))?$/);
  if (!match) return null;
  const start = Number(match[3]);
  return {
    book: match[1].trim(),
    chapter: Number(match[2]),
    start,
    end: match[4] ? Number(match[4]) : start,
  };
}

function stripHtml(value: string): string {
  return stripScriptureMetadata(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function stripScriptureMetadata(value: string): string {
  return value
    .replace(/^\s*BOOK\s+[IVXLCDM]+(?:\s+Psalms?\s+\d+(?:[-–]\d+)?)?\s*\.{0,3}\s*/i, "")
    .replace(/^\s*Psalms?\s+\d+\s*/i, "")
    .replace(/^\s*For the director of music\.\s*(?:A\s+(?:maskil|psalm|song|hymn)\b[^.]*\.\s*)?/i, "")
    .trim();
}

function canonicalReference(parsed: ParsedReference): string {
  return `${parsed.book} ${parsed.chapter}:${parsed.start}${parsed.end > parsed.start ? `–${parsed.end}` : ""}`;
}

async function fetchFromBolls(parsed: ParsedReference, translation: string): Promise<CanonicalScripture | null> {
  const bookId = BOOK_IDS[parsed.book.toLowerCase()];
  if (!bookId) return null;
  const response = await fetch(`https://bolls.life/get-text/${translation.toUpperCase()}/${bookId}/${parsed.chapter}/`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const verses = await response.json() as Array<{ verse: number; text: string }>;
  const selected = verses
    .filter((verse) => verse.verse >= parsed.start && verse.verse <= parsed.end)
    .map((verse) => stripHtml(verse.text.replace(/\n+/g, " ")))
    .filter(Boolean);
  if (selected.length === 0) return null;
  return { reference: canonicalReference(parsed), translation: translation.toUpperCase(), text: selected.join(" ") };
}

async function fetchFromBibleApi(reference: string, parsed: ParsedReference, translation: string): Promise<CanonicalScripture | null> {
  const encodedReference = encodeURIComponent(reference.replace(/\s+/g, "+"));
  const response = await fetch(`https://bible-api.com/${encodedReference}?translation=${translation}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const data = await response.json() as { text?: string; error?: string };
  if (data.error || !data.text?.trim()) return null;
  return { reference: canonicalReference(parsed), translation: translation.toUpperCase(), text: stripScriptureMetadata(data.text.replace(/\n+/g, " ").trim()) };
}

export async function fetchCanonicalScripture(reference: string, translation: string): Promise<CanonicalScripture | null> {
  const parsed = parseReference(reference);
  const code = normalizeTranslation(translation);
  if (!parsed || !code) return null;
  try {
    return BOLLS_TRANSLATIONS.has(code)
      ? await fetchFromBolls(parsed, code)
      : await fetchFromBibleApi(reference, parsed, code);
  } catch {
    return null;
  }
}

function comparableText(value: string): string {
  return value
    .replace(/^["“]|["”]$/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function completeScriptureBlockquotes(text: string): Promise<string> {
  const normalized = normalizeScriptureBlockquotes(text);
  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean);
  const completed = await Promise.all(paragraphs.map(async (paragraph) => {
    const quote = parseMarkdownBlockquote(paragraph);
    if (!quote?.reference || !quote.translation || !/\d+:\d+/.test(quote.reference)) return paragraph;
    const cleanedQuoteText = stripScriptureMetadata(quote.text);
    const canonical = await fetchCanonicalScripture(quote.reference, quote.translation);
    if (!canonical) {
      return cleanedQuoteText === quote.text
        ? paragraph
        : `> ${cleanedQuoteText}\n> ${formatScriptureReference(quote.reference, quote.translation)}`;
    }
    if (comparableText(cleanedQuoteText) === comparableText(canonical.text) && cleanedQuoteText === quote.text) return paragraph;
    return `> ${canonical.text}\n> ${formatScriptureReference(canonical.reference, canonical.translation)}`;
  }));
  return completed.join("\n\n");
}