import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EbookManifestSchema, BookTemplateEnum, PrintSpecSchema } from "@/lib/schemas/ebook";
import { generateDocxBuffer, generatePdfBuffer } from "@/lib/ebook-generator";
import {
  htmlToNexusLMDocumentText,
  nexusLMContentToHtml,
  safeNexusLMFilename,
  type NexusLMArtifactFormat,
} from "@/lib/nexuslm-artifacts";
import { renderHtmlToEditableDocxBuffer, renderHtmlToPdfBuffer } from "@/lib/nexuslm-html-renderer";
import { renderNexusLMXlsxBuffer } from "@/lib/nexuslm-spreadsheet";

export const runtime = "nodejs";
export const maxDuration = 300;

const ManuscriptChapterSchema = z.object({
  number: z.number().int().positive().max(200),
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(600_000),
}).strict();

const ExportRequestSchema = z.object({
  format: z.enum(["pdf", "docx", "html", "txt", "md", "json", "csv", "xlsx"]).default("pdf"),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().max(500).default(""),
  authorName: z.string().trim().min(1).max(200).default("NexusLM"),
  template: BookTemplateEnum.default("popular-nonfiction"),
  printSpec: PrintSpecSchema.partial().optional(),
  html: z.string().trim().min(1).max(2_000_000).optional(),
  content: z.string().min(1).max(2_000_000).optional(),
  chapters: z.array(ManuscriptChapterSchema).min(1).max(200).optional(),
}).strict().superRefine((value, context) => {
  if (!value.html && !value.content && !value.chapters) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chapters"],
      message: "Provide manuscript chapters or an HTML artifact to export.",
    });
  }
  const numbers = new Set<number>();
  const totalCharacters = value.chapters?.reduce((total, chapter) => total + chapter.content.length, 0) ?? 0;
  for (const [index, chapter] of (value.chapters ?? []).entries()) {
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
    const format = input.format as NexusLMArtifactFormat;
    const filename = safeNexusLMFilename(input.title);
    if (format === "html") {
      const html = input.html ?? nexusLMContentToHtml(input.content ?? "", input.title, "html");
      return new NextResponse(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}.html"`,
          "Content-Length": String(Buffer.byteLength(html, "utf8")),
          "Cache-Control": "no-store",
        },
      });
    }

    if (input.html || input.content) {
      if (["txt", "md", "json", "csv"].includes(format)) {
        const content = input.content ?? htmlToNexusLMDocumentText(input.html ?? "");
        const extension = format;
        const contentType = format === "json"
          ? "application/json;charset=utf-8"
          : format === "csv"
            ? "text/csv;charset=utf-8"
            : format === "md"
              ? "text/markdown;charset=utf-8"
              : "text/plain;charset=utf-8";
        return new NextResponse(content, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${filename}.${extension}"`,
            "Content-Length": String(Buffer.byteLength(content, "utf8")),
            "Cache-Control": "no-store",
          },
        });
      }
      const sourceHtml = input.html ?? nexusLMContentToHtml(input.content ?? "", input.title, format);
      const artifact = format === "docx"
        ? await renderHtmlToEditableDocxBuffer(sourceHtml)
        : format === "xlsx"
          ? await renderNexusLMXlsxBuffer(input.content ?? htmlToNexusLMDocumentText(input.html ?? ""))
          : await renderHtmlToPdfBuffer(sourceHtml);
      const extension = format === "docx" ? "docx" : format === "xlsx" ? "xlsx" : "pdf";
      const contentType = format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/pdf";
      return new NextResponse(new Uint8Array(artifact), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}.${extension}"`,
          "Content-Length": String(artifact.byteLength),
          "Cache-Control": "no-store",
          "X-NexusLM-Export-Mode": "editable-html-render",
        },
      });
    }

    const printSpec = PrintSpecSchema.parse(input.printSpec ?? {});
    const sourceChapters = input.chapters ?? [{
      number: 1,
      title: input.title,
      content: htmlToNexusLMDocumentText(input.html ?? ""),
    }];
    const chapters = [...sourceChapters]
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
    const artifact = format === "docx"
      ? await generateDocxBuffer(manifest, input.template, printSpec)
      : await generatePdfBuffer(manifest, input.template, printSpec);
    const extension = format === "docx" ? "docx" : "pdf";
    const contentType = format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
    return new NextResponse(new Uint8Array(artifact), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}.${extension}"`,
        "Content-Length": String(artifact.byteLength),
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
