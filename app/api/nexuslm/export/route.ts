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
  documentStyle: z.enum(["teaching-outline"]).optional(),
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

function applyDocumentStyle(html: string, style?: "teaching-outline"): string {
  if (style !== "teaching-outline") return html;
  const outlineStyles = `<style id="nexuslm-teaching-outline">
    @page { margin: 0.8in; }
    body { font-family: Arial, Calibri, sans-serif !important; font-size: 12pt !important; line-height: 1.55 !important; color: #1f2937 !important; max-width: 7in !important; }
    h1 { font-size: 22pt !important; line-height: 1.2 !important; margin: 0 0 18pt !important; }
    h2 { font-size: 17pt !important; line-height: 1.25 !important; margin: 20pt 0 9pt !important; break-after: avoid-page !important; }
    h3 { font-size: 13pt !important; line-height: 1.3 !important; margin: 14pt 0 6pt !important; break-after: avoid-page !important; }
    p, li, blockquote { font-size: 12pt !important; line-height: 1.55 !important; }
    p { margin: 0 0 9pt !important; }
    li { margin-bottom: 5pt !important; }
    blockquote { margin: 10pt 0 14pt !important; padding: 8pt 12pt !important; border-left: 3pt solid #0e7490 !important; background: #f1f5f9 !important; }
    strong { font-weight: 700 !important; }
    h1, h2, h3, blockquote, li { break-inside: avoid-page; }
  </style>`;
  return /<\/head\s*>/i.test(html)
    ? html.replace(/<\/head\s*>/i, `${outlineStyles}</head>`)
    : `${outlineStyles}${html}`;
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
      const sourceHtml = applyDocumentStyle(
        input.html ?? nexusLMContentToHtml(input.content ?? "", input.title, format),
        input.documentStyle,
      );
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
