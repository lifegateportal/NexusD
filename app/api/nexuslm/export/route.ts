import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EbookManifestSchema, BookTemplateEnum, PrintSpecSchema } from "@/lib/schemas/ebook";
import { generatePdfBuffer } from "@/lib/ebook-generator";

export const runtime = "nodejs";
export const maxDuration = 120;

const ManuscriptChapterSchema = z.object({
  number: z.number().int().positive().max(200),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(600_000),
}).strict();

const ExportRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500).default(""),
  authorName: z.string().trim().min(1).max(200).default("NexusLM"),
  template: BookTemplateEnum.default("popular-nonfiction"),
  printSpec: PrintSpecSchema.partial().optional(),
  chapters: z.array(ManuscriptChapterSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const numbers = new Set<number>();
  const totalCharacters = value.chapters.reduce((total, chapter) => total + chapter.content.length, 0);
  for (const [index, chapter] of value.chapters.entries()) {
    if (numbers.has(chapter.number)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chapters", index, "number"],
        message: `Chapter number ${chapter.number} is duplicated.`,
      });
    }
    numbers.add(chapter.number);
  }
  if (totalCharacters > 4_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chapters"],
      message: "The assembled manuscript is too large for one PDF request. Keep it below 4 million characters.",
    });
  }
});

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "nexuslm-manuscript";
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof ExportRequestSchema>;
  try {
    input = ExportRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid manuscript export request." },
      { status: 400 },
    );
  }

  try {
    const printSpec = PrintSpecSchema.parse(input.printSpec ?? {});
    const chapters = [...input.chapters]
      .sort((a, b) => a.number - b.number)
      .map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        intro: "",
        epigraph: "",
        sections: [{
          chapterNumber: chapter.number,
          sectionNumber: 1,
          heading: "",
          body: chapter.content,
          wordCount: chapter.content.split(/\s+/).filter(Boolean).length,
          status: "complete" as const,
        }],
        forwardQuestion: "",
        keyTakeaways: [],
        reflectionQuestions: [],
        totalWordCount: chapter.content.split(/\s+/).filter(Boolean).length,
        status: "complete" as const,
      }));
    const totalWordCount = chapters.reduce((total, chapter) => total + chapter.totalWordCount, 0);
    const manifest = EbookManifestSchema.parse({
      jobId: `nexuslm-${Date.now()}`,
      bookTitle: input.title,
      subtitle: input.subtitle,
      authorName: input.authorName,
      frontMatter: {
        preface: "",
        introduction: "",
        conclusion: "",
        aboutAuthor: null,
        resourcesList: [],
        scriptureIndex: [],
      },
      chapters,
      totalWordCount,
      allQuotes: [],
      generatedAt: new Date().toISOString(),
      selectedTemplate: input.template,
      printSpec,
    });
    const pdf = await generatePdfBuffer(manifest, input.template, printSpec);
    const filename = `${safeFilename(input.title)}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Manuscript PDF generation failed." },
      { status: 500 },
    );
  }
}
