import type { BackMatter, Quote } from "@/lib/schemas/ebook";

type ChapterForScriptureIndex = {
  number: number;
  content?: string;
  sections?: Array<{ body?: string }>;
};

export function buildEbookScriptureIndex(
  chapters: ChapterForScriptureIndex[],
  allQuotes: Quote[] = [],
): BackMatter["scriptureIndex"] {
  const refMap = new Map<string, { translation: string; chapters: Set<number> }>();

  const addRef = (reference: string, translation: string, chapterNumber: number) => {
    if (!reference?.trim()) return;
    const normalizedTranslation = translation?.trim() || "translation unspecified";
    const key = `${reference.trim()} (${normalizedTranslation})`;
    if (!refMap.has(key)) refMap.set(key, { translation: normalizedTranslation, chapters: new Set() });
    refMap.get(key)!.chapters.add(chapterNumber);
  };

  for (const quote of allQuotes) {
    if (quote.type === "scripture") addRef(quote.reference, quote.translation, 0);
  }

  for (const chapter of chapters) {
    const bodies = chapter.sections?.map((section) => section.body ?? "")
      ?? [chapter.content ?? ""];
    for (const body of bodies) {
      const refPattern = /\b([1-3]?\s?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+\d+:\d+(?:[\u2013-]\d+)?)\)?\s*\(?\s*(NIV|ESV|KJV|NKJV|NASB|NLT|CSB|NRSV|RSV|AMP|MSG|CEV|GNT|NET|HCSB)?\s*\)?/g;
      let match: RegExpExecArray | null;
      while ((match = refPattern.exec(body)) !== null) {
        addRef(match[1].trim(), match[2] ?? "translation unspecified", chapter.number);
      }
    }
  }

  return Array.from(refMap.entries())
    .map(([reference, { translation, chapters: chapterNumbers }]) => ({
      reference,
      translation,
      chapters: Array.from(chapterNumbers).sort((left, right) => left - right),
    }))
    .sort((left, right) => left.reference.localeCompare(right.reference));
}
