/**
 * ebook-generator.tsx
 * Converts an EbookManifest into PDF and EPUB binary buffers.
 * PDF: pdfkit (pure JS, zero native dependencies — works on any server)
 * EPUB: epub-gen-memory
 */

import type { EbookManifest, ChapterDraft, FrontBackMatter, BackMatter, Quote } from "@/lib/schemas/ebook";
import type { PrintSpec } from "@/lib/schemas/ebook";
import { getTemplate } from "@/lib/book-templates";
import { TRIM_SIZE_SPECS } from "@/lib/book-templates";
import type { BookTemplateConfig } from "@/lib/book-templates";
import { parseMarkdownBlockquote, formatScriptureReference } from "@/lib/scripture-formatter";
import type { ScriptureQuote } from "@/lib/scripture-formatter";
import { existsSync } from "node:fs";
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak,
  TableOfContents,
  LevelFormat,
  Header,
  Footer,
  TabStopType,
  TabStopPosition,
  LeaderType,
  SectionType,
  NumberFormat,
  PageNumber,
} from "docx";

type PdfFontSet = {
  serif: string;
  serifItalic: string;
  serifBold: string;
  sans: string;
  sansBold: string;
};

type FontFamily = "template" | "georgia" | "times" | "garamond" | "palatino" | "helvetica";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvePdfFonts(doc: any, fontFamily: FontFamily = "template"): PdfFontSet {
  const georgiaPaths = {
    regular: [
      "/usr/share/fonts/truetype/msttcorefonts/Georgia.ttf",
      "/usr/share/fonts/truetype/msttcorefonts/georgia.ttf",
      "/usr/share/fonts/truetype/microsoft/Georgia.ttf",
    ],
    italic: [
      "/usr/share/fonts/truetype/msttcorefonts/Georgia_Italic.ttf",
      "/usr/share/fonts/truetype/msttcorefonts/georgiai.ttf",
      "/usr/share/fonts/truetype/microsoft/Georgia Italic.ttf",
    ],
    bold: [
      "/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf",
      "/usr/share/fonts/truetype/msttcorefonts/georgiab.ttf",
      "/usr/share/fonts/truetype/microsoft/Georgia Bold.ttf",
    ],
  };

  const pickPath = (paths: string[]) => paths.find((path) => existsSync(path));
  
  // Force specific font family if requested
  if (fontFamily === "times") {
    return {
      serif: "Times-Roman",
      serifItalic: "Times-Italic",
      serifBold: "Times-Bold",
      sans: "Helvetica",
      sansBold: "Helvetica-Bold",
    };
  }
  
  if (fontFamily === "helvetica") {
    return {
      serif: "Helvetica",
      serifItalic: "Helvetica-Oblique",
      serifBold: "Helvetica-Bold",
      sans: "Helvetica",
      sansBold: "Helvetica-Bold",
    };
  }
  
  if (fontFamily === "palatino") {
    return {
      serif: "Palatino-Roman",
      serifItalic: "Palatino-Italic",
      serifBold: "Palatino-Bold",
      sans: "Helvetica",
      sansBold: "Helvetica-Bold",
    };
  }
  
  // For "georgia", "garamond", or "template", try Georgia first (best quality)
  const regular = pickPath(georgiaPaths.regular);
  const italic = pickPath(georgiaPaths.italic);
  const bold = pickPath(georgiaPaths.bold);

  if (regular && italic && bold) {
    doc.registerFont("BookGeorgia", regular);
    doc.registerFont("BookGeorgiaItalic", italic);
    doc.registerFont("BookGeorgiaBold", bold);
    return {
      serif: "BookGeorgia",
      serifItalic: "BookGeorgiaItalic",
      serifBold: "BookGeorgiaBold",
      sans: "Helvetica",
      sansBold: "Helvetica-Bold",
    };
  }

  // Fallback to Times if Georgia not found
  return {
    serif: "Times-Roman",
    serifItalic: "Times-Italic",
    serifBold: "Times-Bold",
    sans: "Helvetica",
    sansBold: "Helvetica-Bold",
  };
}

// ─── Running Page Header/Footer ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// ── Stamp running head + footer onto a single page (called in the second pass)
// All coordinates are pre-computed outside of any event handler.
function stampPageHeader(
  doc: any,
  bookTitle: string,
  chapterTitle: string,
  pageNumber: number | string, // supports both numbers and roman numerals
  isChapterOpener: boolean,
  isFrontMatter: boolean,
  fonts: PdfFontSet,
  layout: { gutterMargin: number; outsideMargin: number; textW: number; pageW: number; footerY: number },
  folioStyle: "center" | "outside" | "none-on-openers",
) {
  const { gutterMargin, outsideMargin, textW, pageW, footerY } = layout;

  // INDUSTRY STANDARD: Page numbering follows recto/verso convention
  // Recto (odd-numbered) = right-hand pages | Verso (even-numbered) = left-hand pages
  // This determines header placement (book title verso, chapter title recto) and
  // margin alternation (gutter/outside swap) per Chicago Manual of Style §1.6-1.7
  const numericPageNum = typeof pageNumber === "string" ? 0 : pageNumber; // roman numerals always use physical position
  const isVerso = numericPageNum % 2 === 0;
  const mL = isVerso ? outsideMargin : gutterMargin;
  const mR = isVerso ? gutterMargin  : outsideMargin;

  // Running header (skip on chapter openers and front matter)
  if (!isChapterOpener && !isFrontMatter) {
    // Verso (even / left page): book title flush left
    // Recto (odd / right page): chapter title flush right  — CMOS / Zondervan standard
    const headText = isVerso ? bookTitle : (chapterTitle || bookTitle);
    const headAlign = isVerso ? "left" : "right";

    // Disable top-margin check: y=28 is above topMargin; without this PDFKit auto-paginates
    const savedTop = doc.page.margins.top;
    doc.page.margins.top = 0;
    doc
      .fontSize(7)
      .font(fonts.sans)
      // #555555 = ~67% K — renders as dark neutral grey on press; avoids near-white
      // RGB values that can drop out on CMYK-converted plates.
      .fillColor("#555555")
      .text(headText.toUpperCase(), mL, 28, { width: textW, align: headAlign, lineBreak: false });
    doc.page.margins.top = savedTop;

    // Hairline rule beneath the running head — #999999 = ~40% K, press-safe mid-grey
    doc
      .moveTo(mL, 42)
      .lineTo(pageW - mR, 42)
      .strokeColor("#999999")
      .lineWidth(0.25)
      .stroke();
  }

  // INDUSTRY STANDARD: Folio (page number) placement follows professional publishing norms:
  // - "center": centered footer on all pages (HarperCollins, Simon & Schuster standard)
  // - "outside": outside margin (verso left, recto right) — Penguin/Random House style
  // - "none-on-openers": no numbers on chapter opener pages (Chicago Manual preference)
  if (folioStyle === "none-on-openers" && isChapterOpener) {
    return; // no page number on chapter opener pages per Chicago Manual §1.6
  }

  // Disable bottom-margin check so PDFKit writes here
  // instead of auto-adding a new page (footerY is intentionally below page.maxY())
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  
  // Determine folio alignment based on style
  let folioAlign: "left" | "center" | "right" = "center";
  let folioX = mL;
  let folioWidth = textW;
  
  if (folioStyle === "outside") {
    // Verso (even): left-aligned at outside margin
    // Recto (odd): right-aligned at outside margin
    folioAlign = isVerso ? "left" : "right";
  }
  
  doc
    .fontSize(8)
    .font(fonts.serif)
    .fillColor("#555555")
    .text(String(pageNumber), folioX, footerY, { width: folioWidth, align: folioAlign, lineBreak: false });
  doc.page.margins.bottom = savedBottom;
}

// ─── PDF Generator (pdfkit) ───────────────────────────────────────────────────

export async function generatePdfBuffer(manifest: EbookManifest, templateId?: string, printSpec?: PrintSpec): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PDFDocument = (await import("pdfkit")).default as any;
  const tpl = getTemplate(templateId ?? manifest.selectedTemplate);

  // ── Resolve print specifications ──────────────────────────────────────────
  const resolvedPrintSpec = printSpec ?? manifest.printSpec ?? { trimSize: "6x9" as const, runningHeaders: true };
  const trimSpec = TRIM_SIZE_SPECS[resolvedPrintSpec.trimSize ?? "6x9"];
  const showRunningHeaders = resolvedPrintSpec.runningHeaders !== false && tpl.runningHeaders;
  const sectionOrnament = resolvedPrintSpec.sectionOrnament ?? "rule";
  const fontFamily: FontFamily = resolvedPrintSpec.bodyFontFamily ?? "template";
  const fontSizeScale = resolvedPrintSpec.fontSizeScale ?? 1.0;

  // ── Body text alignment override ──────────────────────────────────────────
  // If user specifies bodyTextAlign, override the template's default bodyAlign.
  // "template" means use the template's natural bodyAlign setting.
  const bodyTextAlignOverride = resolvedPrintSpec.bodyTextAlign ?? "template";
  const effectiveBodyAlign: "left" | "justify" | "right" | "center" = 
    bodyTextAlignOverride === "template" ? tpl.bodyAlign : bodyTextAlignOverride;
  
  // Create an effective template with the alignment override applied
  const effectiveTpl = { ...tpl, bodyAlign: effectiveBodyAlign };

  // editableProof: author-review PDF — PDF 1.7, no PDF/X-1a, no bleed/crop marks,
  // fully text-based so Acrobat's Edit PDF tool can make corrections.
  const isEditableProof = resolvedPrintSpec.editableProof === true;

  // ── Amendment 7: Bleed + crop marks ───────────────────────────────────────
  // When bleed is enabled the canvas expands by BLEED_PT on each edge; all
  // content is offset so it still sits at the correct trim position.
  const BLEED_PT = 9; // 0.125 in (industry standard for IngramSpark / KDP Print)
  // Proof mode suppresses bleed/crop marks — they serve no purpose in an author review copy.
  const enableBleed    = !isEditableProof && resolvedPrintSpec.bleed    === true;
  const enableCropMarks = !isEditableProof && resolvedPrintSpec.cropMarks === true && enableBleed;
  const bleedOffset = enableBleed ? BLEED_PT : 0;

  // Merge trim-size overrides on top of template defaults
  const trimPageSize = trimSpec.pageSize; // actual book trim dimensions
  const pageSize: [number, number] = enableBleed
    ? [trimPageSize[0] + BLEED_PT * 2, trimPageSize[1] + BLEED_PT * 2]
    : trimPageSize;
  const pageMargins = {
    top:    trimSpec.margins.top    + bleedOffset,
    bottom: trimSpec.margins.bottom + bleedOffset,
    left:   trimSpec.margins.left   + bleedOffset,
    right:  trimSpec.margins.right  + bleedOffset,
  };
  const adjustedBodyFontSize = tpl.bodyFontSize + trimSpec.bodyFontSizeAdjust;
  
  // Apply font size scaling to all template font sizes
  const scaledTpl = {
    ...effectiveTpl,
    bodyFontSize: effectiveTpl.bodyFontSize * fontSizeScale,
    bodyLineGap: effectiveTpl.bodyLineGap * fontSizeScale,
    paragraphGap: effectiveTpl.paragraphGap * fontSizeScale,
    paragraphIndent: effectiveTpl.paragraphIndent * fontSizeScale,
    chapterLabelSize: effectiveTpl.chapterLabelSize * fontSizeScale,
    chapterTitleSize: effectiveTpl.chapterTitleSize * fontSizeScale,
    sectionSize: effectiveTpl.sectionSize * fontSizeScale,
    matterTitleSize: effectiveTpl.matterTitleSize * fontSizeScale,
    titlePageTitleSize: effectiveTpl.titlePageTitleSize * fontSizeScale,
    titlePageSubtitleSize: effectiveTpl.titlePageSubtitleSize * fontSizeScale,
    titlePageAuthorSize: effectiveTpl.titlePageAuthorSize * fontSizeScale,
    scriptureIndent: effectiveTpl.scriptureIndent * fontSizeScale,
    scriptureFontSize: effectiveTpl.scriptureFontSize * fontSizeScale,
  };
  const adjustedBodyFontSizeScaled = adjustedBodyFontSize * fontSizeScale;

  // Pre-compute fixed layout values (avoids reliance on doc.page inside event handlers)
  // Gutter/outside margins are relative to the content area (inside bleed offset).
  const _mL = trimSpec.gutterMargin + bleedOffset;
  const _mR = trimSpec.outsideMargin + bleedOffset;
  const _pageW = pageSize[0];
  const _pageH = pageSize[1];
  const _textW = trimPageSize[0] - trimSpec.gutterMargin - trimSpec.outsideMargin; // text column = trim width minus margins
  const _footerY = _pageH - pageMargins.bottom + 18;
  const _layout = {
    gutterMargin: trimSpec.gutterMargin + bleedOffset,
    outsideMargin: trimSpec.outsideMargin + bleedOffset,
    textW: _textW,
    pageW: _pageW,
    footerY: _footerY,
  };

  return new Promise<Buffer>((resolve, reject) => {
    // ── PDF document initialisation ───────────────────────────────────────────
    // Two modes:
    //   Print-ready (default): PDF 1.4, PDF/X-1a:2001 metadata, bleed + crop marks optional.
    //   Editable proof:        PDF 1.7, no PDF/X-1a restrictions, no bleed/crop marks —
    //                          text is selectable and editable in Adobe Acrobat Pro.
    //
    // INDUSTRY UPGRADE 2: Font Embedding
    // PDFKit automatically embeds and subsets fonts registered via registerFont().
    // All fonts (Georgia, Times, Helvetica) will be embedded in the final PDF.
    //
    // INDUSTRY UPGRADE 3: PDF/X-1a OutputIntent ICC Profile
    // Full PDF/X-1a compliance requires an /OutputIntent dictionary with an ICC color
    // profile. PDFKit does not natively support this. For strict prepress validation:
    //   Option A: Use Acrobat Preflight to add an ICC profile post-generation
    //   Option B: Provide to print vendor as "PDF/X-1a intent" and they will re-distill
    //   Option C: Switch to a lower-level PDF library (pdf-lib) to inject ICC manually
    // Most POD services (KDP, IngramSpark) accept PDFs with correct metadata even
    // without the ICC profile if colors are CMYK/Grayscale and fonts are embedded.
    const creationDate = new Date();
    const printReadyInfo = {
      Title: manifest.bookTitle,
      Author: manifest.authorName,
      Subject: manifest.subtitle || manifest.bookTitle,
      Creator: "Nexus Director",
      Producer: "Nexus Director",
      Keywords: [manifest.authorName, manifest.bookTitle].filter(Boolean).join(", "),
      CreationDate: creationDate,
      ModDate: creationDate,
      // PDF/X-1a compliance markers (GTS_PDFXVersion + Trapped are required by spec).
      GTS_PDFXVersion: "PDF/X-1a:2001",
      Trapped: "False",
    };
    const proofInfo = {
      Title: `${manifest.bookTitle} — Author Proof`,
      Author: manifest.authorName,
      Subject: manifest.subtitle || manifest.bookTitle,
      Creator: "Nexus Director",
      Producer: "Nexus Director",
      Keywords: [manifest.authorName, manifest.bookTitle, "proof"].filter(Boolean).join(", "),
      CreationDate: creationDate,
      ModDate: creationDate,
    };
    const doc = new PDFDocument({
      margins: pageMargins,
      size: pageSize,
      autoFirstPage: false, // we add pages manually so pageAdded tracking is accurate
      bufferPages: true,    // hold all pages in memory for the second-pass header stamp
      // Print-ready: PDF 1.4 (required for PDF/X-1a). Proof: PDF 1.7 (full Acrobat editing).
      pdfVersion: isEditableProof ? "1.7" : "1.4",
      info: isEditableProof ? proofInfo : printReadyInfo,
      // UPGRADE 2: Ensure font embedding (PDFKit default is true, but explicitly set)
      compress: true,
    });
    const fonts = resolvePdfFonts(doc, fontFamily);
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Alternating-margin patches ────────────────────────────────────────────
    // PDFKit's LineWrapper captures startX = doc.x when a paragraph begins, then
    // restores it (this.document.x = this.startX) both on page overflow and at
    // wrap() end.  This defeats our pageAdded margin changes.  Two patches fix it:
    //
    // Patch 1 — wrap continueOnNewPage: after every page-break the stale startX
    //   restore in LineWrapper.nextSection is intercepted via a one-shot property
    //   descriptor so doc.x stays at the new page's correct alternating margin.
    //
    // Patch 2 — wrap doc.text: re-sync doc.x to page.margins.left at the start
    //   of every non-positioned text call so the next paragraph's LineWrapper
    //   captures the right startX, and the wrap()-end stale x is fixed.
    const _origContinue = (doc as any).continueOnNewPage.bind(doc);
    (doc as any).continueOnNewPage = function(opts?: unknown) {
      _origContinue(opts);
      // pageAdded has fired; doc.x is now the correct alternating margin.
      // LineWrapper.nextSection will immediately do: this.document.x = this.startX.
      // Intercept that one assignment so doc.x keeps the correct value.
      const correctX: number = (doc as any).x;
      Object.defineProperty(doc, "x", {
        configurable: true,
        enumerable: true,
        get() { return correctX; },
        set(_stale: number) {
          // Remove this interceptor and restore as a plain writable property.
          Object.defineProperty(doc, "x", {
            configurable: true, enumerable: true, writable: true, value: correctX,
          });
        },
      });
    };

    const _origText = (doc as any).text.bind(doc);
    (doc as any).text = function(text: string, ...rest: unknown[]) {
      // For non-positioned calls (no explicit x arg), re-sync doc.x to the
      // current page's left margin before building the LineWrapper so that
      // startX captures the correct alternating value.
      if (typeof rest[0] !== "number") {
        (doc as any).x = (doc as any).page.margins.left;
      }
      return _origText(text, ...rest);
    };

    // ── First pass: track page metadata only — no drawing in this handler ─────
    interface PageMeta { 
      type: "front" | "toc" | "blank" | "opener" | "body"; 
      chapterTitle: string; 
      bodyPageNum: number; 
      frontPageNum: number; // for roman numeral tracking
      isFrontMatter: boolean;
    }
    const pageMetas: PageMeta[] = [];
    let totalPageCounter = 0; // every page including front matter
    let bodyPageCounter = 0;
    let frontMatterPageCounter = 0; // separate counter for roman numerals
    let currentChapterTitle = "";
    let nextIsOpener = false;
    let nextIsBlank  = false; // blank verso page inserted to force next section to recto
    let nextIsToc    = false; // TOC placeholder page
    let tocMetaIndex = -1;   // pageMetas index of the TOC page
    const chapterTocEntries: Array<{ chapterTitle: string; bodyPageNum: number }> = [];

    doc.on("pageAdded", () => {
      totalPageCounter++;

      if (nextIsBlank) {
        pageMetas.push({ type: "blank", chapterTitle: "", bodyPageNum: 0, frontPageNum: 0, isFrontMatter: false });
        nextIsBlank = false;
      } else if (nextIsToc) {
        tocMetaIndex = pageMetas.length;
        frontMatterPageCounter++;
        pageMetas.push({ type: "toc", chapterTitle: "", bodyPageNum: 0, frontPageNum: frontMatterPageCounter, isFrontMatter: true });
        nextIsToc = false;
      } else if (nextIsOpener) {
        bodyPageCounter++;
        const entry = { chapterTitle: currentChapterTitle, bodyPageNum: bodyPageCounter };
        pageMetas.push({ type: "opener", ...entry, frontPageNum: 0, isFrontMatter: false });
        chapterTocEntries.push(entry);
        nextIsOpener = false;
      } else if (bodyPageCounter > 0) {
        bodyPageCounter++;
        pageMetas.push({ type: "body", chapterTitle: currentChapterTitle, bodyPageNum: bodyPageCounter, frontPageNum: 0, isFrontMatter: false });
      } else {
        frontMatterPageCounter++;
        pageMetas.push({ type: "front", chapterTitle: "", bodyPageNum: 0, frontPageNum: frontMatterPageCounter, isFrontMatter: true });
      }

      // Alternate gutter/outside margins across ALL pages (including front matter)
      const isVerso = totalPageCounter % 2 === 0;
      doc.page.margins.left  = isVerso ? (trimSpec.outsideMargin + bleedOffset) : (trimSpec.gutterMargin + bleedOffset);
      doc.page.margins.right = isVerso ? (trimSpec.gutterMargin + bleedOffset)  : (trimSpec.outsideMargin + bleedOffset);
      doc.x = doc.page.margins.left; // re-sync cursor after overriding margins
    });

    // ── Helper: insert blank verso so the NEXT addPage() lands on recto ────────
    // INDUSTRY STANDARD: Chapters and major sections (Preface, Introduction, Back Matter)
    // must always begin on a recto (right-hand, odd-numbered page). This function ensures
    // that by inserting a blank verso page when the current page is already recto.
    const forceNextRecto = () => {
      // totalPageCounter is odd → we're on a recto → next natural page = verso → insert blank
      if (totalPageCounter % 2 !== 0) { nextIsBlank = true; doc.addPage(); doc.x = doc.page.margins.left; }
    };
    
    // ── Helper: check if we need a page break to prevent orphan sections ─────────
    // Prevents starting a new section too close to the bottom of a page, which would
    // create awkward single-line fragments. Threshold is 5 body-line heights.
    const needsPageBreak = (lineHeight: number): boolean => {
      return doc.page.height - doc.page.margins.bottom - doc.y < lineHeight * 5;
    };

    // ── Title page (page 1, recto) ────────────────────────────────────────────
    // INDUSTRY UPGRADE 1: Half-title page (traditional publishing standard)
    // Half-title shows only the book title in a simple, elegant format
    doc.addPage();
    doc.x = doc.page.margins.left;
    const titleTextW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc
      .moveDown(tpl.titlePageTopGap + 2)
      .fontSize(tpl.chapterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor)
      .text(manifest.bookTitle, { width: titleTextW, align: "center" });

    // ── Half-title verso (page 2, blank or book series info) ─────────────────
    doc.addPage();
    doc.x = doc.page.margins.left;
    // Intentionally blank or could show series info / "Also by Author"

    // ── Full title page (page 3, recto) ───────────────────────────────────────
    doc.addPage();
    doc.x = doc.page.margins.left;
    doc
      .moveDown(tpl.titlePageTopGap)
      .fontSize(tpl.titlePageTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor)
      .text(manifest.bookTitle, { width: titleTextW, align: tpl.titlePageAlign });

    if (manifest.subtitle) {
      doc
        .moveDown(0.8)
        .fontSize(tpl.titlePageSubtitleSize).font(fonts.serif).fillColor(tpl.labelColor)
        .text(manifest.subtitle, { width: titleTextW, align: tpl.titlePageAlign });
    }

    doc
      .moveDown(2)
      .fontSize(tpl.titlePageAuthorSize).font(fonts.serif).fillColor(tpl.accentColor)
      .text(manifest.authorName, { width: titleTextW, align: tpl.titlePageAlign });

    // ── Copyright page (page 4, verso — back of title page) ──────────────────
    doc.addPage();
    doc.x = doc.page.margins.left;
    writeCopyrightPage(doc, manifest, fonts, scaledTpl);

    // ── Table of Contents placeholder (page 5, recto) ─────────────────────────
    // Content is filled in the second pass once all page numbers are known.
    nextIsToc = true;
    doc.addPage();
    doc.x = doc.page.margins.left;

    // ── Preface (recto-forced) — skip if empty ────────────────────────────────
    if (manifest.frontMatter.preface && manifest.frontMatter.preface.trim().length > 0) {
      forceNextRecto();
      writePreface(doc, manifest.frontMatter, manifest.allQuotes ?? [], fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    // ── Introduction (recto-forced) ───────────────────────────────────────────
    forceNextRecto();
    writeIntroduction(doc, manifest.frontMatter, manifest.allQuotes ?? [], fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);

    // ── Chapter body pages (each recto-forced) ────────────────────────────────
    for (const chapter of manifest.chapters) {
      forceNextRecto();
      currentChapterTitle = chapter.title;
      nextIsOpener = true;
      writeChapter(doc, chapter, manifest.allQuotes ?? [], fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    // ── Back matter (each section recto-forced) ───────────────────────────────
    forceNextRecto();
    currentChapterTitle = "Conclusion";
    writeConclusion(doc, manifest.frontMatter, manifest.allQuotes ?? [], fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);

    if (manifest.frontMatter.aboutAuthor) {
      forceNextRecto();
      currentChapterTitle = "About the Author";
      writeAboutAuthor(doc, manifest.frontMatter, manifest.allQuotes ?? [], fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    if ((manifest.frontMatter.resourcesList ?? []).length > 0) {
      forceNextRecto();
      currentChapterTitle = "Resources";
      writeResources(doc, manifest.frontMatter, fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    if (manifest.backMatter && (manifest.backMatter.glossary ?? []).length > 0) {
      forceNextRecto();
      currentChapterTitle = "Glossary";
      writeGlossary(doc, manifest.backMatter, fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    if (manifest.backMatter && (manifest.backMatter.readingGroupGuide ?? []).length > 0) {
      forceNextRecto();
      currentChapterTitle = "Reading Group Guide";
      writeReadingGroupGuide(doc, manifest.backMatter, fonts, scaledTpl, sectionOrnament, adjustedBodyFontSizeScaled);
    }

    // ── Second pass ───────────────────────────────────────────────────────────
    const { start, count } = doc.bufferedPageRange();

    // 1. Write Table of Contents (must happen before header stamping)
    if (tocMetaIndex >= 0) {
      const tocIsVerso = (tocMetaIndex + 1) % 2 === 0;
      stampTOC(doc, start + tocMetaIndex, manifest, chapterTocEntries, fonts, tpl, _layout, tocIsVerso);
    }

    // 2. Running headers + page-number footers on all pages (respect folioStyle and frontMatterNumbering)
    if (showRunningHeaders) {
      const folioStyle = resolvedPrintSpec.folioStyle ?? "center";
      const frontMatterNumbering = resolvedPrintSpec.frontMatterNumbering ?? "arabic";
      
      for (let i = 0; i < count; i++) {
        const meta = pageMetas[i];
        if (!meta || meta.type === "blank") continue;
        
        // Determine page number based on front matter numbering style
        let pageNumber: number | string = 0;
        if (meta.isFrontMatter) {
          if (frontMatterNumbering === "roman") {
            pageNumber = toRomanLower(meta.frontPageNum);
          } else if (frontMatterNumbering === "arabic") {
            pageNumber = meta.frontPageNum;
          } else {
            // "none" — skip numbering for front matter
            if (meta.type === "toc") {
              // Still render TOC content but no page number
              continue;
            }
            continue;
          }
        } else {
          pageNumber = meta.bodyPageNum;
        }
        
        doc.switchToPage(start + i);
        stampPageHeader(
          doc,
          manifest.bookTitle,
          meta.chapterTitle,
          pageNumber,
          meta.type === "opener",
          meta.isFrontMatter,
          fonts,
          _layout,
          folioStyle,
        );
      }
    }

    // ── Amendment 7: Crop marks + Registration marks (second pass, all pages) ─
    // L-shaped crop marks at each corner outside the trim area, in registration black.
    // INDUSTRY UPGRADE 4: Registration targets (crosshairs) and CMYK color bars
    // for press calibration and alignment verification.
    // Only drawn when bleed + cropMarks are both enabled.
    if (enableCropMarks) {
      const markLen  = 18;  // 0.25 in — length of each crop mark arm
      const markGap  = 3;   // 3pt gap between trim edge and mark start
      const tX = BLEED_PT;            // trim left X
      const tY = BLEED_PT;            // trim top Y
      const tW = trimPageSize[0];     // trim width
      const tH = trimPageSize[1];     // trim height
      
      for (let i = 0; i < count; i++) {
        doc.switchToPage(start + i);
        // Disable all page margins so we can draw anywhere on the canvas
        const savedMargins = { ...doc.page.margins };
        doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
        doc.strokeColor("#000000").lineWidth(0.25);
        
        // ── Crop marks at corners ──────────────────────────────────────────
        // Top-left corner
        doc.moveTo(tX - markGap, tY).lineTo(tX - markGap - markLen, tY).stroke();
        doc.moveTo(tX, tY - markGap).lineTo(tX, tY - markGap - markLen).stroke();
        // Top-right corner
        doc.moveTo(tX + tW + markGap, tY).lineTo(tX + tW + markGap + markLen, tY).stroke();
        doc.moveTo(tX + tW, tY - markGap).lineTo(tX + tW, tY - markGap - markLen).stroke();
        // Bottom-left corner
        doc.moveTo(tX - markGap, tY + tH).lineTo(tX - markGap - markLen, tY + tH).stroke();
        doc.moveTo(tX, tY + tH + markGap).lineTo(tX, tY + tH + markGap + markLen).stroke();
        // Bottom-right corner
        doc.moveTo(tX + tW + markGap, tY + tH).lineTo(tX + tW + markGap + markLen, tY + tH).stroke();
        doc.moveTo(tX + tW, tY + tH + markGap).lineTo(tX + tW, tY + tH + markGap + markLen).stroke();
        
        // ── UPGRADE 4: Registration targets (crosshairs) ───────────────────
        // Centered on each edge for press alignment verification
        const regSize = 12; // crosshair diameter
        const regGap = markLen + 6; // distance from trim edge
        
        // Top center registration mark
        const topCenterX = tX + tW / 2;
        const topCenterY = tY - regGap;
        doc.circle(topCenterX, topCenterY, regSize / 2).stroke();
        doc.moveTo(topCenterX - regSize, topCenterY).lineTo(topCenterX + regSize, topCenterY).stroke();
        doc.moveTo(topCenterX, topCenterY - regSize).lineTo(topCenterX, topCenterY + regSize).stroke();
        
        // Bottom center registration mark
        const bottomCenterX = tX + tW / 2;
        const bottomCenterY = tY + tH + regGap;
        doc.circle(bottomCenterX, bottomCenterY, regSize / 2).stroke();
        doc.moveTo(bottomCenterX - regSize, bottomCenterY).lineTo(bottomCenterX + regSize, bottomCenterY).stroke();
        doc.moveTo(bottomCenterX, bottomCenterY - regSize).lineTo(bottomCenterX, bottomCenterY + regSize).stroke();
        
        // ── UPGRADE 4: CMYK Color bars (bottom, for press calibration) ─────
        // Only on the first page to avoid clutter
        if (i === 0) {
          const barW = 36; // width of each color bar
          const barH = 12; // height
          const barY = tY + tH + regGap + 20; // below bottom registration mark
          const barStartX = tX + (tW / 2) - (barW * 2); // center 4 bars
          
          // Cyan bar
          doc.rect(barStartX, barY, barW, barH).fillAndStroke("#00FFFF", "#000000");
          // Magenta bar
          doc.rect(barStartX + barW, barY, barW, barH).fillAndStroke("#FF00FF", "#000000");
          // Yellow bar
          doc.rect(barStartX + barW * 2, barY, barW, barH).fillAndStroke("#FFFF00", "#000000");
          // Black (K) bar
          doc.rect(barStartX + barW * 3, barY, barW, barH).fillAndStroke("#000000", "#000000");
          
          // Add labels below bars
          doc.fontSize(6).font(fonts.sans).fillColor("#000000");
          doc.text("C", barStartX + barW / 2 - 3, barY + barH + 2, { lineBreak: false });
          doc.text("M", barStartX + barW * 1.5 - 3, barY + barH + 2, { lineBreak: false });
          doc.text("Y", barStartX + barW * 2.5 - 3, barY + barH + 2, { lineBreak: false });
          doc.text("K", barStartX + barW * 3.5 - 3, barY + barH + 2, { lineBreak: false });
        }
        
        // Restore margins
        doc.page.margins = savedMargins;
      }
    }

    doc.end();
  });
}

// ── Amendment 4: Drop Cap ─────────────────────────────────────────────────────
// Renders the first character of `paragraph` as a traditional publisher drop cap
// (lines × body font size tall, inset, serif bold) and flows the remainder of the
// paragraph text beside it.  Returns the remaining text after the cap character
// so the caller can continue rendering the rest of the paragraph normally.
//
// Algorithm:
//   1. Measure the drop cap character width at capFontSize.
//   2. Draw the cap at (marginLeft, currentY) with lineBreak: false.
//   3. Re-flow the first `capLines` lines of the rest of the paragraph in the
//      narrowed column (startX = marginLeft + capWidth + gap).
//   4. Advance doc.y and doc.x so subsequent paragraphs start at the normal margin.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeDropCapParagraph(
  doc: any,
  paragraph: string,
  fonts: PdfFontSet,
  tpl: BookTemplateConfig,
  bodyFontSize: number,
): void {
  const capLines   = 3;
  const capGap     = 5; // pt gap between cap and text column
  const lineH      = bodyFontSize + tpl.bodyLineGap;
  const capH       = capLines * lineH;
  const capFontSize = capH * 0.88; // scale to fill drop height (0.88 accounts for descenders)

  const clean = stripMarkdownForPdf(applySmartTypography(paragraph));
  if (!clean || clean.length < 2) {
    // Fallback: render as normal paragraph
    const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.fontSize(bodyFontSize).font(fonts.serif).fillColor("#1a1a1a")
      .text(clean || paragraph, doc.page.margins.left, undefined, {
        width: contentW,
        lineGap: tpl.bodyLineGap,
        align: tpl.bodyAlign,
      });
    return;
  }

  const capChar  = clean[0];
  const restText = clean.slice(1).trimStart();
  const mL       = doc.page.margins.left;
  const contentW = doc.page.width - mL - doc.page.margins.right;
  const capY     = doc.y;
  const capPage  = doc.page;

  // Measure cap width at the resolved size
  doc.font(fonts.serifBold).fontSize(capFontSize);
  const capW = doc.widthOfString(capChar) + capGap;

  // Draw the drop cap — positioned absolutely, no line break
  doc.fillColor(tpl.chapterTitleColor)
    .text(capChar, mL, capY, { lineBreak: false });

  // Calculate narrow column dimensions
  const narrowW = contentW - capW;
  const narrowX = mL + capW;
  doc.font(fonts.serif).fontSize(bodyFontSize).fillColor("#1a1a1a");

  // Binary search to find how much text fits beside drop cap (capH height, narrowW width)
  let low = 0;
  let high = restText.length;
  let bestFit = 0;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testText = restText.substring(0, mid);
    const testHeight = doc.heightOfString(testText, { width: narrowW, lineGap: tpl.bodyLineGap });
    
    if (testHeight <= capH - lineH * 0.2) { // Conservative fit to ensure text doesn't overflow
      bestFit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  
  // Find word boundary near bestFit
  let splitPoint = bestFit;
  while (splitPoint > 0 && restText[splitPoint] !== ' ') {
    splitPoint--;
  }
  if (splitPoint === 0) splitPoint = bestFit;
  
  const narrowText = restText.substring(0, splitPoint).trim();
  const remainderText = restText.substring(splitPoint).trim();

  // Render narrow text beside drop cap
  if (narrowText) {
    doc.text(narrowText, narrowX, capY, {
      width: narrowW,
      lineGap: tpl.bodyLineGap,
      align: tpl.bodyAlign,
      continued: false,
    });
  }

  // Continue remainder from current position, no gap
  doc.x = mL;

  // Render remainder at full width
  if (remainderText) {
    doc.text(remainderText, mL, doc.y, {
      width: contentW,
      lineGap: tpl.bodyLineGap,
      align: tpl.bodyAlign,
    });
  }

  // Ensure we're at least past the drop cap height on the SAME page only.
  // If the paragraph flowed to a new page, applying capY from the old page
  // would create a large artificial vertical gap.
  if (doc.page === capPage && doc.y < capY + capH) {
    doc.y = capY + capH;
  }

  // Reset x position to left margin for next paragraph
  doc.x = mL;

  doc.moveDown(tpl.paragraphGap > 0 ? tpl.paragraphGap / lineH : 0.6);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeDivider(doc: any, tpl: BookTemplateConfig, ornamentStyle?: "rule" | "fleuron" | "asterism" | "dinkus" | "none") {
  const style = ornamentStyle ?? "rule";
  
  if (!tpl.showDivider && style === "rule") { 
    doc.moveDown(0.5); 
    return; 
  }
  
  doc.moveDown(0.5);
  
  switch (style) {
    case "fleuron":
      // ❦ (U+2766) — Traditional academic/literary floral ornament
      doc
        .fontSize(14)
        .font("Helvetica")
        .fillColor(tpl.dividerColor)
        .text("❦", doc.page.margins.left, undefined, { 
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right, 
          align: "center", 
          lineBreak: false 
        });
      break;
      
    case "asterism":
      // ⁂ (U+2042) — Fiction/memoir standard three-asterisk marker
      doc
        .fontSize(12)
        .font("Helvetica")
        .fillColor(tpl.dividerColor)
        .text("⁂", doc.page.margins.left, undefined, { 
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right, 
          align: "center", 
          lineBreak: false 
        });
      break;
      
    case "dinkus":
      // * * * — Minimalist modern three-asterisk spacing
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor(tpl.dividerColor)
        .text("*   *   *", doc.page.margins.left, undefined, { 
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right, 
          align: "center", 
          lineBreak: false,
          characterSpacing: 3
        });
      break;
      
    case "rule":
      // Traditional horizontal rule
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor(tpl.dividerColor)
        .lineWidth(0.5)
        .stroke();
      break;
      
    case "none":
      // Blank space only (no visual divider)
      break;
  }
  
  doc.moveDown(0.5);
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[“”"'.,;:!?()[\]{}-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchingBlockQuote(paragraph: string, quotes: Quote[]): Quote | null {
  const normalizedParagraph = normalizeText(paragraph);
  return quotes.find((quote) => {
    if (!quote.isBlockQuote || !quote.text) return false;
    const normalizedQuote = normalizeText(quote.text);
    const lead = normalizedQuote.split(" ").slice(0, 8).join(" ");
    return lead.length > 20 && normalizedParagraph.includes(lead);
  }) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeScriptureBlock(doc: any, quote: ScriptureQuote, fonts: PdfFontSet, tpl: BookTemplateConfig) {
  // Helper to calculate indent/width based on current page margins
  const getScriptureLayout = () => {
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const textX = doc.page.margins.left + tpl.scriptureIndent;
    const textWidth = contentWidth - tpl.scriptureIndent * 2;
    return { contentWidth, textX, textWidth };
  };

  let layout = getScriptureLayout();

  // Clean the text: strip all markdown blockquote markers and other artifacts
  const cleanedText = quote.text
    .split("\n")
    .map((line) => line.replace(/^(>\s*)+/, "").replace(/>\.?\s*/g, "").trim())
    .filter((l) => l.length > 0)
    .join("\n");
  
  // Pre-split lines so we can estimate height before committing to a y-position
  const verseLines = cleanedText.split(/\n/).filter((l) => l.trim().length > 0);

  // Push to a fresh page if the block fits on one page but would otherwise split
  const lineH = tpl.scriptureFontSize * 1.6 + 4;
  const refH = quote.reference ? (tpl.scriptureFontSize - 1.5) * 2.5 + 12 : 0;
  const estimatedH = 14 + verseLines.length * lineH + refH + 14;
  const pageContentH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < estimatedH && estimatedH <= pageContentH * 0.85) {
    doc.addPage();
    doc.x = doc.page.margins.left;
    layout = getScriptureLayout(); // Recalculate for new page
  }

  doc.moveDown(0.75);

  // When PDFKit auto-breaks to a new page mid-block it resets doc.x to the left margin.
  // This listener restores the scripture indent and recalculates layout for the new page.
  const _restoreIndent = () => { 
    layout = getScriptureLayout();
    doc.x = layout.textX;
  };
  doc.on("pageAdded", _restoreIndent);

  // Verse text — indented italic, no sidebar
  verseLines.forEach((line, i) => {
    doc
      .fontSize(tpl.scriptureFontSize)
      .font(fonts.serifItalic)
      .fillColor("#1a1a1a")
      .text(line.trim(), layout.textX, undefined, { width: layout.textWidth, lineGap: 5, align: "left", continued: false });
    if (i < verseLines.length - 1) doc.moveDown(0.1);
  });

  doc.removeListener("pageAdded", _restoreIndent);

  // Reference line: em-dash · reference · optional translation — right-aligned, accent colour
  const reference = formatScriptureReference(quote.reference, quote.translation);
  if (reference) {
    // Recalculate layout in case reference is on a new page
    layout = getScriptureLayout();
    doc
      .moveDown(0.25)
      .fontSize(tpl.scriptureFontSize - 1.5)
      .font(fonts.serifBold)
      .fillColor(tpl.accentColor)
      .text(reference, doc.page.margins.left, undefined, { align: "right", width: layout.contentWidth });
  }

  doc.moveDown(0.75);
  // Reset X position to left margin after scripture block to prevent margin carryover
  doc.x = doc.page.margins.left;
}

/**
 * Normalize paragraph breaks in LLM-generated body text.
 *
 * Handles two structural artifacts only — the AI owns paragraph decisions:
 *   1. LLM outputs \n (single newline) inside JSON strings instead of \n\n —
 *      sentence-ending punctuation + \n + capital letter is expanded to \n\n.
 *   2. 3+ consecutive blank lines collapsed to 2.
 *
 * No mechanical word-count splitting is applied. The AI decides every break.
 */
function normalizeParagraphBreaks(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([.!?'"\u201d])\n(?!\n)(?=[A-Z\u201c])/g, "$1\n\n")
    .trim();
}
/**
 * Strip markdown syntax so PDFKit renders plain text instead of raw markers.
 *
 * - Heading lines (## / ###) are dropped entirely — the heading was already
 *   rendered above the body by writeChapter / writeFrontMatter.
 * - Horizontal rule lines are dropped.
 * - Blockquote markers (> or > >) are stripped from line starts.
 * - Bold (** / __) and italic (* / _) markers are removed, preserving the
 *   inner text so emphasis words still appear — just not surrounded by *.
 */
function stripMarkdownForPdf(paragraph: string): string {
  const trimmed = paragraph.trim();
  if (/^#{1,6}\s+/.test(trimmed)) return ""; // heading line — drop
  if (/^[-*_]{3,}\s*$/.test(trimmed)) return ""; // horizontal rule — drop
  return paragraph
    // Strip blockquote markers (> or > >) at the start of lines
    .split("\n")
    .map((line) => line.replace(/^(>\s*)+/, ""))
    .join("\n")
    .replace(/\*\*\*(.+?)\*\*\*/gs, "$1")          // bold-italic
    .replace(/\*\*(.+?)\*\*/gs, "$1")              // bold
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1") // italic
    .replace(/__(.+?)__/gs, "$1")                  // bold underscore
    .replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "$1")    // italic underscore
    .trim();
}

/**
 * Apply smart typography to manuscript text before rendering.
 * Converts straight quotes → curly, double-hyphens → em-dash, ... → ellipsis.
 * Called on each paragraph in PDF, DOCX, and EPUB renderers before inline
 * markup is parsed, so the typographic glyphs appear in the final output.
 */
function applySmartTypography(text: string): string {
  return text
    // Em-dash: double hyphen (with or without surrounding spaces)
    .replace(/\s*--\s*/g, "\u2014")
    // Ellipsis
    .replace(/\.{3}/g, "\u2026")
    // Opening double quote: preceded by whitespace, em-dash, open bracket/paren, or line start
    .replace(/(^|[\s\u2014(\[{])"(?=\S)/gm, "$1\u201c")
    // Remaining double quotes → closing curly
    .replace(/"/g, "\u201d")
    // Opening single quote: preceded by whitespace, em-dash, open bracket/paren, or line start
    .replace(/(^|[\s\u2014(\[{])'(?=\S)/gm, "$1\u2018")
    // Remaining single quotes → closing curly / apostrophe
    .replace(/'/g, "\u2019");
}

/**
 * Pre-process inline scripture citations in manuscript text.
 * Ensures verse text is wrapped in *italic* and the reference in **bold**
 * before run-based rendering (PDF and DOCX).
 *
 * Two patterns handled:
 *   Pass 1 — parenthetical (reference AFTER quote):
 *     *"verse text"* (John 3:16, NIV)  →  *"verse"* **(John 3:16, NIV)**
 *     "verse text"  (1 Corinthians 13:4)  →  *"verse"* **(1 Cor 13:4)**
 *
 *   Pass 2 — pre-citation (reference BEFORE quote, preaching/teaching style):
 *     Hebrews 7:26: "For such a high priest…"  →  **Hebrews 7:26** *"For such…"*
 *     1 Peter 1:24. "For all flesh…"          →  **1 Peter 1:24** *"For all flesh…"*
 */
function markInlineScriptureRefs(text: string): string {
  // Non-breaking spaces inside a reference keep the entire citation on one line,
  // preventing PDFKit's justify algorithm from stretching the gap between e.g.
  // "Matthew" and "5:45" when only those two tokens occupy a justified line.
  const nbsRef = (ref: string) => ref.replace(/\s/g, "\u00A0");

  // Pass 1: reference in parentheses after the quoted verse
  let result = text.replace(
    /(\*?["\u201c][^\u201d"\n]{4,}["\u201d]\*?)\s*(\([A-Z1-9][^)\n]{3,}\d+[^)\n]*\))/g,
    (_, quote, ref) => {
      const rawQuote = quote.replace(/^\*|\*$/g, "");
      return `*${rawQuote}* **${nbsRef(ref)}**`;
    },
  );
  // Pass 2: pre-citation — BibleRef [optional connecting phrase up to 80 chars] "verse text"
  // The broader connector `[^"\u201c\n]{0,80}?` catches all preaching styles:
  //   Hebrews 7:26: "For such a high priest…"      (direct colon)
  //   Colossians 1:12-14 puts it this way: "For he…" (phrase + colon)
  //   1 Cor 1:30, he wrote, "It is because…"       (comma phrase)
  result = result.replace(
    /\b((?:[1-9]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:[-\u2013]\d+)?)[^"\u201c\n]{0,80}?(["\u201c][^\u201d"\n]{4,}["\u201d])/g,
    (_, ref, quote) => `**${nbsRef(ref)}** *${quote}*`,
  );
  return result;
}

/**
 * Split a paragraph into styled runs for mixed-font PDFKit rendering.
 * Returns an empty array when the paragraph is a heading or horizontal rule.
 */
function parseRunsForPdf(text: string): Array<{ text: string; italic?: boolean; bold?: boolean }> {
  const trimmed = text.trim();
  if (/^#{1,6}\s+/.test(trimmed)) return [];      // heading line — drop
  if (/^[-*_]{3,}\s*$/.test(trimmed)) return [];  // horizontal rule — drop
  const runs: Array<{ text: string; italic?: boolean; bold?: boolean }> = [];
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|__(.+?)__|(?<!_)_([^_\n]+?)_(?!_))/gs;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push({ text: text.slice(lastIndex, match.index) });
    if (match[2])      runs.push({ text: match[2], bold: true, italic: true });
    else if (match[3]) runs.push({ text: match[3], bold: true });
    else if (match[4]) runs.push({ text: match[4], italic: true });
    else if (match[5]) runs.push({ text: match[5], bold: true });
    else if (match[6]) runs.push({ text: match[6], italic: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex) });
  return runs.length > 0 ? runs : [{ text }];
}

/**
 * Renders a multi-run paragraph (bold + italic inline markup) with correct
 * justified text by composing lines manually.
 *
 * PDFKit's built-in justify + continued:true calculates word-spacing per-run
 * against the FULL line width, not the remaining space, causing extreme gaps
 * around short inline segments (e.g. a bold scripture reference). This function
 * fixes that by:
 *   1. Tokenising all runs into word/space tokens preserving font info.
 *   2. Greedy-wrapping tokens into lines using measured widths.
 *   3. Rendering each line at an explicit y with manually-calculated per-space
 *      extra width so the result is indistinguishable from native PDFKit justify.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeRunsParagraph(
  doc: any,
  runs: Array<{ text: string; italic?: boolean; bold?: boolean }>,
  fonts: PdfFontSet,
  fontSize: number,
  leftX: number,
  lineWidth: number,
  lineGap: number,
  paragraphGap: number,
  firstLineIndent: number,
  align: string,
): void {
  type Tok = { t: string; w: number; sp: boolean; font: string };
  const tokens: Tok[] = [];
  for (const run of runs) {
    const font = run.bold ? fonts.serifBold : run.italic ? fonts.serifItalic : fonts.serif;
    for (const part of run.text.split(/(\s+)/).filter(Boolean)) {
      doc.font(font).fontSize(fontSize);
      tokens.push({ t: part, w: doc.widthOfString(part), sp: /^\s+$/.test(part), font });
    }
  }

  // Greedy line-wrap
  const lines: Tok[][] = [];
  let cur: Tok[] = [], curW = 0, firstUsed = false;
  for (const tok of tokens) {
    const avail = lineWidth - (!firstUsed ? firstLineIndent : 0);
    if (!tok.sp && cur.length > 0 && curW + tok.w > avail) {
      while (cur.length > 0 && cur[cur.length - 1].sp) cur.pop();
      lines.push([...cur]);
      cur = []; curW = 0; firstUsed = true;
    }
    if (!tok.sp || cur.length > 0) { cur.push(tok); curW += tok.w; }
  }
  while (cur.length > 0 && cur[cur.length - 1].sp) cur.pop();
  if (cur.length > 0) lines.push(cur);
  if (lines.length === 0) return;

  // Exact line height from font metrics (no gap; we add lineGap manually)
  doc.font(fonts.serif).fontSize(fontSize);
  const lineH = doc.currentLineHeight(false);

  let lastY = doc.y;
  let pageJustBroke = false;
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const isLastLine = li === lines.length - 1;
    const isFirstLine = li === 0;
    
    // Page break before this line if it won't fit
    if (doc.y + lineH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.x = doc.page.margins.left;
      pageJustBroke = true;
    }
    lastY = doc.y;

    // After page break, force no indent for continuation line
    const indent = pageJustBroke ? 0 : (isFirstLine ? firstLineIndent : 0);
    pageJustBroke = false;
    const currentLeftX = doc.page.margins.left;
    const startX = currentLeftX + indent;
    const avail = lineWidth - indent;

    // Per-space extra width for justify (not on the last line)
    let spExtra = 0;
    if (align === 'justify' && !isLastLine) {
      const totalW = ln.reduce((s, t) => s + t.w, 0);
      const spCount = ln.filter(t => t.sp).length;
      if (spCount > 0) spExtra = Math.max(0, (avail - totalW) / spCount);
    }

    // Render: skip space tokens (advance x only), render word tokens at explicit position
    let x = startX;
    for (const tok of ln) {
      if (tok.sp) { x += tok.w + spExtra; continue; }
      doc.font(tok.font).fontSize(fontSize).fillColor('#1a1a1a');
      doc.text(tok.t, x, lastY, { lineBreak: false });
      x += tok.w;
    }

    if (!isLastLine) {
      doc.y = lastY + lineH + lineGap;
      doc.x = doc.page.margins.left;
    }
  }

  // Advance past the paragraph
  doc.y = lastY + lineH + paragraphGap;
  doc.x = doc.page.margins.left;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeRichBody(doc: any, text: string, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, options?: { italicFirstParagraph?: boolean; noIndentFirstParagraph?: boolean; smallCapOpener?: boolean }, bodyFontSize?: number) {
  const fontSize = bodyFontSize ?? tpl.bodyFontSize;
  const paragraphs = normalizeParagraphBreaks(text).split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  // Track rendered index separately so dropped heading lines don't shift the
  // firstParagraph italic treatment onto the wrong paragraph.
  let renderedIndex = 0;
  // Track when we just rendered a block element (scripture/blockquote) so the next
  // paragraph can be set flush-left with no indent (standard book typography convention).
  let justRenderedBlock = false;
  paragraphs.forEach((paragraph) => {
    // Reset X position at the start of each paragraph to prevent carryover
    doc.x = doc.page.margins.left;
    
    // Detect AI-generated markdown blockquotes (> prefix) first
    const markdownQuote = parseMarkdownBlockquote(paragraph);
    if (markdownQuote) {
      writeScriptureBlock(doc, markdownQuote, fonts, tpl);
      renderedIndex++;
      justRenderedBlock = true; // Next paragraph should have no indent
      return;
    }
    const matchingQuote = findMatchingBlockQuote(paragraph, quotes);
    if (matchingQuote) {
      writeScriptureBlock(doc, matchingQuote, fonts, tpl);
      renderedIndex++;
      justRenderedBlock = true; // Next paragraph should have no indent
      return;
    }

    // Industry standard: no indent for first paragraph OR first paragraph after block elements
    const noIndentFirst = options?.noIndentFirstParagraph !== false;
    const indent = (noIndentFirst && renderedIndex === 0) || justRenderedBlock ? 0 : tpl.paragraphIndent;
    justRenderedBlock = false; // Reset after applying
    const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const textOpts = { width: contentW, lineGap: tpl.bodyLineGap, indent, paragraphGap: tpl.paragraphGap, align: tpl.bodyAlign };

    // ── Amendment 5: Widow / orphan protection ────────────────────────────────
    // Estimate how many lines this paragraph needs. If only 1–2 lines would fit
    // on the remaining page space (orphan) or the paragraph is short enough to
    // fit entirely on the next page (widow — last line would be alone), force a
    // page break before rendering so the paragraph starts fresh on a new page.
    {
      const lineH   = fontSize + tpl.bodyLineGap;
      const pageBottom = doc.page.height - doc.page.margins.bottom;
      const remaining  = pageBottom - doc.y;
      const contentW   = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const cleanForEst = stripMarkdownForPdf(applySmartTypography(paragraph));
      if (cleanForEst) {
        doc.font(fonts.serif).fontSize(fontSize);
        // Rough character-based line estimate (faster than widthOfString per word)
        const charsPerLine = Math.max(1, Math.floor((contentW - indent) / (fontSize * 0.52)));
        const estimatedLines = Math.ceil(cleanForEst.length / charsPerLine);

        // Orphan guard: if fewer than 2 full lines would fit, push to new page
        const linesFit = Math.floor(remaining / lineH);
        if (linesFit < 2 && estimatedLines > 2) {
          doc.addPage();
          doc.x = doc.page.margins.left;
        }
        // Widow guard: if paragraph is 2–3 lines total and only 1 line fits,
        // push the whole paragraph to a new page so it's never split 1+rest.
        if (estimatedLines <= 3 && linesFit < estimatedLines) {
          doc.addPage();
          doc.x = doc.page.margins.left;
        }
      }
    }

    // Small-cap chapter opener: first 5 words uppercase + letter-spacing (traditional chapter opener)
    if (options?.smallCapOpener && renderedIndex === 0) {
      const clean = stripMarkdownForPdf(applySmartTypography(paragraph));
      if (!clean) return;
      const words = clean.split(/\s+/);
      const capCount = Math.min(5, words.length);
      const capText = words.slice(0, capCount).join(" ").toUpperCase();
      const restText = words.slice(capCount).join(" ");
      const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const capOpts = { width: contentW, lineGap: tpl.bodyLineGap, indent: 0, paragraphGap: tpl.paragraphGap, align: tpl.bodyAlign as "left" | "justify" | "right" | "center" };
      doc.fontSize(fontSize - 0.5).font(fonts.serifBold).fillColor("#1a1a1a")
        .text(restText ? capText + " " : capText, doc.page.margins.left, undefined, { ...capOpts, continued: restText.length > 0 });
      if (restText) {
        doc.fontSize(fontSize).font(fonts.serif).fillColor("#1a1a1a")
          .text(restText, { ...capOpts, continued: false });
      }
      renderedIndex++;
      return;
    }

    // Italic-first-paragraph (chapter intro): strip markdown and render whole paragraph in italic
    if (options?.italicFirstParagraph && renderedIndex === 0) {
      const cleanParagraph = stripMarkdownForPdf(applySmartTypography(paragraph));
      if (!cleanParagraph) return;
      const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.fontSize(fontSize).font(fonts.serifItalic).fillColor("#333333")
        .text(cleanParagraph, doc.page.margins.left, undefined, { ...textOpts, width: contentW });
      renderedIndex++;
      return;
    }

    // Regular paragraphs: render inline bold/italic markup so scripture is italic
    // and scripture references (John 3:16) are bolded.
    const preprocessed = markInlineScriptureRefs(applySmartTypography(paragraph));
    const runs = parseRunsForPdf(preprocessed);
    if (runs.length === 0) return; // heading or rule line — dropped

    if (runs.length === 1) {
      // Single run — PDFKit's native rendering is fine (no multi-font justify issue)
      const font = runs[0].bold ? fonts.serifBold : runs[0].italic ? fonts.serifItalic : fonts.serif;
      doc.fontSize(fontSize).font(font).fillColor("#1a1a1a");
      doc.text(runs[0].text, doc.page.margins.left, undefined, textOpts);
    } else {
      // Multi-run — use manual line composition so justify word-spacing is correct
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      writeRunsParagraph(
        doc, runs, fonts, fontSize,
        doc.page.margins.left, contentWidth,
        tpl.bodyLineGap, tpl.paragraphGap,
        indent, tpl.bodyAlign,
      );
    }
    renderedIndex++;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeCopyrightPage(doc: any, manifest: EbookManifest, fonts: PdfFontSet, tpl: BookTemplateConfig) {
  const year = new Date().getFullYear();
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // Position copyright block about 30% down the page (back of title — intentionally sparse)
  doc.y = Math.round(doc.page.height * 0.30);
  doc
    .fontSize(9).font(fonts.serifBold).fillColor("#1a1a1a")
    .text(`${manifest.bookTitle}${manifest.subtitle ? `: ${manifest.subtitle}` : ""}`, { width: textW });
  doc.moveDown(0.6)
    .fontSize(9).font(fonts.serif)
    .text(`Copyright \u00A9 ${year} by ${manifest.authorName}`, { width: textW });
  doc.moveDown(1)
    .text(
      "All rights reserved. No part of this publication may be reproduced, distributed, " +
      "or transmitted in any form or by any means, including photocopying, recording, or " +
      "other electronic or mechanical methods, without the prior written permission of " +
      "the publisher, except in the case of brief quotations embodied in critical reviews " +
      "and certain other noncommercial uses permitted by copyright law.",
      { width: textW, lineGap: 2, align: "left" }
    );
  doc.moveDown(1.2)
    .fontSize(8).font(fonts.sans).fillColor("#666666")
    .text("Scripture quotations, unless otherwise indicated, are from the Holy Bible.", { width: textW });
  doc.moveDown(1)
    .fontSize(8).font(fonts.serif).fillColor("#333333")
    .text("First Edition", { width: textW });
  doc.moveDown(0.4)
    .text("Printed in the United States of America", { width: textW });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stampTOC(
  doc: any,
  tocAbsPageIndex: number,
  manifest: EbookManifest,
  chapterTocEntries: Array<{ chapterTitle: string; bodyPageNum: number }>,
  fonts: PdfFontSet,
  tpl: BookTemplateConfig,
  layout: { gutterMargin: number; outsideMargin: number; textW: number; pageW: number },
  tocPageIsVerso: boolean,
) {
  doc.switchToPage(tocAbsPageIndex);
  const mL  = tocPageIsVerso ? layout.outsideMargin : layout.gutterMargin;
  const mR  = tocPageIsVerso ? layout.gutterMargin  : layout.outsideMargin;
  const textW = layout.textW;
  const topY  = doc.page.margins.top + 4;
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 12;

  // Heading
  let y = topY;
  doc
    .fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor)
    .text("Contents", mL, y, { width: textW, align: tpl.matterTitleAlign, lineBreak: false });
  y += tpl.matterTitleSize + 14;

  // Divider
  if (tpl.showDivider) {
    doc.moveTo(mL, y).lineTo(layout.pageW - mR, y).strokeColor(tpl.dividerColor).lineWidth(0.5).stroke();
    y += 10;
  } else {
    y += 8;
  }

  const entrySize  = 10;
  const lineH      = entrySize + 7;
  const mutedColor = "#888888";

  // ── Amendment 6: dotted-leader row helper (Chicago Manual §1.4) ──────────
  // Renders: [numLabel] [chapterTitle] [....] [pageNum]
  // The dot string is computed via widthOfString("." ) so the fill is pixel-exact.
  // INDUSTRY UPGRADE: Fixed dot boundary to prevent overflow beyond page numbers
  function stampTocRow(
    numLabel: string,
    title: string,
    pageStr: string,
    rowY: number,
    bold: boolean,
  ) {
    doc.fontSize(entrySize).font(fonts.serif);
    const numW   = numLabel ? Math.ceil(doc.widthOfString(numLabel)) + 4 : 0;
    const pageNumW = Math.ceil(doc.widthOfString(pageStr));
    const titleFont = bold ? fonts.serifBold : fonts.serif;

    // Measure title in its actual font to know how wide it renders
    doc.font(titleFont).fontSize(entrySize);
    // Calculate exact space needed for page number first
    const pageNumActualW = Math.ceil(doc.widthOfString(pageStr));
    // Reserve generous space: title space, 16pt gap, dots area, 10pt gap, page number
    const maxTitleW = textW - numW - pageNumActualW - 80;
    let titleStr = title;
    while (titleStr.length > 1 && Math.ceil(doc.widthOfString(titleStr)) > maxTitleW) {
      titleStr = titleStr.slice(0, -1);
    }
    const actualTitleW = Math.ceil(doc.widthOfString(titleStr));

    // Render chapter number
    if (numLabel) {
      doc.font(fonts.serif).fillColor(mutedColor)
        .text(numLabel, mL, rowY, { width: numW, lineBreak: false });
    }

    // Render chapter title
    const titleX = mL + numW + (numLabel ? 2 : 0);
    doc.font(titleFont).fillColor(bold ? "#1a1a1a" : mutedColor)
      .text(titleStr, titleX, rowY, { width: maxTitleW, lineBreak: false });

    // Dotted leaders: strict boundary control to prevent overflow
    doc.font(fonts.serif).fontSize(entrySize - 1).fillColor("#bbbbbb");
    const dotW        = doc.widthOfString(".");
    const dotSpacing  = dotW + 2; // Slightly wider spacing
    const leaderStart = titleX + actualTitleW + 16; // 16pt gap after title
    const leaderEnd   = mL + textW - pageNumActualW - 10; // 10pt gap before page number
    const leaderSpan  = Math.max(0, leaderEnd - leaderStart);
    const dotCount    = Math.max(0, Math.floor(leaderSpan / dotSpacing));
    if (dotCount > 0) {
      const dotsStr = Array(dotCount).fill(".").join("\u2009"); // thin-space separated
      doc.text(dotsStr, leaderStart, rowY, { lineBreak: false, width: leaderSpan });
    }

    // Render page number flush-right with exact positioning
    const pageNumX = mL + textW - pageNumActualW;
    doc.font(fonts.serif).fontSize(entrySize).fillColor(mutedColor)
      .text(pageStr, pageNumX, rowY, { width: pageNumActualW, align: "right", lineBreak: false });
  }

  // Front matter (no page numbers)
  for (const label of ["Preface", "Introduction"]) {
    if (y > bottomLimit) break;
    doc.fontSize(entrySize).font(fonts.serifItalic).fillColor(mutedColor)
      .text(label, mL, y, { width: textW, lineBreak: false });
    y += lineH;
  }
  y += 6;

  // Chapters with dotted leaders + page numbers
  for (let i = 0; i < chapterTocEntries.length; i++) {
    if (y > bottomLimit) break;
    const { chapterTitle, bodyPageNum } = chapterTocEntries[i];
    stampTocRow(`${i + 1}.`, chapterTitle, String(bodyPageNum), y, true);
    y += lineH;
  }
  y += 6;

  // Back matter (no page numbers)
  const backLabels = ["Conclusion", ...(manifest.frontMatter.aboutAuthor ? ["About the Author"] : [])];
  for (const label of backLabels) {
    if (y > bottomLimit) break;
    doc.fontSize(entrySize).font(fonts.serifItalic).fillColor(mutedColor)
      .text(label, mL, y, { width: textW, lineBreak: false });
    y += lineH;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writePreface(doc: any, fm: FrontBackMatter, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Preface", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  writeRichBody(doc, fm.preface, quotes, fonts, tpl, { noIndentFirstParagraph: true }, bodyFontSize);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeIntroduction(doc: any, fm: FrontBackMatter, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Introduction", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  writeRichBody(doc, fm.introduction, quotes, fonts, tpl, { noIndentFirstParagraph: true }, bodyFontSize);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeChapter(doc: any, chapter: ChapterDraft, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // INDUSTRY UPGRADE: Enhanced chapter opener with more vertical breathing room
  doc.moveDown(tpl.chapterPreGap + 1.5);
  
  // Chapter number in small caps (industry standard)
  const chapterLabel = tpl.chapterLabel(chapter.number);
  doc.fontSize(tpl.chapterLabelSize - 1).font(fonts.sans).fillColor(tpl.chapterLabelColor)
    .text(chapterLabel.toUpperCase(), { width: textW, align: tpl.chapterLabelAlign, characterSpacing: 0.5 });
  
  // Increased spacing between label and title for elegance
  doc.moveDown(0.8)
    .fontSize(tpl.chapterTitleSize).font(fonts[tpl.chapterTitleFont]).fillColor(tpl.chapterTitleColor)
    .text(chapter.title, { width: textW, align: tpl.chapterTitleAlign });
  
  // More refined divider with increased spacing
  doc.moveDown(0.4);
  writeDivider(doc, tpl, ornamentStyle);
  doc.moveDown(0.4);


  // Epigraph (scripture quote) - lighter italic, centered
  if (chapter.epigraph) {
    doc.moveDown(0.3);
    const epigraphText = stripMarkdownForPdf(applySmartTypography(chapter.epigraph));
    doc.fontSize((bodyFontSize ?? tpl.bodyFontSize) - 0.5)
      .font(fonts.serifItalic)
      .fillColor("#444444")
      .text(epigraphText, doc.page.margins.left, undefined, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "center",
        lineGap: 5
      });
    doc.moveDown(0.8);
  }

  // Chapter intro ("northstar") - bold italic, centered, darker
  if (chapter.intro) {
    const introText = stripMarkdownForPdf(applySmartTypography(chapter.intro));
    doc.fontSize(bodyFontSize ?? tpl.bodyFontSize)
      .font(fonts.serifBold)
      .fillColor("#1a1a1a")
      .text(introText, doc.page.margins.left, undefined, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "center",
        lineGap: 6
      });
    doc.moveDown(1.2);
  }

  let _firstSectionDone = false;
  for (const section of chapter.sections) {
    // INDUSTRY STANDARD: Orphan prevention — if fewer than 5 body-line heights remain
    // on this page, start a new page. This prevents section headings from being stranded
    // at the bottom of a page with no body text following (Chicago Manual of Style §2.113).
    const _lineH = (bodyFontSize ?? tpl.bodyFontSize) + tpl.bodyLineGap;
    if (doc.page.height - doc.page.margins.bottom - doc.y < _lineH * 5) {
      doc.addPage();
      doc.x = doc.page.margins.left;
    }
    
    if (_firstSectionDone && section.heading?.trim()) {
      doc.moveDown(_firstSectionDone ? 0.8 : 0.4);
      doc
        .fontSize(tpl.sectionSize)
        .font(fonts[tpl.sectionFont])
        .fillColor(tpl.sectionColor)
        .text(stripMarkdownForPdf(applySmartTypography(section.heading.trim())), {
          width: textW,
          align: tpl.sectionAlign,
          lineGap: 2,
        });
      doc.moveDown(0.25);
    }

    // ── Amendment 4: Drop cap on the very first body paragraph of the chapter ──
    if (!_firstSectionDone && section.body) {
      const bodyFontSizeResolved = bodyFontSize ?? tpl.bodyFontSize;
      // Extract the first paragraph and render it as a drop cap, then render
      // the remaining paragraphs normally (no smallCapOpener since drop cap covers it).
      const firstParaBreak = normalizeParagraphBreaks(section.body).indexOf("\n\n");
      const firstPara = firstParaBreak >= 0
        ? normalizeParagraphBreaks(section.body).slice(0, firstParaBreak)
        : normalizeParagraphBreaks(section.body);
      const restBody = firstParaBreak >= 0
        ? normalizeParagraphBreaks(section.body).slice(firstParaBreak + 2)
        : "";
      writeDropCapParagraph(doc, firstPara.trim(), fonts, tpl, bodyFontSizeResolved);
      if (restBody.trim()) {
        writeRichBody(doc, restBody, quotes, fonts, tpl, { noIndentFirstParagraph: false }, bodyFontSize);
      }
    } else {
      writeRichBody(doc, section.body, quotes, fonts, tpl, { noIndentFirstParagraph: true, smallCapOpener: !_firstSectionDone }, bodyFontSize);
    }
    _firstSectionDone = true;
  }

  if (chapter.forwardQuestion) {
    writeDivider(doc, tpl);
    writeRichBody(doc, chapter.forwardQuestion, quotes, fonts, tpl, { italicFirstParagraph: true, noIndentFirstParagraph: true, align: "center" }, bodyFontSize);
  }

  if ((chapter.keyTakeaways ?? []).length > 0) {
    // Orphan prevention: keep heading with at least 3 bullet lines
    const _ktLineH = (bodyFontSize ?? tpl.bodyFontSize) + tpl.bodyLineGap;
    if (doc.page.height - doc.page.margins.bottom - doc.y < _ktLineH * 4) {
      doc.addPage();
      doc.x = doc.page.margins.left;
    }
    writeDivider(doc, tpl);
    const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.fontSize(tpl.sectionSize - 1).font(fonts[tpl.sectionFont]).fillColor(tpl.labelColor).text("KEY TAKEAWAYS", { width: textW });
    doc.moveDown(0.4);
    for (const t of (chapter.keyTakeaways ?? [])) {
      doc.fontSize(bodyFontSize ?? tpl.bodyFontSize).font(fonts.serif).fillColor("#222222").text(`• ${t}`, { width: textW, lineGap: tpl.bodyLineGap, paragraphGap: 4 });
    }
    doc.moveDown(0.5);
  }

  if ((chapter.reflectionQuestions ?? []).length > 0) {
    // Orphan prevention: keep heading with at least 3 question lines
    const _rqLineH = (bodyFontSize ?? tpl.bodyFontSize) + tpl.bodyLineGap;
    if (doc.page.height - doc.page.margins.bottom - doc.y < _rqLineH * 4) {
      doc.addPage();
      doc.x = doc.page.margins.left;
    }
    writeDivider(doc, tpl);
    const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.fontSize(tpl.sectionSize - 1).font(fonts[tpl.sectionFont]).fillColor(tpl.labelColor).text("REFLECTION QUESTIONS", { width: textW });
    doc.moveDown(0.4);
    (chapter.reflectionQuestions ?? []).forEach((q, i) => {
      doc.fontSize(bodyFontSize ?? tpl.bodyFontSize).font(fonts.serif).fillColor("#222222").text(`${i + 1}. ${q}`, { width: textW, lineGap: tpl.bodyLineGap, paragraphGap: 4 });
    });
    doc.moveDown(0.5);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeConclusion(doc: any, fm: FrontBackMatter, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Conclusion", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  writeRichBody(doc, fm.conclusion, quotes, fonts, tpl, { noIndentFirstParagraph: true }, bodyFontSize);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeAboutAuthor(doc: any, fm: FrontBackMatter, quotes: Quote[], fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("About the Author", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  if (fm.aboutAuthor) {
    writeRichBody(doc, fm.aboutAuthor, quotes, fonts, tpl, { noIndentFirstParagraph: true }, bodyFontSize);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeResources(doc: any, fm: FrontBackMatter, fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Resources", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  for (const r of (fm.resourcesList ?? [])) {
    doc.fontSize(bodyFontSize ?? tpl.bodyFontSize).font(fonts.serif).fillColor("#1a1a1a").text(`• ${r}`, { width: textW, lineGap: 3.5 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeGlossary(doc: any, bm: BackMatter, fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Glossary", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  const fs = bodyFontSize ?? tpl.bodyFontSize;
  for (const entry of (bm.glossary ?? [])) {
    doc.fontSize(fs).font(fonts.serifBold).fillColor("#1a1a1a").text(entry.term, { width: textW, lineGap: 2 });
    doc.fontSize(fs - 1).font(fonts.serif).fillColor("#333333").text(entry.definition, { width: textW, lineGap: 3 });
    doc.fontSize(fs - 2).font(fonts.serifItalic ?? fonts.serif).fillColor("#666666").text(entry.firstAppearance, { width: textW, lineGap: 8 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeReadingGroupGuide(doc: any, bm: BackMatter, fonts: PdfFontSet, tpl: BookTemplateConfig, ornamentStyle: "rule" | "fleuron" | "asterism" | "dinkus" | "none", bodyFontSize?: number) {
  doc.addPage();
  doc.x = doc.page.margins.left;
  const textW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fontSize(tpl.matterTitleSize).font(fonts.serifBold).fillColor(tpl.chapterTitleColor).text("Reading Group Guide", { width: textW, align: tpl.matterTitleAlign });
  writeDivider(doc, tpl, ornamentStyle);
  const fs = bodyFontSize ?? tpl.bodyFontSize;
  for (const chapter of (bm.readingGroupGuide ?? [])) {
    doc.fontSize(fs + 1).font(fonts.serifBold).fillColor(tpl.chapterTitleColor)
      .text(`Chapter ${chapter.chapterNumber}: ${chapter.chapterTitle}`, { width: textW, lineGap: 4 });
    chapter.questions.forEach((q, i) => {
      doc.fontSize(fs).font(fonts.serif).fillColor("#1a1a1a")
        .text(`${i + 1}. ${q}`, { width: textW, lineGap: 5, indent: 8 });
    });
    doc.moveDown(0.5);
  }
}

// ─── EPUB Helpers ─────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escapes HTML special characters in a string that already contains safe
 * <em> / <strong> / <br> tags injected by our own markdown converter.
 * Those tags are preserved; only the text nodes between them are escaped.
 */
function escapeHtmlPreservingEmStrong(str: string): string {
  // Split on the tags we intentionally injected, escape text segments, rejoin.
  return str
    .split(/(<\/?(?:em|strong|br)>)/g)
    .map((part, i) => (i % 2 === 0 ? escapeHtml(part) : part))
    .join("");
}

function paragraphsToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join("\n");
}

// Wraps inline scripture citations with <span> for premium italic/bold styling.
// Three-pass approach:
//   Pass 1 — verse in <em> (already italic from *markdown*), parenthetical ref after
//   Pass 2 — bare quoted verse, parenthetical ref after
//   Pass 3 — pre-citation style: BibleRef[: or .] "verse text" (ref before quote)
function markupInlineScripture(html: string): string {
  // Pass 1: verse already inside <em>…</em>; </em> sits between closing quote and
  // (reference) so a single regex would miss it. Just attach the ref span.
  let result = html.replace(
    /(<em>(?:&ldquo;|&quot;|\u201c)[^\u201d&]{4,}(?:&rdquo;|&quot;|\u201d)<\/em>)\s*(\([A-Z1-9][^)]{3,}\d+[^)]*\))/g,
    (_, verse, ref) => `${verse}<span class="scripture-inline-ref"> ${ref}</span>`,
  );
  // Pass 2: bare quoted verse — add italic class and bold ref span.
  result = result.replace(
    /((?:&ldquo;|&quot;|\u201c)[^\u201d&]{4,}(?:&rdquo;|&quot;|\u201d))\s*(\([A-Z1-9][^)]{3,}\d+[^)]*\))/g,
    (_, verse, ref) =>
      `<span class="scripture-inline">${verse}</span><span class="scripture-inline-ref"> ${ref}</span>`,
  );
  // Pass 3: pre-citation style — BibleRef [optional connecting phrase up to 80 chars] "verse text"
  // Broadened connector `[^\u201c"\n]{0,80}?` catches phrases like "puts it this way:"
  result = result.replace(
    /\b((?:[1-9]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d+:\d+(?:[-\u2013]\d+)?)[^\u201c"\n]{0,80}?((?:&ldquo;|&quot;|\u201c)[^\u201d&\n]{4,}(?:&rdquo;|&quot;|\u201d))/g,
    (_, ref, verse) =>
      `<span class="scripture-inline-ref">${ref}</span> <span class="scripture-inline">${verse}</span>`,
  );
  return result;
}

function quoteParagraphsToHtml(text: string, quotes: Quote[], options?: { italicFirstParagraph?: boolean }): string {
  const paragraphs = normalizeParagraphBreaks(text).split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  let renderedIndex = 0;
  return paragraphs.map((paragraph) => {
    // Detect AI-generated markdown blockquotes (> prefix) first — these are the most
    // reliable because they come directly from the model output.
    const markdownQuote = parseMarkdownBlockquote(paragraph);
    if (markdownQuote) {
      const verseLines = markdownQuote.text.split(/\n/).filter((l) => l.trim());
      const verseHtml = verseLines.map((l) => `<span class="verse-line">${escapeHtml(l.trim())}</span>`).join("\n");
      const refText = formatScriptureReference(markdownQuote.reference, markdownQuote.translation).replace(/\u2014/, "&mdash;");
      renderedIndex++;
      return `<blockquote class="scripture-block"><div class="scripture-verse">${verseHtml}</div>${refText ? `<div class="scripture-ref">${escapeHtml(refText)}</div>` : ""}</blockquote>`;
    }
    const matchingQuote = findMatchingBlockQuote(paragraph, quotes);
    if (matchingQuote) {
      const verseLines = matchingQuote.text.split(/\n/).filter((l) => l.trim());
      const verseHtml = verseLines.map((l) => `<span class="verse-line">${escapeHtml(l.trim())}</span>`).join("\n");
      const refText = formatScriptureReference(matchingQuote.reference, matchingQuote.translation).replace(/\u2014/, "&mdash;");
      renderedIndex++;
      return `<blockquote class="scripture-block"><div class="scripture-verse">${verseHtml}</div>${refText ? `<div class="scripture-ref">${escapeHtml(refText)}</div>` : ""}</blockquote>`;
    }

    // Drop markdown heading lines — they duplicate the section heading already
    // rendered by the EPUB chapter structure above the body.
    if (/^#{1,6}\s+/.test(paragraph)) return "";
    // Drop bare horizontal rules
    if (/^[-*_]{3,}\s*$/.test(paragraph)) return "";

    // Convert inline markdown to HTML tags so *word* renders as <em>word</em>
    // instead of appearing with literal asterisks in the EPUB reader.
    // Apply BEFORE escapeHtml because escapeHtml doesn’t touch * characters,
    // so the order is: markdown→HTML tags, then escapeHtml for the text content.
    const withHtmlMarkup = paragraph
      .replace(/\*\*\*(.+?)\*\*\*/gs, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")
      .replace(/__(.+?)__/gs, "<strong>$1</strong>")
      .replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "<em>$1</em>");

    const classes = ["book-paragraph"];
    if (renderedIndex === 0) classes.push("no-indent");
    if (options?.italicFirstParagraph && renderedIndex === 0) classes.push("chapter-intro");
    // markupInlineScripture + escapeHtml work on the tag-converted string.
    // Text nodes inside our injected tags were not yet escaped, so run a targeted
    // escape that preserves the <em>/<strong> wrapper tags we just added.
    const escapedPara = markupInlineScripture(escapeHtmlPreservingEmStrong(withHtmlMarkup));
    renderedIndex++;
    return `<p class="${classes.join(" ")}">${escapedPara}</p>`;
  }).filter(Boolean).join("\n");
}

function frontMatterChapters(fm: FrontBackMatter, quotes: Quote[]): Array<{ title: string; content: string }> {
  const chapters = [
    {
      title: "Preface",
      content: quoteParagraphsToHtml(fm.preface, quotes),
    },
    {
      title: "Introduction",
      content: quoteParagraphsToHtml(fm.introduction, quotes),
    },
  ];
  return chapters;
}

function chapterToHtml(chapter: ChapterDraft, quotes: Quote[]): string {
  const parts: string[] = [];

  // Epigraph (scripture quote) - lighter italic
  if (chapter.epigraph) {
    parts.push(`<p class="chapter-epigraph" style="text-align: center; font-style: italic; color: #666;">${escapeHtml(chapter.epigraph)}</p>`);
  }

  // Chapter intro (\"northstar\") - bold, centered
  if (chapter.intro) {
    parts.push(`<p class="chapter-intro" style="text-align: center; font-weight: bold;">${escapeHtml(chapter.intro)}</p>`);
  }

  // NO SECTION HEADINGS - skip section.heading rendering entirely
  for (const section of chapter.sections) {
    parts.push(quoteParagraphsToHtml(section.body ?? "", quotes));
  }

  if (chapter.forwardQuestion) {
    parts.push("<hr />");
    parts.push(`<p class="chapter-forward-question">${escapeHtml(chapter.forwardQuestion)}</p>`);
  }

  if ((chapter.keyTakeaways ?? []).length > 0) {
    parts.push("<h3>Key Takeaways</h3><ul>");
    for (const t of (chapter.keyTakeaways ?? [])) {
      parts.push(`<li>${escapeHtml(t)}</li>`);
    }
    parts.push("</ul>");
  }

  if ((chapter.reflectionQuestions ?? []).length > 0) {
    parts.push("<h3>Reflection Questions</h3><ol>");
    for (const q of (chapter.reflectionQuestions ?? [])) {
      parts.push(`<li>${escapeHtml(q)}</li>`);
    }
    parts.push("</ol>");
  }

  return parts.join("\n");
}

function backMatterChapters(fm: FrontBackMatter, quotes: Quote[], bm?: BackMatter | null): Array<{ title: string; content: string }> {
  const chapters: Array<{ title: string; content: string }> = [
    {
      title: "Conclusion",
      content: quoteParagraphsToHtml(fm.conclusion, quotes),
    },
  ];

  if (fm.aboutAuthor) {
    chapters.push({
      title: "About the Author",
      content: quoteParagraphsToHtml(fm.aboutAuthor, quotes),
    });
  }

  if ((fm.resourcesList ?? []).length > 0) {
    chapters.push({
      title: "Resources",
      content: `<ul>${(fm.resourcesList ?? []).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`,
    });
  }

  if (bm) {
    if ((bm.glossary ?? []).length > 0) {
      const glossaryHtml = (bm.glossary ?? []).map((entry) =>
        `<dt><strong>${escapeHtml(entry.term)}</strong></dt><dd>${escapeHtml(entry.definition)}<br/><em>${escapeHtml(entry.firstAppearance)}</em></dd>`
      ).join("");
      chapters.push({ title: "Glossary", content: `<dl>${glossaryHtml}</dl>` });
    }

    if ((bm.readingGroupGuide ?? []).length > 0) {
      const guideHtml = (bm.readingGroupGuide ?? []).map((chapter) => {
        const qs = chapter.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("");
        return `<h3>Chapter ${chapter.chapterNumber}: ${escapeHtml(chapter.chapterTitle)}</h3><ol>${qs}</ol>`;
      }).join("");
      chapters.push({ title: "Reading Group Guide", content: guideHtml });
    }

    if ((bm.scriptureIndex ?? []).length > 0) {
      const indexHtml = (bm.scriptureIndex ?? []).map((entry) =>
        `<li><strong>${escapeHtml(entry.reference)}</strong> (${escapeHtml(entry.translation)}) — Ch. ${entry.chapters.join(", ")}</li>`
      ).join("");
      chapters.push({ title: "Scripture Index", content: `<ul>${indexHtml}</ul>` });
    }
  }

  return chapters;
}

function buildEpubCss(tpl: BookTemplateConfig): string {
  const bodyAlign = tpl.bodyAlign === "justify" ? "justify" : "left";
  const indent = tpl.paragraphIndent > 0 ? `${(tpl.paragraphIndent / 12).toFixed(2)}em` : "0";
  const paraGap = tpl.paragraphGap > 0 ? `${(tpl.paragraphGap / 12).toFixed(2)}em` : "0";
  const sectionAlign = tpl.sectionAlign === "center" ? "center" : tpl.sectionAlign === "right" ? "right" : "left";
  const chapterAlign = tpl.chapterTitleAlign === "center" ? "center" : tpl.chapterTitleAlign === "right" ? "right" : "left";
  const hrColor = tpl.showDivider ? tpl.dividerColor : "transparent";
  const accentHex = tpl.chapterLabelColor;
  return `
body {
  font-family: Georgia, "Times New Roman", serif;
  color: #111111;
  line-height: ${(tpl.bodyLineGap / tpl.bodyFontSize + 1).toFixed(2)};
  font-size: 1em;
  margin: 6% 8%;
  text-align: ${bodyAlign};
  hyphens: auto;
  -webkit-hyphens: auto;
  adobe-hyphenate: auto;
  overflow-wrap: break-word;
  word-break: normal;
}
p.book-paragraph {
  margin: 0 0 ${paraGap} 0;
  text-indent: ${indent};
  widows: 2;
  orphans: 2;
}
p.book-paragraph.no-indent {
  text-indent: 0;
}
p.book-paragraph.chapter-intro {
  font-style: italic;
  color: #333333;
}
h1.chapter-title {
  text-align: ${chapterAlign};
  color: ${tpl.chapterTitleColor};
  font-size: 1.7em;
  margin-top: 0.5em;
  margin-bottom: 0.6em;
  page-break-before: always;
  break-before: always;
}
.chapter-label {
  display: block;
  text-align: ${chapterAlign};
  color: ${accentHex};
  font-size: 0.75em;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 0.25em;
}
h2 {
  margin-top: 2em;
  margin-bottom: 0.65em;
  font-size: 1.1em;
  text-align: ${sectionAlign};
  color: ${tpl.sectionColor};
  page-break-after: avoid;
  break-after: avoid;
  page-break-inside: avoid;
  break-inside: avoid;
}
h3 {
  margin-top: 1.25em;
  margin-bottom: 0.45em;
  font-size: 0.92em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
hr {
  border: 0;
  border-top: 1px solid ${hrColor};
  margin: 1.4em 0 1.1em;
}
ul, ol {
  margin: 0.35em 0 0.9em 1.2em;
  padding: 0;
}
li {
  margin: 0.2em 0;
}
blockquote.scripture-block {
  margin: 2em 0.25em 2em ${(tpl.scriptureIndent / 12).toFixed(2)}em;
  padding: 0.85em 0.5em 0.85em 1.4em;
  border: 0;
  border-left: 4px solid ${accentHex};
  background: transparent;
  page-break-inside: avoid;
  break-inside: avoid;
}
.scripture-verse {
  display: block;
  font-style: italic;
  font-size: ${(tpl.scriptureFontSize / tpl.bodyFontSize).toFixed(2)}em;
  line-height: 1.55;
  margin: 0;
  color: #1a1a1a;
  text-indent: 0;
}
.verse-line {
  display: block;
  margin-bottom: 0.15em;
}
.scripture-ref {
  display: block;
  margin-top: 0.65em;
  text-align: right;
  font-weight: 700;
  font-size: 0.8em;
  font-style: normal;
  color: ${accentHex};
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.scripture-translation {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  font-style: italic;
}
.scripture-inline {
  font-style: italic;
  color: #1a1a1a;
}
.scripture-inline-ref {
  font-weight: 600;
  font-size: 0.88em;
  color: ${accentHex};
  font-style: normal;
}
`;
}

// ─── EPUB Generator ───────────────────────────────────────────────────────────

export async function generateEpubBuffer(manifest: EbookManifest, templateId?: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const epub = (await import("epub-gen-memory") as any).default;
  const tpl = getTemplate(templateId ?? manifest.selectedTemplate);

  const chapters = [
    ...frontMatterChapters(manifest.frontMatter, manifest.allQuotes ?? []),
    ...manifest.chapters.map((ch) => ({
      title: `Chapter ${ch.number}: ${ch.title}`,
      content: chapterToHtml(ch, manifest.allQuotes ?? []),
    })),
    ...backMatterChapters(manifest.frontMatter, manifest.allQuotes ?? [], manifest.backMatter),
  ];

  const epubBuffer = await epub(
    {
      title: manifest.bookTitle,
      author: manifest.authorName,
      publisher: manifest.authorName,
      description: manifest.subtitle,
      date: new Date(manifest.generatedAt).getFullYear().toString(),
      lang: "en",
      tocTitle: "Table of Contents",
      css: buildEpubCss(tpl),
    },
    chapters
  );

  return Buffer.from(epubBuffer);
}

// ─── DOCX generation ─────────────────────────────────────────────────────────

export async function generateDocxBuffer(manifest: EbookManifest, templateId?: string): Promise<Buffer> {
  const { bookTitle, subtitle, authorName, frontMatter, chapters } = manifest;
  const tpl = getTemplate(templateId ?? manifest.selectedTemplate);

  // DOCX body always uses full justification — matches typeset book standard.
  // (tpl.bodyAlign controls PDF; DOCX is always JUSTIFIED for clean Word output.)
  const bodyAlign = AlignmentType.JUSTIFIED;
  const titleAlign = tpl.titlePageAlign === "center" ? AlignmentType.CENTER
    : tpl.titlePageAlign === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
  // Body font size in half-points (docx unit): bodyFontSize pt × 2
  const bodyHalfPt = Math.round(tpl.bodyFontSize * 2);
  // Paragraph spacing after (twips): paragraphGap pt × 20
  const paraSpacingAfter = Math.round(tpl.paragraphGap * 20);
  // Paragraph indent (twips): paragraphIndent pt × 20
  const paraIndentTwips = Math.round(tpl.paragraphIndent * 20);

  // Half-point size for scripture (typically 1pt smaller)
  const scriptureHalfPt = Math.round((tpl.bodyFontSize - 0.5) * 2);
  const scriptureRefHalfPt = Math.round((tpl.bodyFontSize - 2) * 2);
  const accentRgb = tpl.accentColor.replace("#", "");
  const scriptureIndentTwips = Math.round(tpl.scriptureIndent * 20);

  function docxScriptureBlock(quote: ScriptureQuote): Paragraph[] {
    // Clean the text: strip all markdown blockquote markers and artifacts
    const cleanedText = quote.text
      .split("\n")
      .map((line) => line.replace(/^(>\s*)+/, "").replace(/>\.?\s*/g, "").trim())
      .filter((l) => l.length > 0)
      .join("\n");
    
    const verseLines = cleanedText.split(/\n/).filter((l) => l.trim().length > 0);
    const verseParagraphs = verseLines.map((line) =>
      new Paragraph({
        // Amendment 4: named style for publisher editorial workflows
        style: "NxBlockQuote",
        children: [new TextRun({ text: line.trim(), italics: true, size: scriptureHalfPt })],
        alignment: AlignmentType.LEFT,
        spacing: { before: 40, after: 40 },
        indent: { left: scriptureIndentTwips, right: scriptureIndentTwips },
      })
    );
    const refParagraphs: Paragraph[] = [];
    const refText = formatScriptureReference(quote.reference, quote.translation);
    if (refText) {
      refParagraphs.push(
        new Paragraph({
          children: [new TextRun({ text: refText, bold: true, size: scriptureRefHalfPt, color: accentRgb })],
          alignment: AlignmentType.RIGHT,
          spacing: { before: 60, after: 200 },
        })
      );
    }
    return [...verseParagraphs, ...refParagraphs];
  }

  /**
   * Parses inline markdown in a paragraph into an array of TextRun objects with
   * proper bold/italic formatting so Word renders them correctly.
   * Handles ***bold-italic***, **bold**, *italic*, __bold__, _italic_.
   */
  function parseRunsForDocx(text: string, baseSize: number, allItalic = false): TextRun[] {
    const runs: TextRun[] = [];
    const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<!\*)\*([^*\n]+?)\*(?!\*)|__(.+?)__|(?<!_)_([^_\n]+?)_(?!_))/gs;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        runs.push(new TextRun({ text: text.slice(lastIndex, match.index), size: baseSize, italics: allItalic }));
      }
      if (match[2])      runs.push(new TextRun({ text: match[2], bold: true, italics: true, size: baseSize }));
      else if (match[3]) runs.push(new TextRun({ text: match[3], bold: true, italics: allItalic, size: baseSize }));
      else if (match[4]) runs.push(new TextRun({ text: match[4], italics: true, size: baseSize }));
      else if (match[5]) runs.push(new TextRun({ text: match[5], bold: true, italics: allItalic, size: baseSize }));
      else if (match[6]) runs.push(new TextRun({ text: match[6], italics: true, size: baseSize }));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      runs.push(new TextRun({ text: text.slice(lastIndex), size: baseSize, italics: allItalic }));
    }
    return runs.length > 0 ? runs : [new TextRun({ text, size: baseSize, italics: allItalic })];
  }

  function textToStyledParagraphs(text: string, noIndentFirst = false): Paragraph[] {
    return normalizeParagraphBreaks(text)
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean)
      .flatMap((para, i) => {
        // Drop heading lines — the section heading is already rendered above the body
        if (/^#{1,6}\s+/.test(para)) return [];
        // Drop horizontal rules
        if (/^[-*_]{3,}\s*$/.test(para)) return [];
        // Detect markdown blockquote for scripture
        const mdQuote = parseMarkdownBlockquote(para);
        if (mdQuote) return docxScriptureBlock(mdQuote);
        // Pre-process inline scripture: ensures *"verse"* **ref** markdown
        // so parseRunsForDocx renders verses italic and references bold.
        const processedPara = markInlineScriptureRefs(applySmartTypography(para));
        return [
          new Paragraph({
            // Amendment 4: named style — publisher editorial workflows (InDesign import, macros)
            style: "NxBodyText",
            children: parseRunsForDocx(processedPara, bodyHalfPt),
            alignment: bodyAlign,
            spacing: { after: paraSpacingAfter },
            indent: noIndentFirst && i === 0 ? undefined : { firstLine: paraIndentTwips },
          }),
        ];
      });
  }

  // ── Amendment 5 + 9: Per-chapter sections with running headers ───────────────
  // Build a helper for header paragraphs (book title verso, chapter title recto).
  // We use a single "default" header per section; Word alternating pages are
  // enabled via evenAndOddHeaderAndFooters on the document.
  const accentRgbClean = accentRgb; // already stripped of "#"

  function makeDocxHeader(bookTitleText: string, chapterTitleText: string): Header {
    const headerSize = 14; // 7pt — matches PDF running head
    return new Header({
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: bookTitleText.toUpperCase(), size: headerSize, color: "aaaaaa" }),
            new TextRun({ text: "\t", size: headerSize }),
            new TextRun({ text: chapterTitleText.toUpperCase(), size: headerSize, color: "aaaaaa" }),
          ],
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          spacing: { after: 60 },
          border: { bottom: { style: "single", size: 2, color: "dddddd", space: 4 } },
        }),
      ],
    });
  }

  function makeDocxFooter(): Footer {
    return new Footer({
      children: [
        new Paragraph({
          children: [
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "aaaaaa" }),
          ],
          alignment: AlignmentType.CENTER,
        }),
      ],
    });
  }

  // ── Front-matter children (title, copyright, TOC, preface, introduction) ──
  const frontChildren: (Paragraph | TableOfContents)[] = [];
  const year = new Date().getFullYear();

  // Title page
  frontChildren.push(
    new Paragraph({
      children: [new TextRun({ text: bookTitle, bold: true, size: Math.round(tpl.titlePageTitleSize * 2) })],
      heading: HeadingLevel.TITLE,
      alignment: titleAlign,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: subtitle, size: Math.round(tpl.titlePageSubtitleSize * 2), italics: true })],
      alignment: titleAlign,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: authorName, size: Math.round(tpl.titlePageAuthorSize * 2) })],
      alignment: titleAlign,
      spacing: { after: 600 },
    }),
    new Paragraph({ children: [new PageBreak()] })
  );

  // Copyright page
  frontChildren.push(
    new Paragraph({
      children: [new TextRun({ text: `${bookTitle}${subtitle ? `: ${subtitle}` : ""}`, bold: true, size: 18 })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Copyright \u00A9 ${year} by ${authorName}`, size: 18 })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "All rights reserved. No part of this publication may be reproduced, distributed, or transmitted in any form or by any means, including photocopying, recording, or other electronic or mechanical methods, without the prior written permission of the publisher, except in the case of brief quotations embodied in critical reviews and certain other noncommercial uses permitted by copyright law.", size: 16 })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "Scripture quotations, unless otherwise indicated, are from the Holy Bible.", italics: true, size: 14 })],
      spacing: { after: 80 },
    }),
    new Paragraph({ children: [new TextRun({ text: "First Edition", size: 14 })], spacing: { after: 40 } }),
    new Paragraph({ children: [new TextRun({ text: "Printed in the United States of America", size: 14 })], spacing: { after: 40 } }),
    new Paragraph({ children: [new PageBreak()] })
  );

  // Amendment 10 — Table of Contents with dotted leaders
  // Word generates dotted leaders from the TOC1 style's tab stop (defined below).
  frontChildren.push(
    new TableOfContents("Table of Contents", {
      hyperlink: true,
      headingStyleRange: "1-2",
      stylesWithLevels: [
        { styleName: "Heading 1", level: 1 },
        { styleName: "Heading 2", level: 2 },
      ],
      preserveTabInEntries: true,
      preserveNewLineInEntries: true,
    }),
    new Paragraph({ children: [new PageBreak()] })
  );

  // Preface + Introduction
  for (const { title, text } of [
    { title: "Preface", text: frontMatter.preface },
    { title: "Introduction", text: frontMatter.introduction },
  ]) {
    if (!text?.trim()) continue;
    frontChildren.push(
      new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 240 } }),
      ...textToStyledParagraphs(text, true),
      new Paragraph({ children: [new PageBreak()] })
    );
  }

  // ── Per-chapter children ──────────────────────────────────────────────────
  const chapterChildrenMap: Map<number, (Paragraph | TableOfContents)[]> = new Map();

  for (const chapter of chapters) {
    const cc: (Paragraph | TableOfContents)[] = [];

    cc.push(
      new Paragraph({
        // Amendment 4: named style for chapter label
        style: "NxChapterLabel",
        children: [new TextRun({ text: tpl.chapterLabel(chapter.number), size: Math.round(tpl.chapterLabelSize * 2), color: tpl.chapterLabelColor.replace("#", "") })],
        alignment: titleAlign,
        spacing: { before: 400, after: 80 },
      }),
      new Paragraph({
        children: [new TextRun({ text: chapter.title, bold: true, size: Math.round(tpl.chapterTitleSize * 2), color: tpl.chapterTitleColor.replace("#", "") })],
        heading: HeadingLevel.HEADING_1,
        alignment: titleAlign,
        spacing: { before: 0, after: 300 },
      })
    );

    // Epigraph (scripture quote) - lighter italic, centered
    if (chapter.epigraph?.trim()) {
      const cleanEpigraph = stripMarkdownForPdf(applySmartTypography(chapter.epigraph));
      cc.push(
        new Paragraph({
          children: [new TextRun({ text: cleanEpigraph, italics: true, size: bodyHalfPt - 1, color: "666666" })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 200 },
        })
      );
    }

    // Chapter intro ("northstar") - bold, centered, darker
    if (chapter.intro?.trim()) {
      const cleanIntro = stripMarkdownForPdf(applySmartTypography(chapter.intro));
      normalizeParagraphBreaks(cleanIntro)
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((introPara) => {
          cc.push(
            new Paragraph({
              children: [new TextRun({ text: introPara, bold: true, size: bodyHalfPt })],
              alignment: AlignmentType.CENTER,
              spacing: { before: 120, after: 240 },
            })
          );
        });
    }

    // NO SECTION HEADINGS - skip section.heading rendering entirely
    for (const section of chapter.sections) {
      cc.push(...textToStyledParagraphs(section.body, true));
    }

    if (chapter.forwardQuestion?.trim()) {
      cc.push(...textToStyledParagraphs(chapter.forwardQuestion, true).map((p) =>
        Object.assign(p, { alignment: AlignmentType.CENTER })
      ));
    }

    if ((chapter.keyTakeaways ?? []).length > 0) {
      cc.push(
        new Paragraph({
          children: [new TextRun({ text: "KEY TAKEAWAYS", bold: true, size: Math.round(tpl.bodyFontSize * 1.6), color: tpl.labelColor.replace("#", "") })],
          spacing: { before: 280, after: 120 },
        })
      );
      for (const t of (chapter.keyTakeaways ?? [])) {
        cc.push(
          new Paragraph({
            style: "NxBodyText",
            children: [new TextRun({ text: t, size: bodyHalfPt })],
            alignment: bodyAlign,
            spacing: { after: Math.round(paraSpacingAfter * 0.6) },
            numbering: { reference: "nxBullet", level: 0 },
          })
        );
      }
    }

    if ((chapter.reflectionQuestions ?? []).length > 0) {
      cc.push(
        new Paragraph({
          children: [new TextRun({ text: "REFLECTION QUESTIONS", bold: true, size: Math.round(tpl.bodyFontSize * 1.6), color: tpl.labelColor.replace("#", "") })],
          spacing: { before: 280, after: 120 },
        })
      );
      (chapter.reflectionQuestions ?? []).forEach((q) => {
        cc.push(
          new Paragraph({
            style: "NxBodyText",
            children: [new TextRun({ text: q, size: bodyHalfPt })],
            alignment: bodyAlign,
            spacing: { after: Math.round(paraSpacingAfter * 0.6) },
            numbering: { reference: "nxNumbered", level: 0 },
          })
        );
      });
    }

    chapterChildrenMap.set(chapter.number, cc);
  }

  // ── Back-matter children ──────────────────────────────────────────────────
  const backChildren: (Paragraph | TableOfContents)[] = [];

  if (frontMatter.conclusion?.trim()) {
    backChildren.push(
      new Paragraph({ text: "Conclusion", heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 240 } }),
      ...textToStyledParagraphs(frontMatter.conclusion, true),
    );
  }

  if (frontMatter.aboutAuthor?.trim()) {
    backChildren.push(
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ text: "About the Author", heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 240 } }),
      ...textToStyledParagraphs(frontMatter.aboutAuthor, true),
    );
  }

  if ((frontMatter.resourcesList ?? []).length > 0) {
    backChildren.push(
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ text: "Resources", heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 240 } })
    );
    for (const r of (frontMatter.resourcesList ?? [])) {
      backChildren.push(
        new Paragraph({
          style: "NxBodyText",
          children: [new TextRun({ text: r, size: bodyHalfPt })],
          alignment: bodyAlign,
          spacing: { after: Math.round(paraSpacingAfter * 0.6) },
          numbering: { reference: "nxBullet", level: 0 },
        })
      );
    }
  }

  // ── Build sections array ──────────────────────────────────────────────────
  // Amendment 5/9: each chapter is an isolated Word section (SectionType.ODD_PAGE)
  // so per-chapter headers work and editors can toggle header/footer per chapter.
  const docSections = [
    // Front matter section (no chapter-specific header)
    {
      headers: { default: makeDocxHeader(bookTitle, "Contents") },
      footers: { default: makeDocxFooter() },
      properties: {
        page: {
          margin: { top: 1134, right: 1080, bottom: 1440, left: 1260 }, // 6×9 trim margins in twips
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      children: frontChildren,
    },
    // Per-chapter sections
    ...chapters.map((chapter) => ({
      headers: { default: makeDocxHeader(bookTitle, chapter.title) },
      footers: { default: makeDocxFooter() },
      properties: {
        type: SectionType.ODD_PAGE,
        page: {
          margin: { top: 1134, right: 1080, bottom: 1440, left: 1260 },
          pageNumbers: { formatType: NumberFormat.DECIMAL },
        },
      },
      children: chapterChildrenMap.get(chapter.number) ?? [],
    })),
    // Back matter section
    ...(backChildren.length > 0 ? [{
      headers: { default: makeDocxHeader(bookTitle, "Notes") },
      footers: { default: makeDocxFooter() },
      properties: {
        type: SectionType.ODD_PAGE,
        page: {
          margin: { top: 1134, right: 1080, bottom: 1440, left: 1260 },
          pageNumbers: { formatType: NumberFormat.DECIMAL },
        },
      },
      children: backChildren,
    }] : []),
  ];

  const doc = new DocxDocument({
    evenAndOddHeaderAndFooters: true,
    sections: docSections,
    numbering: {
      config: [
        {
          reference: "nxBullet",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "nxNumbered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    // ── Amendment 4: Named paragraph styles for publisher editorial workflows ──
    // Publisher InDesign import scripts and editorial macros rely on these IDs.
    styles: {
      default: {
        document: {
          run: { size: bodyHalfPt },
          paragraph: { alignment: AlignmentType.JUSTIFIED },
        },
        heading1: {
          run: { size: Math.round(tpl.chapterTitleSize * 2), bold: true, color: tpl.chapterTitleColor.replace("#", "") },
          paragraph: { spacing: { before: 480, after: 240 } },
        },
        heading2: {
          run: { size: Math.round(tpl.sectionSize * 2), bold: true, color: tpl.sectionColor.replace("#", "") },
          paragraph: { spacing: { before: 320, after: 160 } },
        },
      },
      paragraphStyles: [
        // NxBodyText — main prose style used by all body paragraphs
        {
          id: "NxBodyText",
          name: "Nx Body Text",
          basedOn: "Normal",
          run: { size: bodyHalfPt, font: "Georgia" },
          paragraph: {
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: paraSpacingAfter, line: Math.round((tpl.bodyFontSize + tpl.bodyLineGap) * 20 * 0.55) },
            indent: { firstLine: paraIndentTwips },
          },
        },
        // NxBlockQuote — scripture / block quotation style
        {
          id: "NxBlockQuote",
          name: "Nx Block Quotation",
          basedOn: "Normal",
          run: { size: scriptureHalfPt, italics: true, font: "Georgia" },
          paragraph: {
            alignment: AlignmentType.LEFT,
            spacing: { before: 160, after: 200 },
            indent: { left: scriptureIndentTwips, right: scriptureIndentTwips },
          },
        },
        // NxChapterLabel — decorative chapter number / roman numeral
        {
          id: "NxChapterLabel",
          name: "Nx Chapter Label",
          basedOn: "Normal",
          run: { size: Math.round(tpl.chapterLabelSize * 2), color: accentRgbClean },
          paragraph: {
            alignment: tpl.chapterLabelAlign === "center" ? AlignmentType.CENTER
              : tpl.chapterLabelAlign === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT,
            spacing: { before: 480, after: 80 },
          },
        },
        // Amendment 10 — TOC 1 style with right-aligned dotted leader tab stop
        // Word's TableOfContents field reads this style to format top-level entries.
        {
          id: "toc 1",
          name: "toc 1",
          basedOn: "Normal",
          run: { size: bodyHalfPt, font: "Georgia" },
          paragraph: {
            spacing: { after: 120 },
            tabStops: [
              {
                type: TabStopType.RIGHT,
                position: TabStopPosition.MAX,
                leader: LeaderType.DOT,
              },
            ],
          },
        },
        // TOC 2 — section-level TOC entries (same treatment, slightly smaller)
        {
          id: "toc 2",
          name: "toc 2",
          basedOn: "Normal",
          run: { size: Math.round(tpl.bodyFontSize * 1.8), font: "Georgia" },
          paragraph: {
            spacing: { after: 80 },
            indent: { left: 360 },
            tabStops: [
              {
                type: TabStopType.RIGHT,
                position: TabStopPosition.MAX,
                leader: LeaderType.DOT,
              },
            ],
          },
        },
      ],
    },
  });

  return Packer.toBuffer(doc);
}
