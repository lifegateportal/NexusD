import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";
import { renderHtmlToEditableDocxBuffer } from "@/lib/nexuslm-editable-docx";
import {
  NEXUSLM_CSS_PX_PER_INCH,
  pageSizeFromHtml,
  type NexusLMPageSize,
} from "@/lib/nexuslm-page-setup";

export { renderHtmlToEditableDocxBuffer };

const MAX_RENDERED_HEIGHT_PX = 120_000;
const RENDER_TIMEOUT_MS = 30_000;

type RenderedHtmlPages = {
  pages: Buffer[];
  pageSize: NexusLMPageSize;
};

function renderSetupStyle(): string {
  return `<style id="nexuslm-export-renderer">
    *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    @media print {
      html, body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
      body > * { max-height: none !important; overflow: visible !important; }
    }
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
    width: Math.round(pageSize.widthInches * NEXUSLM_CSS_PX_PER_INCH),
    height: Math.round(pageSize.heightInches * NEXUSLM_CSS_PX_PER_INCH),
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
    await page.emulateMedia({ media: "print" });
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

async function renderHtmlPdf(html: string, pageSize: NexusLMPageSize): Promise<Buffer> {
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    executablePath,
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: {
        width: Math.round(pageSize.widthInches * NEXUSLM_CSS_PX_PER_INCH),
        height: Math.round(pageSize.heightInches * NEXUSLM_CSS_PX_PER_INCH),
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
    await page.emulateMedia({ media: "print" });
    await page.setContent(injectRenderSetup(html), {
      timeout: RENDER_TIMEOUT_MS,
      waitUntil: "load",
    });
    await waitForRenderedAssets(page);
    await getRenderedContentHeight(page);
    const pdf = await page.pdf({
      width: `${pageSize.widthInches}in`,
      height: `${pageSize.heightInches}in`,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
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
