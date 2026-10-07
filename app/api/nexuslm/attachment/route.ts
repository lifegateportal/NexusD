import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const FileMetaSchema = z.object({
  name: z.string().min(1).max(240),
  size: z.number().positive().max(20_000_000),
  type: z.string().max(120).optional(),
});

const SUPPORTED_EXTENSIONS = new Set(["pdf"]);
const MAX_EXTRACTED_CHARACTERS = 6_000_000;

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const rawFile = formData.get("file");
    if (!(rawFile instanceof File)) {
      return NextResponse.json({ error: "Missing attachment file." }, { status: 400 });
    }

    const meta = FileMetaSchema.safeParse({
      name: rawFile.name,
      size: rawFile.size,
      type: rawFile.type,
    });
    if (!meta.success) {
      return NextResponse.json({ error: "Attachment is too large or has invalid metadata." }, { status: 400 });
    }

    const extension = fileExtension(meta.data.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: "This attachment format cannot be extracted yet." }, { status: 415 });
    }

    let text = "";
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const parsed = await pdfParse(Buffer.from(await rawFile.arrayBuffer()));
      text = parsed.text ?? "";
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error
          ? `PDF extraction failed: ${error.message}`
          : "PDF extraction failed. The file may be scanned, encrypted, or malformed.",
      }, { status: 422 });
    }

    const normalized = text.replace(/\u0000/g, "").trim();
    if (!normalized) {
      return NextResponse.json({
        error: "No readable text was extracted. This PDF may be image-only and needs OCR support.",
      }, { status: 422 });
    }
    if (normalized.length > MAX_EXTRACTED_CHARACTERS) {
      return NextResponse.json({
        error: `The extracted PDF text is ${normalized.length.toLocaleString()} characters, above the ${MAX_EXTRACTED_CHARACTERS.toLocaleString()}-character safety limit.`,
      }, { status: 413 });
    }

    return NextResponse.json({
      text: normalized,
      originalLength: normalized.length,
      kind: "pdf",
      mimeType: meta.data.type || "application/pdf",
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Document extraction failed.",
    }, { status: 500 });
  }
}
