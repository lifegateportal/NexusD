import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";
import {
  AlignmentType,
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { htmlToNexusLMDocumentText } from "@/lib/nexuslm-artifacts";

const CSS_PX_PER_INCH = 96;
const DEFAULT_PAGE_SIZE = { widthInches: 8.27, heightInches: 11.69 };
const DEFAULT_VIEWPORT = {
  width: Math.round(DEFAULT_PAGE_SIZE.widthInches * CSS_PX_PER_INCH),
  height: Math.round(DEFAULT_PAGE_SIZE.heightInches * CSS_PX_PER_INCH),
};
const MAX_RENDERED_HEIGHT_PX = 120_000;
const RENDER_TIMEOUT_MS = 30_000;

type PageSize = {
  widthInches: number;
  heightInches: number;
};

type RenderedHtmlPages = {
  pages: Buffer[];
  pageSize: PageSize;
};

const KNOWN_PAGE_SIZES: Record<string, PageSize> = {
  a4: { widthInches: 8.27, heightInches: 11.69 },
  letter: { widthInches: 8.5, heightInches: 11 },
  legal: { widthInches: 8.5, heightInches: 14 },
};

function parseLength(value: string): number | null {
  const match = value.trim().match(/^([\d.]+)\s*(in|cm|mm|px|pt)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (match[2].toLowerCase()) {
    case "in": return amount;
    case "cm": return amount / 2.54;
    case "mm": return amount / 25.4;
    case "pt": return amount / 72;
    case "px": return amount / CSS_PX_PER_INCH;
    default: return null;
  }
}

function pageSizeFromHtml(html: string): PageSize {
  const pageRule = html.match(/@page\b[^{}]*\{([\s\S]*?)\}/i)?.[1] ?? "";
  const sizeDeclaration = pageRule.match(/\bsize\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (!sizeDeclaration) return DEFAULT_PAGE_SIZE;

  const normalized = sizeDeclaration.toLowerCase().replace(/\s+/g, " ");
  const named = KNOWN_PAGE_SIZES[normalized];
  if (named) return named;

  const lengths = normalized.split(" ").map(parseLength).filter((value): value is number => value !== null);
  if (lengths.length >= 2) {
    return { widthInches: lengths[0], heightInches: lengths[1] };
  }

  return DEFAULT_PAGE_SIZE;
}

function renderSetupStyle(): string {
  return `<style id="nexuslm-export-renderer">
    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  </style>`;
}

function injectRenderSetup(html: string): string {
  const setup = renderSetupStyle();
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${setup}</head>`);
  return `${setup}${html}`;
}

async function waitForRenderedAssets(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    const images = Array.from(document.images);
    await Promise.all(images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        })));
  });
}

async function getRenderedContentHeight(page: Page): Promise<number> {
  const contentHeight = await page.evaluate(() => Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement.scrollHeight,
  ));
  if (contentHeight <= 0) throw new Error("The HTML design has no visible content.");
  if (contentHeight > MAX_RENDERED_HEIGHT_PX) {
    throw new Error("The HTML design is too tall to render safely. Split it into shorter pages.");
  }
  return contentHeight;
}

async function renderHtmlPages(html: string): Promise<RenderedHtmlPages> {
  if (!html.trim()) throw new Error("The HTML design is empty.");
  const pageSize = pageSizeFromHtml(html);
  const viewport = {
    width: Math.round(pageSize.widthInches * CSS_PX_PER_INCH),
    height: Math.round(pageSize.heightInches * CSS_PX_PER_INCH),
  };
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    executablePath,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:")
        || url.startsWith("blob:")
        || url.startsWith("about:blank")) {
        await route.continue();
        return;
      }
      await route.abort();
    });
    await page.setContent(injectRenderSetup(html), {
      timeout: RENDER_TIMEOUT_MS,
      waitUntil: "load",
    });
    await waitForRenderedAssets(page);
    const contentHeight = await getRenderedContentHeight(page);

    const pageCount = Math.max(1, Math.ceil(contentHeight / viewport.height));
    const pages: Buffer[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      await page.evaluate((offset) => window.scrollTo(0, offset), index * viewport.height);
      pages.push(await page.screenshot({ type: "png" }));
    }
    await context.close();
    return { pages, pageSize };
  } finally {
    await browser.close();
  }
}

async function renderHtmlPdf(html: string, pageSize: PageSize): Promise<Buffer> {
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    executablePath,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: {
        width: Math.round(pageSize.widthInches * CSS_PX_PER_INCH),
        height: Math.round(pageSize.heightInches * CSS_PX_PER_INCH),
      },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:blank")) {
        await route.continue();
        return;
      }
      await route.abort();
    });
    await page.setContent(injectRenderSetup(html), {
      timeout: RENDER_TIMEOUT_MS,
      waitUntil: "load",
    });
    await waitForRenderedAssets(page);
    await getRenderedContentHeight(page);
    await page.emulateMedia({ media: "screen" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    await context.close();
    return pdf;
  } finally {
    await browser.close();
  }
}

export async function renderHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const pageSize = pageSizeFromHtml(html);
  return renderHtmlPdf(html, pageSize);
}

function parseMarkdownRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*(.+?)\*\*|__(.+?)__|(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<!_)_([^_\n]+?)_(?!_))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) runs.push(new TextRun({ text: text.slice(lastIndex, match.index), size: 22 }));
    if (match[2] || match[3]) {
      runs.push(new TextRun({ text: match[2] ?? match[3], bold: true, size: 22 }));
    } else if (match[4] || match[5]) {
      runs.push(new TextRun({ text: match[4] ?? match[5], italics: true, size: 22 }));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) runs.push(new TextRun({ text: text.slice(lastIndex), size: 22 }));
  return runs.length > 0 ? runs : [new TextRun({ text, size: 22 })];
}

function createEditableHtmlParagraph(line: string): Paragraph {
  const trimmed = line.trim();
  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const headingLevels = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
      HeadingLevel.HEADING_5,
      HeadingLevel.HEADING_6,
    ];
    return new Paragraph({
      heading: headingLevels[heading[1].length - 1],
      children: parseMarkdownRuns(heading[2]),
      spacing: { before: 240, after: 120 },
    });
  }

  const quote = trimmed.match(/^(?:>\s?)+(.+)$/);
  if (quote) {
    return new Paragraph({
      children: [new TextRun({ text: quote[1], italics: true, size: 22 })],
      indent: { left: 720, right: 360 },
      spacing: { before: 120, after: 120 },
    });
  }

  const listItem = trimmed.match(/^[-*+]\s+(.+)$/);
  if (listItem) {
    return new Paragraph({
      children: [new TextRun({ text: `• ${listItem[1]}`, size: 22 })],
      indent: { left: 360, hanging: 180 },
      spacing: { after: 80 },
    });
  }

  return new Paragraph({
    children: parseMarkdownRuns(trimmed),
    alignment: AlignmentType.LEFT,
    spacing: { after: 160, line: 276 },
  });
}

export async function renderHtmlToEditableDocxBuffer(html: string): Promise<Buffer> {
  const text = htmlToNexusLMDocumentText(html);
  if (!text.trim()) throw new Error("The HTML design has no editable text content.");

  const children = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(createEditableHtmlParagraph);

  const document = new DocxDocument({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

export const renderHtmlToVisualDocxBuffer = renderHtmlToEditableDocxBuffer;
