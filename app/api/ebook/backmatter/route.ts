import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { deepSeekReasonerModel, deepSeekModel } from "@/lib/ai-providers";
import { EbookManifestSchema, BackMatterSchema } from "@/lib/schemas/ebook";
import type { BackMatter } from "@/lib/schemas/ebook";
import { SOURCE_LOCK_RULES, READER_NORMALIZATION_RULES, PREMIUM_BOOK_STYLE_RULES } from "@/lib/editorial-style-bible";

export const runtime = "nodejs";
export const maxDuration = 300;

// ─── Request ──────────────────────────────────────────────────────────────────

const BackMatterRequestSchema = z.object({
  manifest: EbookManifestSchema,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScriptureIndex(manifest: z.infer<typeof EbookManifestSchema>): BackMatter["scriptureIndex"] {
  // Collect all quotes from manifest.allQuotes and chapter sections
  const refMap = new Map<string, { translation: string; chapters: Set<number> }>();

  const addRef = (reference: string, translation: string, chapterNumber: number) => {
    if (!reference?.trim()) return;
    const key = `${reference.trim()} (${translation?.trim() || "translation unspecified"})`;
    if (!refMap.has(key)) refMap.set(key, { translation: translation?.trim() || "translation unspecified", chapters: new Set() });
    refMap.get(key)!.chapters.add(chapterNumber);
  };

  for (const q of manifest.allQuotes ?? []) {
    if (q.type === "scripture") {
      // Determine chapter from position — use chapter 0 as fallback
      addRef(q.reference, q.translation, 0);
    }
  }

  for (const chapter of manifest.chapters) {
    for (const section of chapter.sections) {
      // Scan section body for scripture references, capturing the translation
      // abbreviation when it appears alongside the reference (inline "(John 3:16 NIV)"
      // or block "— John 3:16 (NIV)"). Only fall back to the placeholder when the
      // body genuinely carries no translation next to that citation.
      const body = section.body ?? "";
      const refPattern = /\b([1-3]?\s?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+\d+:\d+(?:[\u2013-]\d+)?)\)?\s*\(?\s*(NIV|ESV|KJV|NKJV|NASB|NLT|CSB|NRSV|RSV|AMP|MSG|CEV|GNT|NET|HCSB)?\s*\)?/g;
      let m;
      while ((m = refPattern.exec(body)) !== null) {
        addRef(m[1].trim(), m[2] ?? "translation unspecified", chapter.number);
      }
    }
  }

  return Array.from(refMap.entries())
    .map(([reference, { translation, chapters }]) => ({
      reference,
      translation,
      chapters: Array.from(chapters).sort((a, b) => a - b),
    }))
    .sort((a, b) => {
      // Sort by book name, then chapter, then verse (simplified)
      return a.reference.localeCompare(b.reference);
    });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;
  let input;
  try {
    input = BackMatterRequestSchema.parse(body);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid input" }, { status: 400 });
  }

  const { manifest } = input;
  const voiceDNA = manifest.voiceDNA;

  // Build scripture index from the manifest (deterministic, no LLM needed)
  const scriptureIndex = buildScriptureIndex(manifest);

  // Build chapter summaries for the LLM tasks
  const chapterSummaries = manifest.chapters.map((ch) => {
    const keyTakeaways = (ch.keyTakeaways ?? []).slice(0, 4).join("; ");
    const sectionHeadings = ch.sections.map((s) => s.heading).join(", ");
    return `Ch ${ch.number}: "${ch.title}"\n  Takeaways: ${keyTakeaways}\n  Sections: ${sectionHeadings}`;
  }).join("\n\n");

  // Terms to define: prefer Voice DNA preferred terminology, then extract unique vocabulary.
  // Exclude proper nouns — names of people, places, and organizations are not glossary terms.
  const NAME_TITLE_RE = /\b(?:Pastor|Bishop|Prophet|Apostle|Elder|Deacon|Reverend|Rev|Dr|Mr|Mrs|Ms|Prof|Minister|Brother|Sister)\b/i;
  const preferredTerms = (voiceDNA?.preferredTerminology ?? []).slice(0, 15);

  // Collect all section body text
  const allBodyText = manifest.chapters
    .flatMap((ch) => ch.sections)
    .map((s) => s.body ?? "")
    .join(" ");

  // Extract repeated capitalized phrases (2+ words preferred) — then filter name-like candidates
  const phraseFreq = new Map<string, number>();
  for (const match of allBodyText.matchAll(/\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})+)\b/g)) {
    const t = match[1];
    phraseFreq.set(t, (phraseFreq.get(t) ?? 0) + 1);
  }
  // Also pick up single-word domain terms that appear in lowercase mid-sentence (strong signal = concept not name)
  for (const match of allBodyText.matchAll(/(?<![.!?]\s)\b([a-z][a-z]{5,})\b/g)) {
    const t = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    phraseFreq.set(t, (phraseFreq.get(t) ?? 0) + 1);
  }

  const frequentTerms = Array.from(phraseFreq.entries())
    .filter(([t, count]) => {
      if (count < 3) return false;
      // Skip if the term itself looks like a personal name (two title-case words where the second looks like a surname)
      if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(t)) return false;
      // Skip if the term appears near a personal title in the full text
      const escapedTerm = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const contextRe = new RegExp(`${NAME_TITLE_RE.source}\\s+${escapedTerm}|${escapedTerm}\\s+${NAME_TITLE_RE.source}`, "i");
      if (contextRe.test(allBodyText)) return false;
      return true;
    })
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter((t) => !preferredTerms.includes(t))
    .slice(0, 12);

  const termsToDefine = [...new Set([...preferredTerms, ...frequentTerms])].slice(0, 20);

  const resourcesMentioned = (manifest.frontMatter.resourcesList ?? []).slice(0, 15);

  const backmatterSystem = `You are creating back matter for a published teaching book. Your job is three tasks:

TASK 1 — GLOSSARY:
Define the provided key terms EXACTLY as the author uses them in the book. Rules:
- ONLY define concepts, key phrases, doctrinal terms, or domain-specific vocabulary — words that carry specific meaning within this author's teaching framework.
- NEVER define a person's name, a place name, an organization name, or a proper noun that refers to an individual. If a submitted term is a person's name or a place, skip it entirely — do not include it in the glossary.
- Definitions must be 2–3 sentences.
- Drawn ENTIRELY from the book content. No external theological context.
- Use the same vocabulary and register the author uses.
- firstAppearance should name the chapter and section where the term first appears.
- If a term cannot be meaningfully defined as a concept from the book content, omit it.

TASK 2 — READING GROUP GUIDE:
Write 3–7 discussion questions per chapter. Rules:
- Questions must be SPECIFIC to the actual content of that chapter — not generic.
- Each question must name a concrete claim, story, scripture, or example from the chapter.
- Mix question types: some personal application ("When have you…"), some analytical ("How does the author's argument about X connect to Y?"), some action-oriented ("What would it look like to…").
- FORBIDDEN: "What did you learn from this chapter?", "How can you apply this?", "What is the main message?" — these are generic and valueless.

TASK 3 — RECOMMENDED RESOURCES:
List any resources the author specifically mentioned in the book (books, passages, teachings). Do not add resources the author didn't reference. If none were mentioned, return an empty array.

${SOURCE_LOCK_RULES}

${READER_NORMALIZATION_RULES}

${PREMIUM_BOOK_STYLE_RULES}`;

  const backmatterPrompt = `Book: "${manifest.bookTitle}"${manifest.subtitle ? ` — ${manifest.subtitle}` : ""}
Author: ${manifest.authorName}

CHAPTER SUMMARIES:
${chapterSummaries}

TERMS TO DEFINE FOR GLOSSARY:
${termsToDefine.map((t) => `• ${t}`).join("\n")}

RESOURCES MENTIONED IN THE BOOK:
${resourcesMentioned.length > 0 ? resourcesMentioned.map((r) => `• ${r}`).join("\n") : "(none explicitly mentioned)"}

Generate the glossary, reading group guide, and recommended resources.`;

  // Try R1 first for highest quality. If it fails or times out, fall back to V3.
  let object: Awaited<ReturnType<typeof generateObject<z.infer<typeof BackMatterSchema>>>>["object"] | null = null;

  try {
    const res = await generateObject({
      model: deepSeekReasonerModel,
      schema: BackMatterSchema.omit({ scriptureIndex: true }),
      mode: "json",
      temperature: 1,  // R1 requires temperature=1
      system: backmatterSystem,
      prompt: backmatterPrompt,
    });
    object = res.object;
  } catch {
    // R1 failed — fall back to V3 Pro
    try {
      const res = await generateObject({
        model: deepSeekModel,
        schema: BackMatterSchema.omit({ scriptureIndex: true }),
        mode: "json",
        temperature: 0.3,
        system: backmatterSystem,
        prompt: backmatterPrompt,
      });
      object = res.object;
    } catch (v3Err) {
      const message = v3Err instanceof Error ? v3Err.message : "Back matter generation failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (!object) {
    return NextResponse.json({ error: "Back matter generation returned no content" }, { status: 500 });
  }

  const result: BackMatter = {
    scriptureIndex,
    glossary: object.glossary ?? [],
    readingGroupGuide: object.readingGroupGuide ?? [],
    recommendedResources: object.recommendedResources ?? [],
  };

  return NextResponse.json(result, { status: 200 });
}
