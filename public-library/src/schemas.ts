import { z } from "zod";

const CoverAccentSchema = z.enum(["amber", "cyan", "emerald", "rose", "violet", "slate"]);

const PublishedBookEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string(),
  subtitle: z.string(),
  authorName: z.string(),
  publishedAt: z.string(),
  updatedAt: z.string(),
  wordCount: z.number(),
  chapterCount: z.number(),
  synopsis: z.string(),
  coverAccent: CoverAccentSchema,
  template: z.string(),
  coverImageUrl: z.string().url().nullable().optional(),
  authorImageUrl: z.string().url().nullable().optional(),
}).strict();

export const PublishedCatalogSchema = z.object({
  updatedAt: z.string(),
  books: z.array(PublishedBookEntrySchema),
}).strict();

export const ReaderManifestSchema = z.object({
  bookTitle: z.string(),
  subtitle: z.string(),
  authorName: z.string(),
  totalWordCount: z.number(),
  coverImageUrl: z.string().url().nullable().optional(),
  frontMatter: z.object({
    introduction: z.string(),
    conclusion: z.string(),
  }).strict(),
  chapters: z.array(z.object({
    number: z.number(),
    title: z.string(),
    intro: z.string(),
    epigraph: z.string(),
    sections: z.array(z.object({
      heading: z.string(),
      body: z.string(),
    }).strict()),
  }).strict()),
}).strict();

export const LibraryConfigSchema = z.object({
  r2PublicUrl: z.string().url(),
}).strict();

const UnknownRecordSchema = z.record(z.string(), z.unknown());

function readRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`The published ${label} has an invalid format.`);
  return parsed.data;
}

export function projectReaderManifest(value: unknown): z.infer<typeof ReaderManifestSchema> {
  const source = readRecord(value, "book manifest");
  const frontMatter = readRecord(source.frontMatter, "book front matter");
  if (!Array.isArray(source.chapters)) throw new Error("The published book chapters have an invalid format.");

  const chapters = source.chapters.map((chapterValue) => {
    const chapter = readRecord(chapterValue, "chapter");
    if (!Array.isArray(chapter.sections)) throw new Error("The published chapter sections have an invalid format.");
    return {
      number: chapter.number,
      title: chapter.title,
      intro: chapter.intro,
      epigraph: chapter.epigraph,
      sections: chapter.sections.map((sectionValue) => {
        const section = readRecord(sectionValue, "chapter section");
        return { heading: section.heading, body: section.body };
      }),
    };
  });

  return ReaderManifestSchema.parse({
    bookTitle: source.bookTitle,
    subtitle: source.subtitle,
    authorName: source.authorName,
    totalWordCount: source.totalWordCount,
    coverImageUrl: source.coverImageUrl,
    frontMatter: {
      introduction: frontMatter.introduction,
      conclusion: frontMatter.conclusion,
    },
    chapters,
  });
}

declare global {
  interface Window {
    PUBLIC_LIBRARY_CONFIG?: unknown;
  }
}