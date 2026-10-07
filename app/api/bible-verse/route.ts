import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isBlockedScriptureProviderResponse, stripScriptureMetadata } from "@/lib/scripture-verse";

export const runtime = "nodejs";
export const maxDuration = 15;

const BIBLE_API_TRANSLATIONS = ["web", "kjv", "asv", "ylt"] as const;
const BOLLS_TRANSLATIONS = ["niv", "nlt", "nkjv", "amp", "msg"] as const;
const ALL_TRANSLATIONS = [...BIBLE_API_TRANSLATIONS, ...BOLLS_TRANSLATIONS] as const;

const BOLLS_CODE: Record<(typeof BOLLS_TRANSLATIONS)[number], string> = {
  niv: "NIV",
  nlt: "NLT",
  nkjv: "NKJV",
  amp: "AMP",
  msg: "MSG",
};

function stripHtml(s: string): string {
  return stripScriptureMetadata(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

const BOOK_IDS: Record<string, number> = {
  genesis:1,exodus:2,leviticus:3,numbers:4,deuteronomy:5,
  joshua:6,judges:7,ruth:8,"1 samuel":9,"2 samuel":10,
  "1 kings":11,"2 kings":12,"1 chronicles":13,"2 chronicles":14,
  ezra:15,nehemiah:16,esther:17,job:18,
  psalms:19,psalm:19,proverbs:20,ecclesiastes:21,
  "song of solomon":22,"song of songs":22,
  isaiah:23,jeremiah:24,lamentations:25,ezekiel:26,
  daniel:27,hosea:28,joel:29,amos:30,obadiah:31,
  jonah:32,micah:33,nahum:34,habakkuk:35,zephaniah:36,
  haggai:37,zechariah:38,malachi:39,
  matthew:40,mark:41,luke:42,john:43,acts:44,romans:45,
  "1 corinthians":46,"2 corinthians":47,
  galatians:48,ephesians:49,philippians:50,colossians:51,
  "1 thessalonians":52,"2 thessalonians":53,
  "1 timothy":54,"2 timothy":55,
  titus:56,philemon:57,hebrews:58,james:59,
  "1 peter":60,"2 peter":61,
  "1 john":62,"2 john":63,"3 john":64,
  jude:65,revelation:66,
};

const RequestSchema = z.object({
  reference: z.string().min(2).max(140),
  translation: z.enum(ALL_TRANSLATIONS).default("web"),
  returnVerses: z.boolean().default(false),
});

type BibleApiVerse = { book_name: string; chapter: number; verse: number; text: string };
type BibleApiResponse = { reference?: string; text?: string; error?: string; verses?: BibleApiVerse[] };
type VerseLookupResult = {
  reference: string;
  text: string;
  verses?: Array<{ ref: string; text: string }>;
};
type ProviderUnavailableResult = { providerUnavailable: true };

function parseRef(reference: string) {
  const m = reference.trim().match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = parseInt(m[3]);
  return { book: m[1].trim(), chapter: parseInt(m[2]), start, end: m[4] ? parseInt(m[4]) : start };
}

async function fetchFromBolls(
  reference: string,
  translation: (typeof BOLLS_TRANSLATIONS)[number],
  returnVerses: boolean,
): Promise<VerseLookupResult | ProviderUnavailableResult | null> {
  const parsed = parseRef(reference);
  if (!parsed) return null;
  const bookId = BOOK_IDS[parsed.book.toLowerCase()];
  if (!bookId) return null;
  const code = BOLLS_CODE[translation];
  const url = `https://bolls.life/get-text/${code}/${bookId}/${parsed.chapter}/`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
  if (!res.ok) return null;
  const data = await res.json() as Array<{ verse: number; text: string }>;
  const filtered = data.filter((v) => v.verse >= parsed.start && v.verse <= parsed.end);
  if (filtered.length === 0) return null;
  const makeRef = (v: number) => `${parsed.book} ${parsed.chapter}:${v}`;
  const verses = filtered.map((v) => ({ ref: makeRef(v.verse), text: stripHtml(v.text.replace(/\n+/g, " ")) }));
  if (verses.some((verse) => isBlockedScriptureProviderResponse(verse.text))) {
    return { providerUnavailable: true };
  }
  if (returnVerses && filtered.length > 1) {
    return { reference: `${parsed.book} ${parsed.chapter}:${parsed.start}-${parsed.end}`, text: verses.map((v) => v.text).join(" "), verses };
  }
  return { reference: makeRef(parsed.start), text: verses.map((v) => v.text).join(" ") };
}

export async function POST(req: NextRequest) {
  let input: z.infer<typeof RequestSchema>;
  try {
    input = RequestSchema.parse(await req.json() as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    if ((BOLLS_TRANSLATIONS as readonly string[]).includes(input.translation)) {
      const result = await fetchFromBolls(
        input.reference,
        input.translation as (typeof BOLLS_TRANSLATIONS)[number],
        input.returnVerses,
      );
      if (result && "providerUnavailable" in result && result.providerUnavailable) {
        return NextResponse.json({ error: "The requested translation was not returned by the configured provider." }, { status: 503 });
      }
      if (result) return NextResponse.json(result);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const encoded = encodeURIComponent(input.reference.replace(/\s+/g, "+"));
    const url = `https://bible-api.com/${encoded}?translation=${input.translation}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
    if (!res.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const data = await res.json() as BibleApiResponse;
    if (data.error || !data.text) return NextResponse.json({ error: data.error ?? "No text returned" }, { status: 404 });
    const text = data.text.replace(/\n+/g, " ").trim();
    if (isBlockedScriptureProviderResponse(text)) {
      return NextResponse.json({ error: "The requested translation was not returned by the configured provider." }, { status: 503 });
    }

    if (input.returnVerses && data.verses && data.verses.length > 0) {
      const verses = data.verses.map((v) => ({
        ref: `${v.book_name} ${v.chapter}:${v.verse}`,
        text: v.text.replace(/\n+/g, " ").trim(),
      }));
      if (verses.some((verse) => isBlockedScriptureProviderResponse(verse.text))) {
        return NextResponse.json({ error: "The requested translation was not returned by the configured provider." }, { status: 503 });
      }
      return NextResponse.json({ reference: data.reference ?? input.reference, verses });
    }
    return NextResponse.json({ reference: data.reference ?? input.reference, text });
  } catch {
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }
}
