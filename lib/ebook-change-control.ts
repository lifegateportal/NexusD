import { z } from "zod";
import { EbookManifestSchema } from "@/lib/schemas/ebook";
import type { EbookManifest } from "@/lib/schemas/ebook";

export type EbookChangeCategory =
  | "metadata"
  | "front-matter"
  | "chapter"
  | "section"
  | "back-matter";

export type EbookChangeEntry = {
  path: string;
  label: string;
  category: EbookChangeCategory;
  before: string;
  after: string;
};

export type EbookUndoSnapshot = {
  timestamp: string;
  instruction: string;
  summary: string;
  manifest: EbookManifest;
};

const UndoSnapshotSchema = z.object({
  timestamp: z.string().datetime(),
  instruction: z.string(),
  summary: z.string(),
  manifest: EbookManifestSchema,
});

const FRONT_MATTER_FIELDS = [
  ["preface", "Preface"],
  ["introduction", "Introduction"],
  ["conclusion", "Conclusion"],
  ["aboutAuthor", "About the Author"],
  ["resourcesList", "Resources"],
  ["scriptureIndex", "Scripture Index"],
] as const;

const CHAPTER_FIELDS = [
  ["title", "Title"],
  ["intro", "Introduction"],
  ["epigraph", "Epigraph"],
  ["forwardQuestion", "Forward Question"],
  ["keyTakeaways", "Key Takeaways"],
  ["reflectionQuestions", "Reflection Questions"],
] as const;

const BACK_MATTER_FIELDS = [
  ["glossary", "Glossary"],
  ["readingGroupGuide", "Reading Group Guide"],
  ["scriptureIndex", "Scripture Index"],
  ["recommendedResources", "Recommended Resources"],
] as const;

type ChapterField = (typeof CHAPTER_FIELDS)[number][0];
type FrontMatterField = (typeof FRONT_MATTER_FIELDS)[number][0];
type BackMatterField = (typeof BACK_MATTER_FIELDS)[number][0];

function valuesEqual(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "—";
}

function structureSignature(manifest: EbookManifest): string {
  return JSON.stringify(
    manifest.chapters.map((chapter) => ({
      number: chapter.number,
      sections: chapter.sections.map((section) => section.sectionNumber),
    }))
  );
}

function getFrontMatterValue(manifest: EbookManifest, field: FrontMatterField): unknown {
  return manifest.frontMatter[field];
}

function getChapterFieldValue(
  manifest: EbookManifest,
  chapterNumber: number,
  field: ChapterField
): unknown {
  const chapter = manifest.chapters.find((candidate) => candidate.number === chapterNumber);
  return chapter?.[field];
}

function getBackMatterValue(manifest: EbookManifest, field: BackMatterField): unknown {
  return manifest.backMatter?.[field];
}

function getSectionValue(
  manifest: EbookManifest,
  chapterNumber: number,
  sectionNumber: number
): unknown {
  const chapter = manifest.chapters.find((candidate) => candidate.number === chapterNumber);
  const section = chapter?.sections.find((candidate) => candidate.sectionNumber === sectionNumber);
  return section ? { heading: section.heading, body: section.body } : null;
}

function addEntry(
  entries: EbookChangeEntry[],
  path: string,
  label: string,
  category: EbookChangeCategory,
  before: unknown,
  after: unknown
): void {
  if (valuesEqual(before, after)) return;
  entries.push({
    path,
    label,
    category,
    before: displayValue(before),
    after: displayValue(after),
  });
}

export function buildManifestChangeEntries(
  before: EbookManifest,
  after: EbookManifest
): EbookChangeEntry[] {
  const entries: EbookChangeEntry[] = [];

  addEntry(entries, "bookTitle", "Book Title", "metadata", before.bookTitle, after.bookTitle);
  addEntry(entries, "subtitle", "Subtitle", "metadata", before.subtitle, after.subtitle);
  addEntry(entries, "authorName", "Author Name", "metadata", before.authorName, after.authorName);

  for (const [field, label] of FRONT_MATTER_FIELDS) {
    addEntry(
      entries,
      `frontMatter:${field}`,
      `Front Matter · ${label}`,
      "front-matter",
      getFrontMatterValue(before, field),
      getFrontMatterValue(after, field)
    );
  }

  for (const [field, label] of BACK_MATTER_FIELDS) {
    addEntry(
      entries,
      `backMatter:${field}`,
      `Back Matter · ${label}`,
      "back-matter",
      getBackMatterValue(before, field),
      getBackMatterValue(after, field)
    );
  }

  if (structureSignature(before) !== structureSignature(after)) {
    addEntry(
      entries,
      "chapters:structure",
      "Chapters & Sections",
      "chapter",
      before.chapters.map((chapter) => `${chapter.number}: ${chapter.title} (${chapter.sections.length} sections)`),
      after.chapters.map((chapter) => `${chapter.number}: ${chapter.title} (${chapter.sections.length} sections)`)
    );
    return entries;
  }

  const chapterNumbers = new Set([
    ...before.chapters.map((chapter) => chapter.number),
    ...after.chapters.map((chapter) => chapter.number),
  ]);

  for (const chapterNumber of chapterNumbers) {
    for (const [field, label] of CHAPTER_FIELDS) {
      addEntry(
        entries,
        `chapter:${chapterNumber}:${field}`,
        `Chapter ${chapterNumber} · ${label}`,
        "chapter",
        getChapterFieldValue(before, chapterNumber, field),
        getChapterFieldValue(after, chapterNumber, field)
      );
    }

    const beforeChapter = before.chapters.find((chapter) => chapter.number === chapterNumber);
    const afterChapter = after.chapters.find((chapter) => chapter.number === chapterNumber);
    const sectionNumbers = new Set([
      ...(beforeChapter?.sections ?? []).map((section) => section.sectionNumber),
      ...(afterChapter?.sections ?? []).map((section) => section.sectionNumber),
    ]);

    for (const sectionNumber of sectionNumbers) {
      addEntry(
        entries,
        `section:${chapterNumber}:${sectionNumber}`,
        `Chapter ${chapterNumber} · Section ${chapterNumber}.${sectionNumber}`,
        "section",
        getSectionValue(before, chapterNumber, sectionNumber),
        getSectionValue(after, chapterNumber, sectionNumber)
      );
    }
  }

  return entries;
}

function findChapterIndex(manifest: EbookManifest, chapterNumber: number): number {
  return manifest.chapters.findIndex((chapter) => chapter.number === chapterNumber);
}

function setSelectedChange(
  result: EbookManifest,
  proposed: EbookManifest,
  path: string
): void {
  if (path === "chapters:structure") {
    result.chapters = proposed.chapters;
    return;
  }

  if (path === "bookTitle" || path === "subtitle" || path === "authorName") {
    result[path] = proposed[path];
    return;
  }

  const [scope, first, second] = path.split(":");
  if (scope === "frontMatter" && first) {
    const field = first as FrontMatterField;
    result.frontMatter = { ...result.frontMatter, [field]: proposed.frontMatter[field] };
    return;
  }

  if (scope === "backMatter" && first) {
    const field = first as BackMatterField;
    const proposedBackMatter = proposed.backMatter;
    if (!proposedBackMatter) {
      result.backMatter = null;
      return;
    }
    result.backMatter = {
      ...(result.backMatter ?? {
        scriptureIndex: [],
        glossary: [],
        readingGroupGuide: [],
        recommendedResources: [],
      }),
      [field]: proposedBackMatter[field],
    };
    return;
  }

  const chapterNumber = Number(first);
  const chapterIndex = findChapterIndex(result, chapterNumber);
  const proposedChapter = proposed.chapters.find((chapter) => chapter.number === chapterNumber);
  if (chapterIndex < 0 || !proposedChapter) return;

  if (scope === "chapter" && second) {
    const field = second as ChapterField;
    result.chapters[chapterIndex] = {
      ...result.chapters[chapterIndex],
      [field]: proposedChapter[field],
    };
    return;
  }

  if (scope === "section" && second) {
    const sectionNumber = Number(second);
    const sectionIndex = result.chapters[chapterIndex].sections.findIndex(
      (section) => section.sectionNumber === sectionNumber
    );
    const proposedSection = proposedChapter.sections.find(
      (section) => section.sectionNumber === sectionNumber
    );
    if (sectionIndex < 0 || !proposedSection) return;
    result.chapters[chapterIndex] = {
      ...result.chapters[chapterIndex],
      sections: result.chapters[chapterIndex].sections.map((section, index) =>
        index === sectionIndex ? proposedSection : section
      ),
    };
  }
}

export function applySelectedManifestChanges(
  before: EbookManifest,
  proposed: EbookManifest,
  selectedPaths: string[]
): EbookManifest {
  const result = structuredClone(before);
  for (const path of selectedPaths) {
    setSelectedChange(result, proposed, path);
  }
  return result;
}

function undoStorageKey(jobId: string): string {
  return `nexus_ebook_undo_${jobId}`;
}

export function saveEbookUndoSnapshot(
  jobId: string,
  snapshot: EbookUndoSnapshot
): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(undoStorageKey(jobId), JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function loadEbookUndoSnapshot(jobId: string): EbookUndoSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(undoStorageKey(jobId));
    if (!raw) return null;
    const parsed = UndoSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearEbookUndoSnapshot(jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(undoStorageKey(jobId));
  } catch {
    // Storage cleanup is best effort; the in-memory editor remains usable.
  }
}
