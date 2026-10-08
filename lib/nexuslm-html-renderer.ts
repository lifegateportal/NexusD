import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";
import htmlToDocx, { type HtmlToDocxOptions } from "html-to-docx";

const CSS_PX_PER_INCH = 96;
const DEFAULT_PAGE_SIZE = { widthInches: 8.27, heightInches: 11.69 };
const DEFAULT_VIEWPORT = {
  width: Math.round(DEFAULT_PAGE_SIZE.widthInches * CSS_PX_PER_INCH),
  height: Math.round(DEFAULT_PAGE_SIZE.heightInches * CSS_PX_PER_INCH),
};
const MAX_RENDERED_HEIGHT_PX = 120_000;
const RENDER_TIMEOUT_MS = 30_000;
const DOCX_STYLE_PROPERTIES = [
  "color",
  "background-color",
  "text-align",
  "font-weight",
  "font-family",
  "font-size",
  "line-height",
  "margin-left",
  "margin-right",
  "display",
  "width",
] as const;

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
  const namedWithOrientation = normalized.match(/^(a4|letter|legal)\s+(portrait|landscape)$/);
  if (namedWithOrientation) {
    const base = KNOWN_PAGE_SIZES[namedWithOrientation[1]];
    return namedWithOrientation[2] === "landscape"
      ? { widthInches: base.heightInches, heightInches: base.widthInches }
      : base;
  }

  const lengths = normalized.split(" ").map(parseLength).filter((value): value is number => value !== null);
  if (lengths.length >= 2) {
    return { widthInches: lengths[0], heightInches: lengths[1] };
  }

  return DEFAULT_PAGE_SIZE;
}

function pageMarginsFromHtml(html: string): NonNullable<HtmlToDocxOptions["margins"]> {
  const pageRule = html.match(/@page\b[^{}]*\{([\s\S]*?)\}/i)?.[1] ?? "";
  const marginDeclaration = pageRule.match(/\bmargin\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (!marginDeclaration) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const values = marginDeclaration
    .split(/\s+/)
    .map(parseLength)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  const [top, right = top, bottom = top, left = right] = values.length === 1
    ? [values[0], values[0], values[0], values[0]]
    : values.length === 2
      ? [values[0], values[1], values[0], values[1]]
      : values.length === 3
        ? [values[0], values[1], values[2], values[1]]
        : values;
  const toTwips = (inches: number) => Math.round(inches * 1440);
  return {
    top: toTwips(top),
    right: toTwips(right),
    bottom: toTwips(bottom),
    left: toTwips(left),
  };
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

async function inlineComputedStyles(html: string): Promise<string> {
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    executablePath,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
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
    const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    await page.setContent(injectRenderSetup(safeHtml), {
      timeout: RENDER_TIMEOUT_MS,
      waitUntil: "load",
    });
    await waitForRenderedAssets(page);
    const inlinedHtml = await page.evaluate((styleProperties) => {
      const elements = Array.from(document.body?.querySelectorAll<HTMLElement>("*") ?? []);
      for (const element of elements) {
        const computed = window.getComputedStyle(element);
        const declarations = styleProperties
          .map((property) => {
            const value = computed.getPropertyValue(property).trim();
            if (!value || value === "transparent" || /^rgba\([^)]*,\s*0\)$/i.test(value)) return "";
            return `${property}:${value}`;
          })
          .filter(Boolean);
        if (declarations.length === 0) continue;
        const existing = element.getAttribute("style")?.trim() ?? "";
        element.setAttribute("style", `${existing}${existing && !existing.endsWith(";") ? ";" : ""}${declarations.join(";")}`);
      }
      return document.documentElement?.outerHTML ?? document.body?.outerHTML ?? "";
    }, DOCX_STYLE_PROPERTIES);
    await context.close();
    if (!inlinedHtml.trim()) throw new Error("The HTML design has no editable document content.");
    return inlinedHtml;
  } finally {
    await browser.close();
  }
}

export async function renderHtmlToEditableDocxBuffer(html: string): Promise<Buffer> {
  if (!html.trim()) throw new Error("The HTML design is empty.");
  if (!/<(?:body|main|article|section|p|h[1-6]|div)\b/i.test(html)) {
    throw new Error("The HTML design has no editable document content.");
  }

  const pageSize = pageSizeFromHtml(html);
  const editableHtml = await inlineComputedStyles(html);
  return htmlToDocx(editableHtml, null, {
    title: "NexusLM document",
    creator: "NexusLM",
    description: "Editable document exported from a NexusLM HTML design.",
    pageSize: {
      width: Math.round(pageSize.widthInches * 1440),
      height: Math.round(pageSize.heightInches * 1440),
    },
    margins: pageMarginsFromHtml(html),
    table: { row: { cantSplit: true } },
  });
}
